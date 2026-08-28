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
import type { FitResult, FitStatus, FitWarning, GcpPair, GeoBasis, QualityGate } from '@c4h/daedalus';

import type { CandidateCrs, EstimateOptions, EstimationResult } from './types.js';

/** 仕様正本 v0.3 の既定 epsilon（m）。Daedalus の gate と揃える。 */
const DEFAULT_NORMALIZE_EPSILON_METERS = 100;
/** 1 度あたりの概算メートル（Daedalus `similarity.ts` の L_geo 近似と同じ定数）。 */
const METRES_PER_DEGREE = 111320;
/** 国際フィート -> メートル。 */
const METRES_PER_FOOT = 0.3048;
/** score 同着の許容係数（設計 K11。機械精度由来の許容だけに限定する）。 */
const TIE_EPSILON_FACTOR = 64;

/**
 * Daedalus へ渡す basis は常にこれ（設計 K7）。
 * transformer の成功出力は Cycle 1 では metre の projected `[easting, northing]` と解釈する。
 * 入力側 `geoBasis` をそのまま Daedalus へ渡してはならない。
 */
const DAEDALUS_TARGET_BASIS: GeoBasis = { kind: 'planar_xy', axisOrder: 'xy', unit: 'm' };

/** 入力 `geoBasis` の既定（設計 §4 契約(2)）。 */
const DEFAULT_SOURCE_BASIS: GeoBasis = { kind: 'lonlat_deg', axisOrder: 'lon-lat' };

/**
 * candidate 単位の失敗分類（設計 §4.2）。公開しない内部語彙である。
 * `adapter-contract-failure` / `adapter-bug` / `dependency-contract-failure` が
 * 「実装失敗」であり、usable 0 件のとき top-level を `failed` にする（設計 K9 / §5.6）。
 */
export type CandidateFailureClass =
  | 'business-untransformable'
  | 'adapter-contract-failure'
  | 'adapter-bug'
  | 'candidate-input-failure'
  | 'fit-insufficient'
  | 'dependency-contract-failure';

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
 * 成功時の status 導出（設計 §5.6 の行 1・2。K14）。
 *
 * 現行の Teiresias `EstimateOptions` は Daedalus の `FitOptions.holdout` を公開せず、実 Daedalus の
 * 成功 fit は必ず warning を 1 件以上持つ ∴ 公開 API から `'ok'` は到達不能である。
 * `FitStatus` 互換と将来の holdout 対応のため分岐を保持し、合成 warning 配列で単体検証する。
 */
export function deriveSuccessStatus(
  warnings: readonly FitWarning[],
): Extract<FitStatus, 'ok' | 'ok_with_warnings'> {
  return warnings.length === 0 ? 'ok' : 'ok_with_warnings';
}

/** top-level status 導出（設計 §5.6 の 4 行全数）。重なりでは `failed` を優先する。 */
export function deriveTopLevelStatus(input: {
  usableCount: number;
  minCandidates: number;
  hasImplementationFailure: boolean;
  selectedWarnings: readonly FitWarning[];
}): FitStatus {
  if (input.usableCount >= input.minCandidates) {
    return deriveSuccessStatus(input.selectedWarnings);
  }
  if (input.usableCount === 0 && input.hasImplementationFailure) {
    return 'failed';
  }
  return 'insufficient';
}

/** 変換出力が契約 (3)(5) を満たす点列であるか。 */
function isConformingPointList(value: unknown, expectedLength: number): value is Array<[number, number]> {
  if (!Array.isArray(value)) return false;
  if (value.length !== expectedLength) return false;
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return false;
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  }
  return true;
}

interface UsableCandidate extends RankableCandidate {
  basicRmsMeters: number;
  fit: FitResult;
}

const EMPTY_RESULT_SHAPE = {
  status: 'insufficient' as const,
  selected: null,
  ranked: [] as EstimationResult['ranked'],
  warnings: [] as readonly FitWarning[],
  untransformableIds: [] as string[],
};

/**
 * GCP・候補 CRS・変換 adapter から、決定的な順位と選択結果を返す。
 *
 * 候補は**入力順に逐次**処理し、各返却を `await Promise.resolve(...)` で正規化する（設計 K2）。
 * 逐次処理により failure / warning の順序と adapter 呼出し順が決定的になる。
 */
export async function estimateCrs(
  gcps: readonly GcpPair[],
  candidates: readonly CandidateCrs[],
  options: EstimateOptions,
): Promise<EstimationResult> {
  const sourceBasis = options.geoBasis ?? DEFAULT_SOURCE_BASIS;
  const epsilonMeters = normalizeEpsilonMeters(options.normalizeEpsilonMeters);
  const minCandidates = normalizePositiveInteger(options.minCandidates, 1);
  const isEmptyInput = gcps.length === 0;

  // 非空 L_geo gate（設計 K15）。候補共通の score 分母が成立しない時点で候補 loop を開始しない。
  // 未呼出しの候補を「変換不能」と記録してはならない ∴ untransformableIds も空で返す。
  // 空入力だけは 8 項目契約 (4) の機械検証のため候補ごとに transformer を呼ぶ（下の loop へ進む）。
  const observationScale = computeObservationScale(gcps, sourceBasis);
  if (!isEmptyInput && (!Number.isFinite(observationScale) || observationScale < epsilonMeters)) {
    return { ...EMPTY_RESULT_SHAPE, ranked: [], warnings: [], untransformableIds: [] };
  }

  const geoPoints: ReadonlyArray<readonly [number, number]> = gcps.map((gcp) => gcp.geo);

  const untransformableIds: string[] = [];
  const seenIds = new Set<string>();
  const failureClasses: CandidateFailureClass[] = [];
  const fitReachedWarnings: FitWarning[] = [];
  const usable: UsableCandidate[] = [];

  const recordFailure = (id: string, failureClass: CandidateFailureClass): void => {
    failureClasses.push(failureClass);
    if (!untransformableIds.includes(id)) untransformableIds.push(id);
  };

  for (const candidate of candidates) {
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

    let transformed: Array<[number, number]> | null;
    try {
      transformed = await Promise.resolve(options.transformer(id, geoPoints, sourceBasis));
    } catch {
      // throw / reject は adapter bug（設計 §4.2）
      recordFailure(id, 'adapter-bug');
      continue;
    }

    if (transformed === null) {
      // 業務的変換不能（空入力の契約 (4) を含む）
      recordFailure(id, 'business-untransformable');
      continue;
    }

    if (!isConformingPointList(transformed, geoPoints.length)) {
      // 非配列・長さ不一致・非有限出力は adapter contract failure
      recordFailure(id, 'adapter-contract-failure');
      continue;
    }

    const transformedGcps: GcpPair[] = gcps.map((gcp, index) => ({
      pixel: gcp.pixel,
      geo: transformed[index],
    }));

    const fit = fitWorldFile(transformedGcps, {
      geoBasis: DAEDALUS_TARGET_BASIS,
      normalizeEpsilonMeters: epsilonMeters,
      debug: true,
    });
    fitReachedWarnings.push(...fit.warnings);

    const succeeded = fit.status === 'ok' || fit.status === 'ok_with_warnings';
    if (!succeeded || fit.qualityGate === 'unusable') {
      // Daedalus が正当に不足と判断した候補（ranked へ入れない。untransformableIds へも入れない）
      failureClasses.push('fit-insufficient');
      continue;
    }
    if (fit.worldFile === null || fit.rmsMeters === null || !Number.isFinite(fit.rmsMeters)) {
      failureClasses.push('dependency-contract-failure');
      continue;
    }

    const basicRmsMeters = basicRmsFromFit(fit, transformedGcps.length);
    if (basicRmsMeters === null || !Number.isFinite(basicRmsMeters)) {
      failureClasses.push('dependency-contract-failure');
      continue;
    }

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
  }));

  const hasImplementationFailure = failureClasses.some((failureClass) =>
    IMPLEMENTATION_FAILURE_CLASSES.has(failureClass),
  );

  const head = usable.length >= minCandidates ? rankedAll[0] : undefined;
  if (head === undefined) {
    return {
      status: deriveTopLevelStatus({
        usableCount: usable.length,
        minCandidates,
        hasImplementationFailure,
        selectedWarnings: [],
      }),
      selected: null,
      ranked,
      // selected が無い場合は fit に到達した候補の warning を入力順で返す
      // （{code,detail} 完全一致の重複だけ除く）
      warnings: dedupeWarnings(fitReachedWarnings),
      untransformableIds,
    };
  }

  // 成功時 warnings は selected 候補の Daedalus FitWarning だけを同順・同形で返す（設計 K9）
  const warnings = head.fit.warnings;

  return {
    status: deriveTopLevelStatus({
      usableCount: usable.length,
      minCandidates,
      hasImplementationFailure,
      selectedWarnings: warnings,
    }),
    selected: {
      identity: { authority: head.authority, code: head.code },
      // selected.worldFile / qualityGate は同じ候補に対する Daedalus の最終返却である（設計 K10）
      worldFile: head.fit.worldFile as NonNullable<FitResult['worldFile']>,
      score: head.score,
      // selected.rmsMeters は ranking に用いた shear 前 basic RMS である（設計 K10）
      rmsMeters: head.basicRmsMeters,
      qualityGate: head.fit.qualityGate as Exclude<QualityGate, 'unusable'>,
    },
    ranked,
    warnings,
    untransformableIds,
  };
}

/** `{code, detail}` 完全一致の重複だけを除く（順序は保つ）。 */
function dedupeWarnings(warnings: readonly FitWarning[]): FitWarning[] {
  const seen = new Set<string>();
  const result: FitWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code} ${warning.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}
