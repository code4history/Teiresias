/**
 * デモの計算層（m3-t1 設計 v1.3 §5.4）。
 *
 * **純関数だけを置く。** DOM も `@c4h/atlas` も参照しない — 候補 CRS と
 * `CandidateTransformer` は引数で受け取る。これは Teiresias 自身の設計原理
 * （`estimateCrs` が transformer を注入で受ける）と同型である（設計 §7）。
 *
 * 公開関数の契約の正本は設計 §5.4 の表である。本ファイルはその実装であり、
 * 契約を再定義しない。
 */
import { estimateCrs } from '../src/index.ts';

/** 京都近郊の探索 extent（`tests/estimate-crs.real-engine.e2e.test.ts` と同一）。 */
export const KYOTO_EXTENT = Object.freeze({ west: 135.6, south: 34.9, east: 135.9, north: 35.1 });

/** GCP の地理座標 5 点（lon/lat 度・lon-lat 順。E2E と同一）。 */
export const GCP_LONLAT = Object.freeze([
  Object.freeze([135.6, 34.9]),
  Object.freeze([135.9, 34.9]),
  Object.freeze([135.9, 35.1]),
  Object.freeze([135.6, 35.1]),
  Object.freeze([135.75, 35.0]),
]);

/** pixel 格子のスケール（m/pixel。E2E と同一）。 */
export const METERS_PER_PIXEL = 10;

/** 真値 CRS（平面直角座標系 VI 系）。 */
export const TRUE_ID = 'EPSG:6674';

/**
 * 「識別力が潰れている」の表示閾値（設計 K7）。
 *
 * **物理的な意味を持つ定数ではなく、表示のための閾値である。** 反射ありの実測比が
 * `1.000199…`、反射なしが `4.89e+10` である（設計 §5.2）∴ 両者を分ける任意の値でよい。
 */
export const COLLAPSE_THRESHOLD = 1.01;

/**
 * 真値 CRS の投影座標から pixel 格子を作る。
 *
 * 第 1 点を原点に置き、`metersPerPixel` で割る（E2E の `gcpSets()` と同形）。
 */
export function basePixelsFromProjected(projected, metersPerPixel = METERS_PER_PIXEL) {
  if (!Array.isArray(projected) || projected.length === 0) {
    throw new Error('basePixelsFromProjected: projected が空である');
  }
  const [e0, n0] = projected[0];
  return projected.map(([easting, northing]) => [
    (easting - e0) / metersPerPixel,
    (northing - n0) / metersPerPixel,
  ]);
}

/** `yFlip` が真なら `[x, -y]`、偽なら恒等（新しい配列を返す）。 */
export function applyYFlip(pixels, yFlip) {
  return pixels.map(([x, y]) => (yFlip ? [x, -y] : [x, y]));
}

/** `{pixel, geo}` の配列（Daedalus の `GcpPair`）を組む。 */
export function toGcpPairs(pixels, geoPoints) {
  if (pixels.length !== geoPoints.length) {
    throw new Error('toGcpPairs: pixel 点数と geo 点数が一致しない');
  }
  return pixels.map((pixel, index) => ({
    pixel: [pixel[0], pixel[1]],
    geo: [geoPoints[index][0], geoPoints[index][1]],
  }));
}

/**
 * 識別力（1 位と 2 位の RMS 比）。
 *
 * - `ratio = ranked[1].rmsMeters / ranked[0].rmsMeters`
 * - `ranked[0].rmsMeters === 0` なら `ratio = Infinity`（厳密適合。0 除算を作らない）
 * - `ranked.length < 2` なら `ratio = null` / `collapsed = null`（判定不能を偽で表さない）
 */
export function discriminationOf(ranked) {
  if (!Array.isArray(ranked) || ranked.length < 2) {
    return {
      ratio: null,
      top1Rms: ranked?.[0]?.rmsMeters ?? null,
      top2Rms: null,
      collapsed: null,
    };
  }
  const top1Rms = ranked[0].rmsMeters;
  const top2Rms = ranked[1].rmsMeters;
  const ratio = top1Rms === 0 ? Infinity : top2Rms / top1Rms;
  return {
    ratio,
    top1Rms,
    top2Rms,
    collapsed: ratio < COLLAPSE_THRESHOLD,
  };
}

/**
 * 1 シーンを計算する。
 *
 * `yFlip` は**ここで**適用する（呼出側は反転前の pixel を持ち続ける）。
 * `chirality` は `estimateCrs` の同名 option へそのまま渡す（省略時は `estimateCrs` の既定 =
 * 正規化あり）。デモ側で別の推定を書かず、同じ `estimateCrs` で「正規化あり／なし」を出す。
 * 返り値の `ranked` は各行に `id`（`${authority}:${code}`）と `isTruth` を付す。
 */
export async function runScene({ pixels, geoPoints, yFlip, chirality, candidates, transformer, options }) {
  const effectivePixels = applyYFlip(pixels, yFlip);
  const gcpPairs = toGcpPairs(effectivePixels, geoPoints);
  const result = await estimateCrs(gcpPairs, candidates, {
    transformer,
    ...(chirality === undefined ? {} : { chirality }),
    ...(options ?? {}),
  });

  const ranked = result.ranked.map((entry, index) => {
    const id = `${entry.authority}:${entry.code}`;
    return {
      rank: index + 1,
      id,
      authority: entry.authority,
      code: entry.code,
      score: entry.score,
      rmsMeters: entry.rmsMeters,
      isTruth: id === TRUE_ID,
    };
  });

  return {
    status: result.status,
    ranked,
    selected: result.selected,
    warnings: result.warnings,
    untransformableIds: result.untransformableIds,
    discrimination: discriminationOf(result.ranked),
    effectivePixels,
  };
}
