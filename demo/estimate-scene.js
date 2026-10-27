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
import { DEFAULT_SCENE } from './scenes.js';

/**
 * 京都近郊の探索 extent。
 *
 * 値は `demo/scenes.js` の `kyoto` が持つ（場面の値の置き場はそこだけである）。名前は
 * 既存の呼び出しのために残す。
 */
export const KYOTO_EXTENT = DEFAULT_SCENE.extent;

/** 京都の GCP の地理座標 5 点（lon/lat 度・lon-lat 順）。値は `demo/scenes.js` が持つ。 */
export const GCP_LONLAT = DEFAULT_SCENE.gcpLonLat;

/** pixel 格子のスケール（m/pixel。E2E と同一）。 */
export const METERS_PER_PIXEL = 10;

/** 既定の場面（京都）の真値 CRS（平面直角座標系 VI 系）。値は `demo/scenes.js` が持つ。 */
export const TRUE_ID = DEFAULT_SCENE.truthId;

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

/** 順位の行の ID（`${authority}:${code}`。`id` をそのまま持つ行にも対応する）。 */
function identityOf(entry) {
  if (entry?.id !== undefined) return entry.id;
  if (entry?.authority === undefined || entry?.code === undefined) return undefined;
  return `${entry.authority}:${entry.code}`;
}

/**
 * 候補の定義（`proj4` の文字列）。分からなければ `null`。
 *
 * `proj4ById`（`${authority}:${code}` → `proj4`）に無い候補・`proj4` が文字列でない候補は
 * **定義が分からない** ∴ 呼出側は「違う定義」として扱う。
 */
function definitionOf(entry, proj4ById) {
  if (!(proj4ById instanceof Map)) return null;
  const proj4 = proj4ById.get(identityOf(entry));
  return typeof proj4 === 'string' ? proj4 : null;
}

/**
 * 識別力（1 位と、1 位と**定義が違う**最初の候補との RMS 比）。
 *
 * - 比べる相手は、`proj4ById` を渡したときは「1 位と `proj4` が等しくない最初の行」、
 *   渡さないときは 2 位である。真値が縮退している（同じ定義の候補が並ぶ）とき、2 位との比は
 *   1 に近づき「潰れている」と誤って出る ∴ 定義の違う最初の行と比べる。
 * - `ratio = 比べた相手の rmsMeters / ranked[0].rmsMeters`
 * - `ranked[0].rmsMeters === 0` なら `ratio = Infinity`（厳密適合。0 除算を作らない）
 * - 比べる相手が無い（`ranked.length < 2`・全件が同じ定義）なら
 *   `ratio = null` / `collapsed = null` / `against = null`（判定不能を偽で表さない）
 * - `against` は比べた相手の ID（画面に「比べた相手」として出す）
 */
export function discriminationOf(ranked, proj4ById) {
  if (!Array.isArray(ranked) || ranked.length < 2) {
    return {
      ratio: null,
      top1Rms: ranked?.[0]?.rmsMeters ?? null,
      top2Rms: null,
      collapsed: null,
      against: null,
    };
  }

  const top1Rms = ranked[0].rmsMeters;
  let compared = ranked[1];
  if (proj4ById instanceof Map) {
    const topDefinition = definitionOf(ranked[0], proj4ById);
    const different = ranked
      .slice(1)
      .find((entry) => {
        const definition = definitionOf(entry, proj4ById);
        return topDefinition === null || definition === null || definition !== topDefinition;
      });
    if (different === undefined) {
      return {
        ratio: null,
        top1Rms,
        top2Rms: null,
        collapsed: null,
        against: null,
      };
    }
    compared = different;
  }

  const top2Rms = compared.rmsMeters;
  const ratio = top1Rms === 0 ? Infinity : top2Rms / top1Rms;
  return {
    ratio,
    top1Rms,
    top2Rms,
    collapsed: ratio < COLLAPSE_THRESHOLD,
    against: identityOf(compared) ?? null,
  };
}

/**
 * 1 シーンを計算する。
 *
 * `yFlip` は**ここで**適用する（呼出側は反転前の pixel を持ち続ける）。
 * `chirality` は `estimateCrs` の同名 option へそのまま渡す（省略時は `estimateCrs` の既定 =
 * 正規化あり）。デモ側で別の推定を書かず、同じ `estimateCrs` で「正規化あり／なし」を出す。
 * `scene` は場面（省略時は京都）。返り値の `ranked` は各行に `id`（`${authority}:${code}`）・
 * `isTruth`（場面の `truthId` と一致）・`isSameDefinition`（真値と `proj4` が同じ = 同値）を付す。
 * 識別力の比べる相手は、候補の行の `proj4` から作った `proj4ById` で決める。
 */
export async function runScene({
  pixels,
  geoPoints,
  yFlip,
  chirality,
  candidates,
  transformer,
  options,
  scene = DEFAULT_SCENE,
}) {
  const effectivePixels = applyYFlip(pixels, yFlip);
  const gcpPairs = toGcpPairs(effectivePixels, geoPoints);
  const result = await estimateCrs(gcpPairs, candidates, {
    transformer,
    ...(chirality === undefined ? {} : { chirality }),
    ...(options ?? {}),
  });

  // 候補の定義（`proj4`）の表。`proj4` を持たない行は入れない ∴ その候補は「定義が分からない」
  // として扱われる（第 2 引数を渡さないときと同じ比になる）。
  const proj4ById = new Map();
  for (const row of candidates ?? []) {
    if (row && typeof row.id === 'string' && typeof row.proj4 === 'string') {
      proj4ById.set(row.id, row.proj4);
    }
  }
  const truthDefinition = proj4ById.get(scene.truthId) ?? null;

  const ranked = result.ranked.map((entry, index) => {
    const id = `${entry.authority}:${entry.code}`;
    const definition = proj4ById.get(id) ?? null;
    return {
      rank: index + 1,
      id,
      authority: entry.authority,
      code: entry.code,
      score: entry.score,
      rmsMeters: entry.rmsMeters,
      isTruth: id === scene.truthId,
      // 「同値」= 真値と定義（`proj4`）が同じ候補。両方の `proj4` が分かるときだけ印を付ける。
      isSameDefinition:
        id !== scene.truthId && definition !== null && truthDefinition !== null && definition === truthDefinition,
    };
  });

  return {
    status: result.status,
    ranked,
    selected: result.selected,
    warnings: result.warnings,
    untransformableIds: result.untransformableIds,
    failure: result.failure ?? null,
    discrimination: discriminationOf(result.ranked, proj4ById),
    effectivePixels,
    scene,
  };
}
