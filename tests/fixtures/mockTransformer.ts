/**
 * `CandidateTransformer` 契約の **Teiresias 側実装**（Mock 二層所有の消費側。契約文書 §5）。
 *
 * 【二層所有】
 * 契約定義・参照実装・fixture の正本は Daedalus 側 testkit にある。Teiresias はそれを
 * **package 越し import も相対パス import もしない**（契約文書 §5.1、委任 AC `m0-t3/AC-T2`）。
 * 数値正本である fixture だけを `mockContractFixture.ts` へ**ファイルコピー**して持ち込み
 * （SHA-256 で同一性を機械照合する）、判定分岐は本ファイルが Teiresias 所有として再実装する
 * （設計 K12）。
 *
 * 【判定順序】（契約文書 §2.1。上から評価し最初に該当した分岐で確定する）
 *  1. `points.length === 0`                       -> null   契約(4)
 *  2. geoBasis が lonlat_deg / lon-lat でない     -> null   契約(7)
 *  3. id がカタログに無い（書式不正を含む）       -> null   契約(7)
 *  4. いずれかの点の lon/lat が非有限             -> null   契約(5)
 *  5. いずれかの点が候補の有効域 bbox 外          -> null   契約(5)(7)
 *  6. 上記以外 -> 全点を写像した同順同数の配列           契約(2)(3)(8)
 *
 * **適合実装は throw 分岐を持たない**（契約(7)）。throw するのは違反シミュレータだけである。
 */
import type { CandidateTransformer, GcpPair, GeoBasis } from '../../src/index.js';

import { candidateDefinitions } from './mockContractFixture.js';

/**
 * 参照実装は同期返却（`MaybePromise` の T 側）とする（契約(8)）。
 * `SyncCandidateTransformer` は `CandidateTransformer` の同期特化であり、
 * 下の `satisfies` 相当の代入で公開型への適合を compile-time に保証する。
 */
type SyncCandidateTransformer = (
  id: string,
  points: ReadonlyArray<readonly [number, number]>,
  geoBasis: GeoBasis,
) => Array<[number, number]> | null;

const isSupportedBasis = (geoBasis: GeoBasis): boolean =>
  geoBasis.kind === 'lonlat_deg' && geoBasis.axisOrder === 'lon-lat';

/**
 * 契約適合の決定的 mock（同期純関数）。
 *
 * 決定性（契約(8)）: 乱数・時刻・外部 IO・共有可変状態を参照しない。
 */
export const mockTransformer: SyncCandidateTransformer = (id, points, geoBasis) => {
  // 1. 空入力（`[]` ではなく null を返す）
  if (points.length === 0) {
    return null;
  }

  // 2. 対応外 geoBasis（mock は planar_xy 経路をモデル化しない）
  if (!isSupportedBasis(geoBasis)) {
    return null;
  }

  // 3. 未知 id（カタログに無い / 書式不正）
  const definition = candidateDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) {
    return null;
  }

  const [lon0, lat0] = definition.origin;
  const { west, south, east, north } = definition.bbox;
  const result: Array<[number, number]> = [];

  for (const point of points) {
    const [lon, lat] = point;

    // 4. 非有限（一点でも該当したら全体 null。部分配列・null 埋めを返さない）
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return null;
    }

    // 5. 有効域 bbox 外（境界は含む）
    if (lon < west || lon > east || lat < south || lat > north) {
      return null;
    }

    // 6. 写像（単位はメートル相当の平面座標。出力は [easting, northing] 順）
    const dLon = lon - lon0;
    const dLat = lat - lat0;
    result.push([
      definition.eLon * dLon + definition.eLat * dLat,
      definition.nLon * dLon + definition.nLat * dLat,
    ]);
  }

  return result;
};

/** 適合 mock を Promise で包んだもの。`MaybePromise` の Promise 側の適合を検証する。 */
export const asyncMockTransformer: CandidateTransformer = async (id, points, geoBasis) =>
  mockTransformer(id, points, geoBasis);

/**
 * 違反シミュレータ（契約(7) の adapter bug）。
 * **入力によらず常に throw する**（null 系入力を含む全入力域で定義済み）。
 */
export const throwingMockTransformer: SyncCandidateTransformer = () => {
  throw new Error('mock adapter bug: throwingMockTransformer always throws');
};

/** 違反シミュレータ（adapter bug の Promise 版）。常に reject する。 */
export const rejectingMockTransformer: CandidateTransformer = () =>
  Promise.reject(new Error('mock adapter bug: rejectingMockTransformer always rejects'));

/**
 * 違反シミュレータ（契約(6) の長さ不一致）。
 * 適合 mock と**同一の判定順序**を評価し、適合 mock が配列を返す入力に対して**のみ**
 * 末尾 1 点を欠いた配列を返す。null を返す入力には同じく null を返す。
 * ∴ 違反注入は成功経路に限られ、空入力で `length - 1 = -1` という未定義域は発生しない。
 */
export const brokenLengthMockTransformer: SyncCandidateTransformer = (id, points, geoBasis) => {
  const conforming = mockTransformer(id, points, geoBasis);
  if (conforming === null) {
    return null;
  }
  return conforming.slice(0, conforming.length - 1);
};

/**
 * 違反シミュレータ（契約(5) の非有限出力）。
 * 適合 mock が配列を返す入力に対してのみ、先頭点の easting を `Number.NaN` へ差し替える。
 */
export const nonFiniteOutputMockTransformer: SyncCandidateTransformer = (id, points, geoBasis) => {
  const conforming = mockTransformer(id, points, geoBasis);
  if (conforming === null || conforming.length === 0) {
    return conforming;
  }
  const broken = conforming.map((point): [number, number] => [point[0], point[1]]);
  broken[0] = [Number.NaN, broken[0][1]];
  return broken;
};

/**
 * 同期 mock 群が公開型 `CandidateTransformer` に代入可能であることの compile-time 検査。
 * （`MaybePromise` の T 側として適合する。契約(8)）
 */
export const conformingTransformers: ReadonlyArray<CandidateTransformer> = [
  mockTransformer,
  asyncMockTransformer,
  throwingMockTransformer,
  rejectingMockTransformer,
  brokenLengthMockTransformer,
  nonFiniteOutputMockTransformer,
];

/**
 * Teiresias 所有の E2E GCP セット（5 点。設計 §7.2 の E2E に使う）。
 *
 * 【なぜ fixture の `recommendedE2eGcps` をそのまま使わないか（実装工程での実測に基づく設計逸脱）】
 * fixture の `recommendedE2eGcps` は `lat = 35 - v*0.0078125`（pixel y 下正 / 北上正）であり、
 * pixel -> geo の写像が**行列式の負な反射**を含む。一方 Daedalus の basic（Helmert）similarity は
 * `worldFile = {xScale:a, xSkew:-b, ySkew:b, yScale:a}` すなわち**行列式 a²+b² > 0 の回転+等方
 * スケールのみ**を表現でき、反射を表現できない。
 * ∴ `recommendedE2eGcps` では PLANE-A も basic similarity で厳密適合せず、実測で
 *   PLANE-A basicRms = 5522.170500128557 / PLANE-B basicRms = 4791.8865398246935
 * となり **PLANE-B が basic score で先着**する（AC-m1-2 の「PLANE-A が ranked[0]」と矛盾する）。
 * fixture 自身が `recommendedE2eGcps` を「m1-t1 への**推奨**であり、m1-t1 のテスト設計を
 * 拘束しない」と明記しているため、AC-m1-2 の趣旨（basic-before-shear が誤候補の affine 救済を
 * 防ぐこと）を満たす**反射なし**の同型セットを Teiresias 側で所有する。
 *
 * 反射ありの `recommendedE2eGcps` に対する実測挙動は
 * `tests/estimate-crs.e2e.test.ts` の「実測固定」節でそのまま固定してある（発見事項の可視化）。
 * その節は `chirality: 'direct-only'`（反射を吸収しない経路）を渡している。`estimateCrs` の
 * 既定（chirality 正規化）では、`recommendedE2eGcps` でも PLANE-A が ranked[0] になり
 * yScale が負の WorldFile が返る（同ファイルの「chirality 正規化（既定）」節）。
 * 本セットは正規化に依存しない反射なしの基準として残す。
 *
 *   pixel (u,v) -> lon = 135 + u*0.0078125, lat = 35 + v*0.0078125
 * 期待（PLANE-A・basic similarity で厳密適合）:
 *   xScale=869.6875, xSkew=0, xOrigin=0, ySkew=0, yScale=869.6875, yOrigin=0
 * オフセットは fixture §4.1 と同じく 2 の冪の分数（2⁻⁷ の倍数）に限定してあり、期待値は厳密である。
 */
export const teiresiasE2eGcps: ReadonlyArray<GcpPair> = [
  { pixel: [0, 0], geo: [135.0, 35.0] },
  { pixel: [10, 0], geo: [135.078125, 35.0] },
  { pixel: [0, 10], geo: [135.0, 35.078125] },
  { pixel: [10, 10], geo: [135.078125, 35.078125] },
  { pixel: [4, 6], geo: [135.03125, 35.046875] },
];

/** `teiresiasE2eGcps` に対する PLANE-A の期待 WorldFile（basic similarity 厳密適合）。 */
export const expectedPlaneAWorldFile = {
  xScale: 869.6875,
  xSkew: 0,
  xOrigin: 0,
  ySkew: 0,
  yScale: 869.6875,
  yOrigin: 0,
} as const;
