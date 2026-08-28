/**
 * CandidateTransformer 契約 fixture の正本（Daedalus testkit）。
 *
 * 【本ファイルの位置づけ】
 * - 契約文書: `docs/superpowers/specs/2026-08-28-mock-transformer-contract.md`（親リポジトリ）
 * - 本ファイルは **import を一切持たない純定数ファイル**である。Teiresias（m1-t1）は本ファイルを
 *   package 境界越し import せず、**ファイルコピー**して使う（Mock 二層所有。契約文書 §4）。
 *   コピー 1 ファイルだけで mock を再実装できるよう、候補カタログ（id・写像係数・原点・
 *   有効域 bbox）も本ファイルに機械可読な正本として収載する（設計 K12）。
 * - 数値設計の原則（設計 K5）: geo 点の lon/lat オフセットは 2 の冪の分数
 *   （±0.5, ±0.75, ±0.078125 = 2^-7 の倍数）に限定する。倍精度で `lon - 135.0` 等の減算が
 *   誤差ゼロになり、期待値が厳密な有限小数になる。∴ tolerance 1e-9 の assert が丸め誤差の
 *   影響を受けない。
 *
 * 本ファイルを改訂する場合は `fixtureVersion` を上げ、契約文書と Teiresias 側コピーを
 * 同一変更で追随させること（outer rule-0015 と同型の規律）。
 */

/** fixture の版。改訂時に上げる（契約文書に記載された版と一致すること）。 */
export const fixtureVersion = '1.0.0';

/** mock が対応する唯一の geoBasis（lonlat_deg / lon-lat 順）。 */
export const geoBasisLonLat = { kind: 'lonlat_deg', axisOrder: 'lon-lat' } as const;

// ---------------------------------------------------------------------------
// (0) 候補カタログ（id・写像係数・原点・有効域 bbox の機械可読正本）
// ---------------------------------------------------------------------------

export const planeAId = 'MOCK:PLANE-A';
export const planeBId = 'MOCK:PLANE-B';

/** mock が定義する候補 id の全数。 */
export const candidateIds = [planeAId, planeBId] as const;

export interface MockCandidateDefinition {
  id: string;
  /** [lon0, lat0]（deg）。写像の原点。 */
  origin: readonly [number, number];
  /**
   * E = eLon*(lon - lon0) + eLat*(lat - lat0)
   * N = nLon*(lon - lon0) + nLat*(lat - lat0)
   * 単位はメートル相当の平面座標。
   */
  eLon: number;
  eLat: number;
  nLon: number;
  nLat: number;
  /** 有効域（lon/lat deg・境界を含む）。域外の点は業務的変換不能として全体 null。 */
  bbox: { west: number; south: number; east: number; north: number };
}

export const candidateDefinitions: ReadonlyArray<MockCandidateDefinition> = [
  {
    id: planeAId,
    origin: [135.0, 35.0],
    // 等方スケール（similarity で厳密適合する）
    eLon: 111320,
    eLat: 0,
    nLon: 0,
    nLat: 111320,
    bbox: { west: 134, south: 34, east: 136, north: 36 },
  },
  {
    id: planeBId,
    origin: [135.0, 35.0],
    // 非等方・skew あり（PLANE-A と明確に区別できる）
    eLon: 100000,
    eLat: 20000,
    nLon: -15000,
    nLat: 90000,
    bbox: { west: 134, south: 34, east: 136, north: 36 },
  },
];

// ---------------------------------------------------------------------------
// (a) 契約検証用の geo 点列（3 点・全点 bbox 内・オフセットは 2 の冪の分数）
// ---------------------------------------------------------------------------

export const contractPoints: ReadonlyArray<readonly [number, number]> = [
  [135.0, 35.0],
  [135.5, 34.5],
  [134.25, 35.75],
];

// ---------------------------------------------------------------------------
// (b) 期待出力（mock の写像から厳密計算。実装はこの数表を assert する）
// ---------------------------------------------------------------------------

export const expectedPlaneA: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [55660, -55660], // 111320*0.5, 111320*(-0.5)
  [-83490, 83490], // 111320*(-0.75), 111320*0.75
];

export const expectedPlaneB: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [40000, -52500], // 100000*0.5+20000*(-0.5), -15000*0.5+90000*(-0.5)
  [-60000, 78750], // 100000*(-0.75)+20000*0.75, -15000*(-0.75)+90000*0.75
];

// ---------------------------------------------------------------------------
// (c) null 系入力（各契約項目に 1 対 1 対応）
// ---------------------------------------------------------------------------

/** 契約 (4): 空入力 → null（`[]` を返さない）。 */
export const emptyPoints: ReadonlyArray<readonly [number, number]> = [];

/** 契約 (5): 一点でも非有限なら全体 null（部分成功なし）。 */
export const nonFinitePoints = [
  [135.0, 35.0],
  [Number.NaN, 35.0],
] as const;

/** 契約 (5)(7): 候補 bbox 域外は業務的変換不能 → 全体 null。 */
export const outOfBboxPoints = [
  [135.0, 35.0],
  [140.0, 35.0],
] as const;

/** 契約 (7): カタログに無い候補 id → 業務的不能として null（throw しない）。 */
export const unknownId = 'MOCK:NO-SUCH';

// ---------------------------------------------------------------------------
// (d) m1-t1 推奨 E2E GCP セット（真値候補 = MOCK:PLANE-A）
// ---------------------------------------------------------------------------

/**
 * 5 点・similarity 厳密適合・yScale<0 を含む。
 *   pixel (u,v) -> lon = 135 + u*0.0078125, lat = 35 - v*0.0078125
 * 期待 WorldFile:
 *   xScale=869.6875, xSkew=0, xOrigin=0, ySkew=0, yScale=-869.6875, yOrigin=0
 *   （E = 111320 * u * 0.0078125 = 869.6875u、N = -869.6875v。pixel y 下正・target 北上正から
 *     yScale < 0 になる — 符号を反転して正規化しない）
 * geo bbox の辺長 ≈ 8.7 km（緯度辺。対角は約 11〜12 km）であり L_geo gate 100 m を大きく超える。
 *
 * 本データは m1-t1 への **推奨**であり、m1-t1 のテスト設計を拘束しない。
 */
export const recommendedE2eGcps: ReadonlyArray<{
  pixel: readonly [number, number];
  geo: readonly [number, number];
}> = [
  { pixel: [0, 0], geo: [135.0, 35.0] },
  { pixel: [10, 0], geo: [135.078125, 35.0] },
  { pixel: [0, 10], geo: [135.0, 34.921875] },
  { pixel: [10, 10], geo: [135.078125, 34.921875] },
  { pixel: [4, 6], geo: [135.03125, 34.953125] },
];
