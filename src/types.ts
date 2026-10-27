/**
 * Teiresias 公開型（m1-t1 設計 §3.1）。
 *
 * `WorldFile` / `GcpPair` / `GeoBasis` / `FitStatus` / `QualityGate` / `FitWarning` /
 * `MaybePromise` は Teiresias で再定義せず、`@c4h/daedalus` の公開型を type import /
 * re-export する（設計 K17。Daedalus `src/types.ts` に構造も意味も同じ型が実在するため、
 * 二重所有による将来 drift を避ける）。
 */
import type { GcpPair, GeoBasis, MaybePromise, QualityGate, WorldFile, FitStatus, FitWarning } from '@c4h/daedalus';

export type {
  FitStatus,
  FitWarning,
  GcpPair,
  GeoBasis,
  MaybePromise,
  QualityGate,
  WorldFile,
} from '@c4h/daedalus';

/**
 * 候補 CRS の最小構造型。
 *
 * Atlas の record 全体へ結合せず、`authority` / `code` / 任意の `datumFamily` だけを要求する
 * （設計 K6）。呼出側から独立した `id` は受け取らない。`id` は Teiresias が
 * `${authority}:${code}` として 1 箇所で組み立てる（設計 §3.2）。
 */
export interface CandidateCrs {
  authority: string;
  code: string;
  datumFamily?: string;
}

/**
 * 座標の線形単位。`metresPerUnit` は 1 単位が何 metre か（1 単位 = `metresPerUnit` m）。
 *
 * 候補の座標が metre でないとき（例: 歴史的な格子の yard・US survey foot）に、
 * transformer の返却と推定結果がこの型で単位を運ぶ。metre は `{ name: 'metre', metresPerUnit: 1 }`。
 */
export interface LinearUnit {
  name: string;
  metresPerUnit: number;
}

/**
 * 単位つきの変換結果。`points` は `unit` の単位の projected `[easting, northing]` 点列である。
 *
 * transformer がこの形を返すと、Teiresias は `metresPerUnit` 倍して metre に直してから当てはめる。
 */
export interface CandidatePoints {
  points: Array<[number, number]>;
  unit: LinearUnit;
}

/**
 * 候補 CRS への変換 adapter。契約 8 項目の正本は
 * `docs/superpowers/specs/2026-08-28-mock-transformer-contract.md`（親リポジトリ）。
 *
 * - 入力 `points` は `geoBasis` が示す順序の geo 点列（同順）。
 * - 出力は入力と同順同数の projected `[easting, northing]` 点列、`{ points, unit }`、または `null`。
 * - plain な点列は metre と解釈する。`CandidatePoints` は `unit` の単位の点列である。
 * - 空入力・業務的変換不能はすべて `null`。throw は adapter bug のときのみ。
 * - 同期返却（`MaybePromise` の T 側）と Promise 返却の双方が適合する。
 */
export type CandidateTransformer = (
  id: string,
  points: ReadonlyArray<readonly [number, number]>,
  geoBasis: GeoBasis,
) => MaybePromise<Array<[number, number]> | CandidatePoints | null>;

/**
 * `estimateCrs` の option。
 *
 * `minCandidates` 既定 1 / `topK` 既定 usable 全件 / `normalizeEpsilonMeters` 既定 100 m。
 * 正の整数でない値・非有限値は既定へ正規化する（設計 K8）。
 * `datumFamilyPrior` は caller 指定順の**弱い prior** であり、score の機械精度同着内でのみ働く
 * （設計 K4）。
 */
export interface EstimateOptions {
  transformer: CandidateTransformer;
  geoBasis?: GeoBasis;
  minCandidates?: number;
  topK?: number;
  normalizeEpsilonMeters?: number;
  datumFamilyPrior?: readonly string[];
  /**
   * 反射（pixel の y 軸の向き）を吸収するか。既定 `'normalize'`。
   *
   * `'normalize'` は候補ごとに、pixel の v を反転した入力でも相似変換を当て、basic SSE の
   * 小さい側を採る（同値なら反転しない側）。反転した側を採ったら、返す `worldFile` の
   * `xSkew` と `yScale` の符号を反転して元の pixel 座標系の写像に戻す。transformer の
   * 呼び出し回数は変わらない。`'direct-only'` は反転を試さない（正規化前の挙動）。
   */
  chirality?: 'normalize' | 'direct-only';
  /**
   * 検証用の GCP（Daedalus の holdout 検証へ渡す）。`geo` は `geoBasis` の順。
   *
   * 当てはめには使わず、affine を採るかどうかの検証にだけ使う。transformer の呼び出しは
   * 増えない（GCP と holdout の地理座標をつないで 1 回で変換する）。空配列は未指定と同じ。
   */
  holdout?: readonly GcpPair[];
  /**
   * 候補 1 件の transformer の呼び出しの上限（ms）。既定 120000。`Infinity` で無効。
   * 正の数でない値・非数は既定へ正規化する。2147483647（`setTimeout` が受けられる遅延の上限）を
   * 越える値は `Infinity`（上限なし）として扱う。
   *
   * 上限を越えたらその場で推定を止め、`status: 'failed'`（`failure.reason: 'timeout'`）を返す。
   * Promise を返して待たせる transformer の上限であり、同期で処理を握り続ける transformer は
   * 打ち切れない。
   */
  timeoutMs?: number;
  /**
   * 推定全体の中止。中止されたら `signal.reason`（無ければ `AbortError` の `DOMException`）で
   * reject する。
   */
  signal?: AbortSignal;
}

/**
 * 実装側の失敗の種類（業務的な変換不能〔`null`〕は含まない）。
 *
 * - `adapter-bug`: transformer が throw / reject した
 * - `adapter-contract-failure`: 出力が契約に反する（長さ不一致・非有限・空入力に配列を返した など）
 * - `dependency-contract-failure`: Daedalus の返却が公開契約と食い違う
 * - `adapter-timeout`: transformer が `timeoutMs` の内に答えなかった
 */
export type CandidateFailureKind =
  | 'adapter-bug'
  | 'adapter-contract-failure'
  | 'dependency-contract-failure'
  | 'adapter-timeout';

/** 失敗した候補 1 件。 */
export interface CandidateFailure {
  /** `${authority}:${code}` */
  id: string;
  kind: CandidateFailureKind;
  /** 何が起きたか（throw のメッセージ・`expected 5 points, got 4` など。500 文字で切る）。 */
  message: string;
}

/** `status: 'failed'` の理由。 */
export interface EstimationFailure {
  reason: 'implementation-failure' | 'timeout';
  /** 入力順。`timeout` のときは打ち切った 1 件が最後に来る。 */
  candidates: CandidateFailure[];
}

/**
 * 推定結果。
 *
 * `ranked[].rmsMeters` と `selected.rmsMeters` は **ranking に用いた shear 前 basic RMS**、
 * `selected.worldFile` と `selected.qualityGate` は**同じ候補に対する Daedalus の最終返却**
 * （affine 採用を含み得る）である（設計 K10 / §5.2）。
 *
 * 単位: `rmsMeters` は全候補で比べられるよう常に metre である。`unit` はその候補の座標の単位で、
 * `worldFile` もその単位の写像（pixel → 候補の座標）である。plain な点列を返した候補は
 * `{ name: 'metre', metresPerUnit: 1 }` になる。
 *
 * 保存境界: Editor が明示採用した後に永続化してよいのは `selected.identity` と採用 worldFile
 * だけである。`ranked` / `score` / basic RMS / `qualityGate` / `warnings` /
 * `untransformableIds` / `selected` object 全体は診断返却であり保存しない（設計 §6-8）。
 */
export interface EstimationResult {
  status: FitStatus;
  selected: {
    identity: { authority: string; code: string };
    worldFile: WorldFile;
    /** その候補の座標の単位（`worldFile` の 6 値もこの単位）。 */
    unit: LinearUnit;
    score: number | null;
    rmsMeters: number;
    qualityGate: Exclude<QualityGate, 'unusable'>;
  } | null;
  ranked: Array<{
    authority: string;
    code: string;
    score: number | null;
    rmsMeters: number;
    unit: LinearUnit;
  }>;
  warnings: readonly FitWarning[];
  untransformableIds: string[];
  /**
   * `status === 'failed'` の理由。それ以外は `null`。
   *
   * 実装側の失敗（`CandidateFailureKind`）が 1 件でもあれば、残りの候補が使えても `failed` に
   * なり `selected` は `null` になる（その候補が真値だったかを判断できないため）。このとき
   * `ranked` は評価できた候補だけの不完全な順位であり、選択に使ってはならない。
   */
  failure: EstimationFailure | null;
}
