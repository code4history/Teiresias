/**
 * 推定した CRS の当てはまり（`score`）から、地図の変換の形を推奨する。
 *
 * 形は 3 つ:
 * - `worldFileOnly`: CRS＋world file だけ（三角網なし）
 * - `tinGlobal`: CRS＋world file＋三角網。三角網の四辺形の外は world file（大域モデル）
 * - `tinFan`: CRS＋world file＋三角網。三角網の四辺形の外は重心からの扇形
 *
 * 閾値は平面図 6 枚＋伏見城図の実測から置いた仮の値（2026-11-25）。境の近くでは 2 つを返し、
 * score が近い側を先に並べる。どれを採るかは利用者（Editor の人間）が決める。
 * 鳥瞰図は大域モデルが射影になるので、world file を使う 2 つを推奨しない。
 */
import type { EstimationResult } from './types.js';

/** 推奨する変換の形。 */
export type TransformSetup = 'worldFileOnly' | 'tinGlobal' | 'tinFan';

/** 推奨の根拠。 */
export type RecommendationReason =
  /** score が 1 つの区分の中にある */
  | 'clear'
  /** score が 2 つの区分の境の近くにある（2 つを返す） */
  | 'borderline'
  /** 鳥瞰図なので `tinFan` だけ */
  | 'birdeye'
  /** 推定が使えない（`status` が `ok`／`ok_with_warnings` でない・`selected` が無い・score が無い・GCP が少ない）、または score が非有限・負 */
  | 'unavailable';

/** 推奨の結果。 */
export interface TransformRecommendation {
  /** 推奨する形。0〜2 件。2 件のときは先頭がより近い側。 */
  setups: TransformSetup[];
  reason: RecommendationReason;
  /** 判定に使った score（使えないときは `null`）。 */
  score: number | null;
}

/**
 * 推奨の閾値（`score` = 相似の残差 RMS ÷ GCP の bbox の対角）。仮の値。
 *
 * - `worldFileOnly` 未満なら `worldFileOnly`、`fan` 以上なら `tinFan`、その間は `tinGlobal`
 * - `*Band` の範囲は境の近くとして 2 つを返す。範囲は下端を含み上端を含まない半開区間 `[lo, hi)`
 * - 判定の優先は、不正な score（`unavailable`）→ 鳥瞰図（`birdeye`）→ 境の近く（`borderline`）→ それ以外（`clear`）
 */
export const TRANSFORM_SETUP_THRESHOLDS = Object.freeze({
  worldFileOnly: 0.005,
  worldFileOnlyBand: Object.freeze([0.003, 0.008] as const),
  fan: 0.035,
  fanBand: Object.freeze([0.03, 0.04] as const),
});

/** 3857 から乗り換えを推奨する、score の比の上限（最良の候補 ÷ 3857 がこれ以下）。仮の値。 */
export const CRS_SWITCH_MAX_RATIO = 0.95;

/** `recommendTransformSetup` の option。 */
export interface RecommendOptions {
  /** 地図の頂点の扱い。`'birdeye'` なら `tinFan` だけを推奨する。既定 `'plain'`。 */
  vertexMode?: 'plain' | 'birdeye';
}

/** score だけから推奨する（`status` などの検査をしない）。 */
export function recommendTransformSetupFromScore(
  score: number,
  options: RecommendOptions = {},
): TransformRecommendation {
  if (!Number.isFinite(score) || score < 0) return { setups: [], reason: 'unavailable', score: null };
  if (options.vertexMode === 'birdeye') return { setups: ['tinFan'], reason: 'birdeye', score };
  const t = TRANSFORM_SETUP_THRESHOLDS;
  if (score >= t.worldFileOnlyBand[0] && score < t.worldFileOnlyBand[1]) {
    const setups: TransformSetup[] = score < t.worldFileOnly ? ['worldFileOnly', 'tinGlobal'] : ['tinGlobal', 'worldFileOnly'];
    return { setups, reason: 'borderline', score };
  }
  if (score >= t.fanBand[0] && score < t.fanBand[1]) {
    const setups: TransformSetup[] = score < t.fan ? ['tinGlobal', 'tinFan'] : ['tinFan', 'tinGlobal'];
    return { setups, reason: 'borderline', score };
  }
  if (score < t.worldFileOnly) return { setups: ['worldFileOnly'], reason: 'clear', score };
  if (score < t.fan) return { setups: ['tinGlobal'], reason: 'clear', score };
  return { setups: ['tinFan'], reason: 'clear', score };
}

/**
 * `estimateCrs` の結果から推奨する。
 *
 * `status` が `ok`／`ok_with_warnings` でない、`selected` が無い、`selected.score` が無い、
 * または `selected.qualityGate` が `preview`（GCP が少なく当てはめを検証できない）なら、
 * `reason: 'unavailable'` で何も推奨しない。
 */
export function recommendTransformSetup(
  result: EstimationResult,
  options: RecommendOptions = {},
): TransformRecommendation {
  const selected = result.selected;
  if (
    (result.status !== 'ok' && result.status !== 'ok_with_warnings') ||
    !selected ||
    selected.score === null ||
    selected.qualityGate === 'preview'
  ) {
    return { setups: [], reason: 'unavailable', score: null };
  }
  return recommendTransformSetupFromScore(selected.score, options);
}

/**
 * 3857 から最良の候補へ乗り換えを推奨するか。
 *
 * 都市の広さでは候補どうしの score の差がごく小さく（0.5 % 未満の実測）、乗り換えても位置は
 * 変わらずビューアに投影の定義が要るだけになる。最良の候補の score が 3857 の score の
 * `CRS_SWITCH_MAX_RATIO` 倍以下のときだけ `true`。どちらかが `null`・非有限、`bestScore` が負、
 * `baseScore` が 0 以下なら `false`。
 */
export function shouldRecommendCrsSwitch(bestScore: number | null, baseScore: number | null): boolean {
  if (bestScore === null || baseScore === null) return false;
  if (!Number.isFinite(bestScore) || !Number.isFinite(baseScore) || bestScore < 0 || baseScore <= 0) return false;
  return bestScore <= baseScore * CRS_SWITCH_MAX_RATIO;
}
