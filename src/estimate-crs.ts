/**
 * CRS 推定オーケストレーション（m1-t1 設計 §4〜§6）。
 *
 * 候補ごとに `transformer -> @c4h/daedalus.fitWorldFile -> basic score` を評価し、
 * 決定的な順位と選択結果を返す。
 *
 * 【公開境界】
 * `package.json` の `exports` は `"."` のみで、`src/index.ts` は `estimateCrs` だけを公開する。
 * 本ファイルが export する内部 helper は**公開 API ではない**。現行公開 API から到達不能な
 * 分岐（score null-last、`status:'ok'`）を単体検証するため、tests だけが `../src/` から
 * 直接 import する（設計 K14 / 設計レビュー INF-5 の承認済み手法）。
 */
import { fitWorldFile } from '@c4h/daedalus';
import type { FitResult, FitStatus, FitWarning, GcpPair, GeoBasis, QualityGate, WorldFile } from '@c4h/daedalus';

import type {
  CandidateCrs,
  CandidateFailure,
  CandidateFailureKind,
  CandidateTransformer,
  EstimateOptions,
  EstimationFailure,
  EstimationResult,
  LinearUnit,
} from './types.js';

/** 仕様正本 v0.3 の既定 epsilon（m）。Daedalus の gate と揃える。 */
const DEFAULT_NORMALIZE_EPSILON_METERS = 100;
/** 1 度あたりの概算メートル（Daedalus `similarity.ts` の L_geo 近似と同じ定数）。 */
const METRES_PER_DEGREE = 111320;
/** 国際フィート -> メートル。 */
const METRES_PER_FOOT = 0.3048;
/** score 同着の許容係数（設計 K11。機械精度由来の許容だけに限定する）。 */
const TIE_EPSILON_FACTOR = 64;
/** transformer の呼び出し 1 回の既定の上限（ms）。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 失敗の message の上限（文字）。 */
const FAILURE_MESSAGE_MAX_LENGTH = 500;

/**
 * Daedalus へ渡す basis は常にこれ（設計 K7）。
 * transformer の成功出力は metre に換算した projected `[easting, northing]` として当てはめる
 * （`{ points, unit }` は `metresPerUnit` 倍して metre に直す）。
 * 入力側 `geoBasis` をそのまま Daedalus へ渡してはならない。
 */
const DAEDALUS_TARGET_BASIS: GeoBasis = { kind: 'planar_xy', axisOrder: 'xy', unit: 'm' };

/** 入力 `geoBasis` の既定（設計 §4 契約(2)）。 */
const DEFAULT_SOURCE_BASIS: GeoBasis = { kind: 'lonlat_deg', axisOrder: 'lon-lat' };

/**
 * candidate 単位の失敗分類（設計 §4.2）。公開しない内部語彙である。
 * `adapter-contract-failure` / `adapter-bug` / `dependency-contract-failure` が
 * 「実装失敗」であり、1 件でもあれば top-level を `failed` にする（公開の `CandidateFailureKind`
 * はこの 3 つに打ち切り `adapter-timeout` を足したもの）。
 */
export type CandidateFailureClass =
  | 'business-untransformable'
  | 'adapter-contract-failure'
  | 'adapter-bug'
  | 'candidate-input-failure'
  | 'fit-insufficient'
  | 'dependency-contract-failure'
  | 'adapter-timeout';

const IMPLEMENTATION_FAILURE_CLASSES: ReadonlySet<CandidateFailureClass> = new Set([
  'adapter-contract-failure',
  'adapter-bug',
  'dependency-contract-failure',
]);

/** ranking の入力となる最小構造（設計 §5.4）。 */
export interface RankableCandidate {
  authority: string;
  code: string;
  score: number | null;
  datumFamily?: string;
}

/** 正の整数だけを受理し、それ以外（非有限・0 以下・非整数・undefined）は既定へ落とす。 */
export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/** `setTimeout` が受けられる遅延の上限（2^31 − 1 ms）。越えると 1 ms へ置き換えられる。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 正の有限値と `Infinity` だけを受理し、それ以外（0 以下・非数・undefined）は既定 120000 ms へ落とす。
 * `setTimeout` の上限を越える値は、即座の打ち切りにならないよう `Infinity`（打ち切りなし）として扱う。
 * 内部 helper の一覧（tests/package-shape.test.ts）を増やさないため export しない。
 */
function normalizeTimeoutMs(value: number | undefined): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  if (value > MAX_TIMER_DELAY_MS) return Number.POSITIVE_INFINITY;
  return value;
}

/** 有限かつ 0 より大きい値だけを受理し、それ以外は既定 100 m へ落とす（設計 K8）。 */
export function normalizeEpsilonMeters(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_NORMALIZE_EPSILON_METERS;
  }
  return value;
}

/**
 * 入力 GCP 全体に共通する観測域スケール `L_geo`（m）を算出する（設計 §5.3）。
 * 空入力・非有限座標では `NaN` を返す（候補共通の score 分母が成立しない）。
 */
export function computeObservationScale(
  gcps: readonly GcpPair[],
  geoBasis: GeoBasis,
): number {
  if (gcps.length === 0) return Number.NaN;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const { geo } of gcps) {
    const [x, y] = geo;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.NaN;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (geoBasis.kind === 'lonlat_deg') {
    // 狭域における local ENU の一次近似（bbox 中心緯度を使う）
    const latCenter = (minY + maxY) / 2;
    const dx = (maxX - minX) * METRES_PER_DEGREE * Math.cos((latCenter * Math.PI) / 180);
    const dy = (maxY - minY) * METRES_PER_DEGREE;
    return Math.hypot(dx, dy);
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  return geoBasis.unit === 'ft' ? diagonal * METRES_PER_FOOT : diagonal;
}

/**
 * shear 前 basic RMS を Daedalus の返却から一意に取り出す（設計 §5.2）。
 *
 * - `debug.sseSimilarity` が有限なら `sqrt(sseSimilarity / n)`。
 * - 無く、かつ `similarityOnly === true` なら選択モデル自体が basic ∴ `rmsMeters`。
 * - `similarityOnly === false` なのに有限な `sseSimilarity` が無ければ Daedalus 公開契約との
 *   不整合（dependency-contract-failure）∴ `null`。final affine RMS を代用しない。
 */
export function basicRmsFromFit(fit: FitResult, n: number): number | null {
  const sseSimilarity = fit.debug?.sseSimilarity;
  if (typeof sseSimilarity === 'number' && Number.isFinite(sseSimilarity) && n > 0) {
    return Math.sqrt(sseSimilarity / n);
  }
  if (fit.similarityOnly && typeof fit.rmsMeters === 'number' && Number.isFinite(fit.rmsMeters)) {
    return fit.rmsMeters;
  }
  return null;
}

/** score の同着判定（設計 K11。機械精度由来の許容だけ）。 */
export function areScoresTied(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_EPSILON_FACTOR * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/** locale 非依存の code-unit 順比較。 */
function compareIdentity(a: RankableCandidate, b: RankableCandidate): number {
  const idA = `${a.authority}:${a.code}`;
  const idB = `${b.authority}:${b.code}`;
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
}

/** prior 内の index。未指定・値なし・一覧外はすべて同順位（最後尾）とする。 */
function priorIndex(candidate: RankableCandidate, prior: readonly string[] | undefined): number {
  if (prior === undefined || candidate.datumFamily === undefined) return Number.MAX_SAFE_INTEGER;
  const index = prior.indexOf(candidate.datumFamily);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function comparePriorThenIdentity(
  a: RankableCandidate,
  b: RankableCandidate,
  prior: readonly string[] | undefined,
): number {
  const diff = priorIndex(a, prior) - priorIndex(b, prior);
  if (diff !== 0) return diff;
  return compareIdentity(a, b);
}

/**
 * 決定的 ranking（設計 §5.4 / K16）。
 *
 * 1. finite score を数値の厳密昇順、同値なら identity の code-unit 順で整列する（厳密な全順序）。
 *    null score は finite の後へ分離し identity 順で整列する。
 * 2. 整列済み finite 列を先頭から走査し、隣接 score が `areScoresTied` なら同じ同着 group とする。
 *    一方向の走査なので入力順に依存しない一意な分割になる。
 * 3. 各 group 内だけを prior -> identity で再整列する。
 * 4. null 群も prior -> identity で閉じ、finite group の後に置く。
 *
 * epsilon 同着を二項 comparator へ直接入れると許容関係が推移せず sort の前提（厳密な弱順序）を
 * 破るため、この構成で決定性を作る。
 */
export function rankCandidates<T extends RankableCandidate>(
  entries: readonly T[],
  prior?: readonly string[],
): T[] {
  const finite = entries.filter((entry): entry is T => entry.score !== null);
  const nulls = entries.filter((entry) => entry.score === null);

  // 1. 厳密な全順序
  const sorted = [...finite].sort((a, b) => {
    const scoreA = a.score as number;
    const scoreB = b.score as number;
    if (scoreA < scoreB) return -1;
    if (scoreA > scoreB) return 1;
    return compareIdentity(a, b);
  });

  // 2. 隣接 epsilon group 化
  const groups: T[][] = [];
  for (const entry of sorted) {
    const currentGroup = groups[groups.length - 1];
    if (
      currentGroup !== undefined &&
      areScoresTied(currentGroup[currentGroup.length - 1].score as number, entry.score as number)
    ) {
      currentGroup.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  // 3. group 内だけ prior -> identity
  const ranked: T[] = [];
  for (const group of groups) {
    ranked.push(...[...group].sort((a, b) => comparePriorThenIdentity(a, b, prior)));
  }

  // 4. null 群は最後（null-last）
  ranked.push(...[...nulls].sort((a, b) => comparePriorThenIdentity(a, b, prior)));
  return ranked;
}

/**
 * 成功時の status 導出。
 *
 * 実 Daedalus の成功 fit は、holdout を渡して affine が採用されたとき（Daedalus の行 8）だけ
 * warning が 0 件になる ∴ 公開 API で `'ok'` になるのはその場合だけで、それ以外は
 * `'ok_with_warnings'` である。
 */
export function deriveSuccessStatus(
  warnings: readonly FitWarning[],
): Extract<FitStatus, 'ok' | 'ok_with_warnings'> {
  return warnings.length === 0 ? 'ok' : 'ok_with_warnings';
}

/**
 * top-level status 導出。上から評価し、最初に当たった行で決まる。
 *
 * 1. 打ち切り（`adapter-timeout`）が起きた → `failed`
 * 2. 実装失敗が 1 件以上 → `failed`（usable が残っていても。その候補が真値だったか判断できない）
 * 3. usable ≥ `minCandidates` → `ok` / `ok_with_warnings`
 * 4. それ以外 → `insufficient`
 */
export function deriveTopLevelStatus(input: {
  usableCount: number;
  minCandidates: number;
  hasImplementationFailure: boolean;
  hasTimeout: boolean;
  selectedWarnings: readonly FitWarning[];
}): FitStatus {
  if (input.hasTimeout) return 'failed';
  if (input.hasImplementationFailure) return 'failed';
  if (input.usableCount >= input.minCandidates) {
    return deriveSuccessStatus(input.selectedWarnings);
  }
  return 'insufficient';
}

/**
 * 変換出力が契約 (3)(5) を満たす点列でない理由。満たすなら `null`。
 * 理由は `adapter-contract-failure` の message になる。
 */
function describePointListViolation(value: unknown, expectedLength: number): string | null {
  if (!Array.isArray(value)) return 'not an array';
  if (value.length !== expectedLength) return `expected ${expectedLength} points, got ${value.length}`;
  for (let index = 0; index < value.length; index++) {
    const point: unknown = value[index];
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      return `point ${index} is not a pair of finite numbers`;
    }
  }
  return null;
}

/**
 * 成功出力を metre の点列へ正規化する。
 *
 * - plain な配列は従来どおり metre の `[easting, northing]`（単位は `{ name: 'metre', metresPerUnit: 1 }`）。
 * - `{ points, unit }` は `unit` を検査し（`name` が空でない文字列・`metresPerUnit` が正の有限値）、
 *   `points` を `metresPerUnit` 倍して metre に直す。GCP と holdout は同じ倍率で換算される。
 *
 * 契約違反なら `adapter-contract-failure` の message になる理由を返す。
 */
function normalizeSuccessOutput(
  value: unknown,
  expectedLength: number,
): { points: Array<[number, number]>; unit: LinearUnit } | { violation: string } {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'points' in value) {
    const candidate = value as { points: unknown; unit: unknown };
    const unit = candidate.unit;
    if (!isLinearUnit(unit)) return { violation: 'invalid unit' };
    const violation = describePointListViolation(candidate.points, expectedLength);
    if (violation !== null) return { violation };
    const scale = unit.metresPerUnit;
    return {
      points: (candidate.points as Array<[number, number]>).map(([easting, northing]): [number, number] => [
        easting * scale,
        northing * scale,
      ]),
      unit: { name: unit.name, metresPerUnit: scale },
    };
  }
  const violation = describePointListViolation(value, expectedLength);
  if (violation !== null) return { violation };
  return { points: value as Array<[number, number]>, unit: { name: 'metre', metresPerUnit: 1 } };
}

/** `LinearUnit` の契約（空でない `name`・正の有限の `metresPerUnit`）を満たすか。 */
function isLinearUnit(value: unknown): value is LinearUnit {
  if (typeof value !== 'object' || value === null) return false;
  const unit = value as { name?: unknown; metresPerUnit?: unknown };
  return (
    typeof unit.name === 'string' &&
    unit.name.length > 0 &&
    typeof unit.metresPerUnit === 'number' &&
    Number.isFinite(unit.metresPerUnit) &&
    unit.metresPerUnit > 0
  );
}

/**
 * worldFile の 6 値をすべて `metresPerUnit` で割る。Daedalus の worldFile は pixel → metre の
 * 写像であり、線形なので 6 値とも同じ倍率で pixel → 候補の単位の写像に直せる。
 */
function toCandidateUnits(worldFile: WorldFile, metresPerUnit: number): WorldFile {
  return {
    xScale: worldFile.xScale / metresPerUnit,
    xSkew: worldFile.xSkew / metresPerUnit,
    xOrigin: worldFile.xOrigin / metresPerUnit,
    ySkew: worldFile.ySkew / metresPerUnit,
    yScale: worldFile.yScale / metresPerUnit,
    yOrigin: worldFile.yOrigin / metresPerUnit,
  };
}

/** throw / reject された値を message にする（500 文字で切る）。 */
function messageOf(error: unknown): string {
  return truncateMessage(error instanceof Error ? error.message : String(error));
}

function truncateMessage(message: string): string {
  return message.length > FAILURE_MESSAGE_MAX_LENGTH ? message.slice(0, FAILURE_MESSAGE_MAX_LENGTH) : message;
}

/** 中止の理由（`signal.reason` が無ければ `AbortError` の `DOMException`）。 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** transformer の呼び出し 1 回の帰結。中止は reject で伝える。 */
type TransformerOutcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'thrown'; error: unknown }
  | { kind: 'timeout' };

/**
 * transformer を 1 回呼び、`timeoutMs` のタイマーと `signal` の abort と競わせる。
 *
 * 負けた呼び出しの promise は取り消せないので捨てる（後から解決・reject しても結果に影響しない）。
 * タイマーと abort の listener は必ず外す。
 */
async function invokeTransformer(
  transformer: CandidateTransformer,
  args: Parameters<CandidateTransformer>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<TransformerOutcome> {
  let call: Promise<unknown>;
  try {
    call = Promise.resolve(transformer(...args));
  } catch (error) {
    return { kind: 'thrown', error };
  }
  // 同期の transformer の中で中止された場合も、次へ進まずに reject する。
  // 捨てる promise が後で reject しても未処理にならないよう、先に handler を付けておく
  if (signal?.aborted) {
    call.catch(() => {});
    throw abortReason(signal);
  }

  const contenders: Array<Promise<TransformerOutcome>> = [
    call.then(
      (value): TransformerOutcome => ({ kind: 'value', value }),
      (error: unknown): TransformerOutcome => ({ kind: 'thrown', error }),
    ),
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(timeoutMs)) {
    contenders.push(
      new Promise<TransformerOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    );
  }
  let onAbort: (() => void) | undefined;
  if (signal !== undefined) {
    contenders.push(
      new Promise<TransformerOutcome>((_resolve, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(contenders);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

interface UsableCandidate extends RankableCandidate {
  basicRmsMeters: number;
  fit: FitResult;
  /** その候補の座標の単位（`fit.worldFile` は metre の写像）。 */
  unit: LinearUnit;
}

/** 1 回の `fitWorldFile` の評価結果（候補ループの内部表現）。 */
type FitEvaluation =
  | { kind: 'usable'; fit: FitResult; basicRmsMeters: number }
  | { kind: 'fit-insufficient' | 'dependency-contract-failure'; fit: FitResult };

/** Daedalus で fit し、ranking に使えるか・失敗の分類を決める。 */
function evaluateFit(
  gcps: readonly GcpPair[],
  holdout: readonly GcpPair[],
  epsilonMeters: number,
): FitEvaluation {
  const fit = fitWorldFile(gcps, {
    geoBasis: DAEDALUS_TARGET_BASIS,
    normalizeEpsilonMeters: epsilonMeters,
    debug: true,
    ...(holdout.length > 0 ? { holdout } : {}),
  });

  const succeeded = fit.status === 'ok' || fit.status === 'ok_with_warnings';
  if (!succeeded || fit.qualityGate === 'unusable') {
    // Daedalus が正当に不足と判断した候補（ranked へ入れない。untransformableIds へも入れない）
    return { kind: 'fit-insufficient', fit };
  }
  if (fit.worldFile === null || fit.rmsMeters === null || !Number.isFinite(fit.rmsMeters)) {
    return { kind: 'dependency-contract-failure', fit };
  }
  const basicRmsMeters = basicRmsFromFit(fit, gcps.length);
  if (basicRmsMeters === null || !Number.isFinite(basicRmsMeters)) {
    return { kind: 'dependency-contract-failure', fit };
  }
  return { kind: 'usable', fit, basicRmsMeters };
}

/**
 * pixel の v を反転した側（flip）を採るか。
 *
 * - 片方だけ使えるなら使える側を採る。両方使えなければ direct（今までの失敗の分類のまま）。
 * - 両方使えるなら basic SSE（`basicRms² · n`）の小さい側を採る。差が機械精度の内
 *   （`|SSE_direct − SSE_flip| <= 1024 · ε² · Σ(X² + Y²)`。和は変換後の geo 座標）なら direct を採る。
 */
function prefersFlip(
  direct: FitEvaluation,
  flip: FitEvaluation,
  geo: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (flip.kind !== 'usable') return false;
  if (direct.kind !== 'usable') return true;

  const n = geo.length;
  const sseDirect = direct.basicRmsMeters * direct.basicRmsMeters * n;
  const sseFlip = flip.basicRmsMeters * flip.basicRmsMeters * n;
  let sumSquares = 0;
  for (const [x, y] of geo) sumSquares += x * x + y * y;
  const tolerance = 1024 * Number.EPSILON * Number.EPSILON * sumSquares;
  if (Math.abs(sseDirect - sseFlip) <= tolerance) return false;
  return sseFlip < sseDirect;
}

/**
 * flip 側の fit を元の pixel 座標系へ戻す。`(u, −v)` への写像を `(u, v)` からの写像に直すと
 * `xSkew` と `yScale` の符号だけが反転する（他の 4 値・RMS・gate・warnings は不変）。
 * `0 - x` は 0 を -0 にしない。
 */
function unflipFit(evaluation: FitEvaluation): FitEvaluation {
  const worldFile = evaluation.fit.worldFile;
  if (worldFile === null) return evaluation;
  const fit: FitResult = {
    ...evaluation.fit,
    worldFile: { ...worldFile, xSkew: 0 - worldFile.xSkew, yScale: 0 - worldFile.yScale },
  };
  return { ...evaluation, fit };
}

const EMPTY_RESULT_SHAPE = {
  status: 'insufficient' as const,
  selected: null,
  ranked: [] as EstimationResult['ranked'],
  warnings: [] as readonly FitWarning[],
  untransformableIds: [] as string[],
  failure: null,
};

/**
 * GCP・候補 CRS・変換 adapter から、決定的な順位と選択結果を返す。
 *
 * 候補は**入力順に逐次**処理し、各返却を `await Promise.resolve(...)` で正規化する（設計 K2）。
 * 逐次処理により failure / warning の順序と adapter 呼出し順が決定的になる。
 *
 * `options.signal` で中止されたら `signal.reason`（無ければ `AbortError`）で reject する。
 * それ以外の失敗は reject ではなく `status: 'failed'` と `failure` で返す。
 */
export async function estimateCrs(
  gcps: readonly GcpPair[],
  candidates: readonly CandidateCrs[],
  options: EstimateOptions,
): Promise<EstimationResult> {
  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);

  const sourceBasis = options.geoBasis ?? DEFAULT_SOURCE_BASIS;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const epsilonMeters = normalizeEpsilonMeters(options.normalizeEpsilonMeters);
  const minCandidates = normalizePositiveInteger(options.minCandidates, 1);
  const isEmptyInput = gcps.length === 0;
  const chirality = options.chirality === 'direct-only' ? 'direct-only' : 'normalize';

  // 非空 L_geo gate（設計 K15）。候補共通の score 分母が成立しない時点で候補 loop を開始しない。
  // 未呼出しの候補を「変換不能」と記録してはならない ∴ untransformableIds も空で返す。
  // 空入力だけは 8 項目契約 (4) の機械検証のため候補ごとに transformer を呼ぶ（下の loop へ進む）。
  const observationScale = computeObservationScale(gcps, sourceBasis);
  if (!isEmptyInput && (!Number.isFinite(observationScale) || observationScale < epsilonMeters)) {
    return { ...EMPTY_RESULT_SHAPE, ranked: [], warnings: [], untransformableIds: [] };
  }

  // holdout は GCP とつないで 1 回で変換する（transformer の呼び出しを増やさない）。
  // 空入力の経路（契約 (4) の検証）では holdout をつながない。
  const holdout: readonly GcpPair[] = isEmptyInput ? [] : (options.holdout ?? []);
  const geoPoints: ReadonlyArray<readonly [number, number]> = [
    ...gcps.map((gcp) => gcp.geo),
    ...holdout.map((pair) => pair.geo),
  ];

  const untransformableIds: string[] = [];
  const untransformableIdSet = new Set<string>();
  const seenIds = new Set<string>();
  const failures: CandidateFailure[] = [];
  const fitReachedWarnings: FitWarning[] = [];
  const usable: UsableCandidate[] = [];
  let timedOut = false;

  const markUntransformable = (id: string): void => {
    if (untransformableIdSet.has(id)) return;
    untransformableIdSet.add(id);
    untransformableIds.push(id);
  };
  const recordFailure = (id: string, failureClass: CandidateFailureClass, message?: string): void => {
    if (IMPLEMENTATION_FAILURE_CLASSES.has(failureClass) || failureClass === 'adapter-timeout') {
      failures.push({ id, kind: failureClass as CandidateFailureKind, message: truncateMessage(message ?? '') });
    }
    markUntransformable(id);
  };

  for (const candidate of candidates) {
    if (signal?.aborted) throw abortReason(signal);
    const id = `${candidate.authority}:${candidate.code}`;

    // identity 重複は最初の 1 件だけ評価する（設計 K6。failure として同じ id を
    // untransformableIds へ入れると採用済み同一 id と交差するため、2 件目以降は無視する）
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // identity 空文字は transformer を呼ばず candidate-input-failure
    if (candidate.authority === '' || candidate.code === '') {
      recordFailure(id, 'candidate-input-failure');
      continue;
    }

    const outcome = await invokeTransformer(options.transformer, [id, geoPoints, sourceBasis], timeoutMs, signal);
    if (outcome.kind === 'timeout') {
      // その場で推定を止める（止まった呼び出しが資源を握っていると、残りも上限まで待つことになる）
      recordFailure(id, 'adapter-timeout', `no answer within ${timeoutMs} ms`);
      timedOut = true;
      break;
    }
    if (outcome.kind === 'thrown') {
      // throw / reject は adapter bug（設計 §4.2）
      recordFailure(id, 'adapter-bug', messageOf(outcome.error));
      continue;
    }
    const transformed = outcome.value;

    if (transformed === null) {
      // 業務的変換不能（空入力の契約 (4) を含む）
      recordFailure(id, 'business-untransformable');
      continue;
    }

    if (isEmptyInput) {
      // 空入力には null を返す契約 (4)。`[]` を含む配列は契約違反
      recordFailure(id, 'adapter-contract-failure', 'empty input must give null');
      continue;
    }

    // plain な配列は metre、`{ points, unit }` は metre へ換算してから当てはめる
    const normalized = normalizeSuccessOutput(transformed, geoPoints.length);
    if ('violation' in normalized) {
      // 非配列・不正な unit・長さ不一致・非有限出力は adapter contract failure
      recordFailure(id, 'adapter-contract-failure', normalized.violation);
      continue;
    }
    const { points, unit } = normalized;
    const gcpPoints = points.slice(0, gcps.length);

    const transformedGcps: GcpPair[] = gcps.map((gcp, index) => ({
      pixel: gcp.pixel,
      geo: points[index],
    }));
    const transformedHoldout: GcpPair[] = holdout.map((pair, index) => ({
      pixel: pair.pixel,
      geo: points[gcps.length + index],
    }));

    const direct = evaluateFit(transformedGcps, transformedHoldout, epsilonMeters);
    let chosen = direct;
    if (chirality === 'normalize') {
      // 反射の吸収: pixel の v を反転した入力も当てる（geo 側は同じ。transformer は呼び直さない）。
      // holdout の pixel も同じく反転する
      const flipPixel = (pair: GcpPair): GcpPair => ({ pixel: [pair.pixel[0], -pair.pixel[1]], geo: pair.geo });
      const flip = evaluateFit(transformedGcps.map(flipPixel), transformedHoldout.map(flipPixel), epsilonMeters);
      if (prefersFlip(direct, flip, gcpPoints)) chosen = unflipFit(flip);
    }

    // 採らなかった側の warning は外へ出さない
    fitReachedWarnings.push(...chosen.fit.warnings);

    if (chosen.kind === 'dependency-contract-failure') {
      // Daedalus の返却が公開契約と食い違う（untransformableIds へは入れない。変換はできている）
      failures.push({
        id,
        kind: 'dependency-contract-failure',
        message: 'the fit result violates the public contract of @c4h/daedalus',
      });
      continue;
    }
    if (chosen.kind !== 'usable') {
      continue;
    }
    const { fit, basicRmsMeters } = chosen;

    const score =
      Number.isFinite(observationScale) && observationScale > 0
        ? basicRmsMeters / observationScale
        : null;

    usable.push({
      authority: candidate.authority,
      code: candidate.code,
      score,
      basicRmsMeters,
      fit,
      unit,
      ...(candidate.datumFamily === undefined ? {} : { datumFamily: candidate.datumFamily }),
    });
  }

  const rankedAll = rankCandidates(usable, options.datumFamilyPrior);
  // topK は ranked の切り詰めだけに効く。minCandidates 判定は切り詰め前の usable 全件で行う。
  const topK = normalizePositiveInteger(options.topK, usable.length);
  const ranked = rankedAll.slice(0, topK).map((entry) => ({
    authority: entry.authority,
    code: entry.code,
    score: entry.score,
    rmsMeters: entry.basicRmsMeters,
    unit: entry.unit,
  }));

  const hasTimeout = timedOut;
  const hasImplementationFailure = failures.some((entry) => entry.kind !== 'adapter-timeout');
  const failure: EstimationFailure | null =
    hasTimeout || hasImplementationFailure
      ? { reason: hasTimeout ? 'timeout' : 'implementation-failure', candidates: failures }
      : null;

  const head = failure === null && usable.length >= minCandidates ? rankedAll[0] : undefined;
  if (head === undefined) {
    return {
      status: deriveTopLevelStatus({
        usableCount: usable.length,
        minCandidates,
        hasImplementationFailure,
        hasTimeout,
        selectedWarnings: [],
      }),
      selected: null,
      // failed のときは評価できた候補だけの不完全な順位（診断。選択に使ってはならない）
      ranked,
      // selected が無い場合は fit に到達した候補の warning を入力順で返す
      // （{code,detail} 完全一致の重複だけ除く）
      warnings: dedupeWarnings(fitReachedWarnings),
      untransformableIds,
      failure,
    };
  }

  // 成功時 warnings は selected 候補の Daedalus FitWarning だけを同順・同形で返す（設計 K9）
  const warnings = head.fit.warnings;

  return {
    status: deriveTopLevelStatus({
      usableCount: usable.length,
      minCandidates,
      hasImplementationFailure,
      hasTimeout,
      selectedWarnings: warnings,
    }),
    selected: {
      identity: { authority: head.authority, code: head.code },
      // selected.worldFile / qualityGate は同じ候補に対する Daedalus の最終返却である（設計 K10）
      // worldFile は pixel → その候補の単位の写像に直す（metre の候補は 1 で割るだけ）
      worldFile: toCandidateUnits(
        head.fit.worldFile as NonNullable<FitResult['worldFile']>,
        head.unit.metresPerUnit,
      ),
      unit: head.unit,
      score: head.score,
      // selected.rmsMeters は ranking に用いた shear 前 basic RMS である（設計 K10）
      rmsMeters: head.basicRmsMeters,
      qualityGate: head.fit.qualityGate as Exclude<QualityGate, 'unusable'>,
    },
    ranked,
    warnings,
    untransformableIds,
    failure: null,
  };
}

/** `{code, detail}` 完全一致の重複だけを除く（順序は保つ）。 */
function dedupeWarnings(warnings: readonly FitWarning[]): FitWarning[] {
  const seen = new Set<string>();
  const result: FitWarning[] = [];
  for (const warning of warnings) {
    const key = JSON.stringify([warning.code, warning.detail ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}
