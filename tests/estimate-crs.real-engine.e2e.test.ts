/**
 * 実 Atlas engine を注入した `estimateCrs` の E2E（m2a-t1 設計 v1.5 §5.3 / §7）。
 *
 * 対応 AC:
 * - m2a-t1/AC-1(b): `selected.identity` から組んだ `${authority}:${code}` が Atlas の
 *   `ProjectedCrsInfo.id` と一致する（実行時 identity 往復）
 * - m2a-t1/AC-6:    反射なしセットで真値 `EPSG:6674` が `ranked[0]`（実 engine E2E）
 * - m2a-t1/AC-7:    反射を含む実 GCP セットでの候補間相対順位の**実測固定**（K22）
 * - m2a-t1/AC-13:   符号付き面積・部分集合多数決による反射判定の実 engine 成立性の実測固定
 * - m2a-t1/AC-14:   縮退クラス（同一 proj4 へ潰れる authority エントリ集合）の実測固定
 *
 * **本 describe 群のうち「実測固定」と題したものは、期待する仕様の表明ではなく
 * 発見の可視化である**（m1-t1 の `estimate-crs.e2e.test.ts` の前例に踏襲）。
 * 反射時の挙動は本タスクでは変えない — 判定結果は ranking にも AC-6 にも影響させない。
 *
 * 反射判定 helper（§5.6）は**本ファイル内にだけ**置き、`export` しない。製品コード
 * （`Atlas/src` / `Teiresias/src` / `Daedalus`）へは置かない（設計 K13。置いた時点で
 * 「反射をどう扱うか」を m2a が決めたことになり、m2b の所有事項を侵す）。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createCandidateTransformer,
  listProjectedCrsFromProjWasm,
  transformLonLatArrayToProjected,
  type ProjectedCrsInfo,
} from '@c4h/atlas';

import { estimateCrs } from '../src/index.js';
import type { CandidateCrs, EstimationResult } from '../src/index.js';

// 実 engine の初回のカタログ読み込み（proj.db の展開）は、最初に呼んだテストが払う。
// 全件を並列に走らせた負荷ありで最大 8,845 ms を測った（3 回）∴ その 2 倍を秒へ切り上げた
// 18 秒をこのファイルの timeout にする（既定の 5 秒では負荷ありで落ちる）。
vi.setConfig({ testTimeout: 18_000 });

// ---------------------------------------------------------------------------
// 実カタログ（ハードコードした ProjectedCrsInfo は作らない。カタログ経路を E2E に含める）
// ---------------------------------------------------------------------------

const KYOTO_EXTENT = { west: 135.6, south: 34.9, east: 135.9, north: 35.1 };

/** 設計 §5.3 の GCP 地理座標 5 点（lon/lat 度・lon-lat 順）。 */
const GCP_LONLAT: ReadonlyArray<readonly [number, number]> = [
  [135.6, 34.9],
  [135.9, 34.9],
  [135.9, 35.1],
  [135.6, 35.1],
  [135.75, 35.0],
];

/** pixel 格子のスケール（m/pixel）。 */
const METERS_PER_PIXEL = 10;

const TRUE_ID = 'EPSG:6674';
/** AC-6 / AC-7(a)(b)(c) が使う 3 件集合（zone V / VI / VII。互いに proj4 が異なる）。 */
const REQUIRED_IDS = ['EPSG:6674', 'EPSG:6673', 'EPSG:6675'] as const;

let catalogDefaultPromise: Promise<ProjectedCrsInfo[]> | undefined;
let catalogWidePromise: Promise<ProjectedCrsInfo[]> | undefined;

/** (I) 既定カタログ — AC-7(d) / AC-14 が使う。padding を指定しない実運用どおりの呼び出し。 */
function catalogDefault(): Promise<ProjectedCrsInfo[]> {
  if (!catalogDefaultPromise) {
    catalogDefaultPromise = listProjectedCrsFromProjWasm({
      extent: KYOTO_EXTENT,
      area: 'Japan',
      onshoreOnly: true,
    });
  }
  return catalogDefaultPromise;
}

/**
 * (II) 明示 padding カタログ — AC-6 / AC-7(a)(b)(c) が使う。
 *
 * zone V / VI / VII を同時に含めるには CRS 側 bbox の膨張が要る（設計 §3.5.1 の不足量
 * 0.43° / 0.62°）。これは「候補が得られるように緩めた」のではなく、**隣接 zone を候補に
 * 含めた探索という実運用でありうる設定を明示的に選んだ**ものである。
 */
function catalogWide(): Promise<ProjectedCrsInfo[]> {
  if (!catalogWidePromise) {
    catalogWidePromise = listProjectedCrsFromProjWasm({
      extent: KYOTO_EXTENT,
      area: 'Japan',
      onshoreOnly: true,
      bboxPaddingDeg: 0.7,
    });
  }
  return catalogWidePromise;
}

function pickById(rows: readonly ProjectedCrsInfo[], ids: readonly string[]): ProjectedCrsInfo[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const found = byId.get(id);
    if (found === undefined) throw new Error(`カタログ実結果に ${id} が存在しない`);
    return found;
  });
}

/*
 * adapter glue は Atlas の公開 adapter `createCandidateTransformer` を使う。Teiresias `src` には
 * 置かず、テストが注入するだけである（【C7】engine 直参照禁止）。
 *
 * 挙動: `geoBasis` が `lonlat_deg` / lon-lat 順でなければ `null`（黙って誤変換せず、契約 (7)
 * 「業務的変換不能」へ落とす）、知らない id は `null`、それ以外は
 * `transformLonLatArrayToProjected` の結果。実装側の失敗は `null` ではなく throw で伝わる
 * （契約 (7)「throw は adapter bug のときだけ」）。
 */

// ---------------------------------------------------------------------------
// GCP セットの構成（設計 §5.3 / K8）
// ---------------------------------------------------------------------------

interface GcpSets {
  /** 反射なし（y 上向き）。 */
  forward: Array<{ pixel: [number, number]; geo: [number, number] }>;
  /** 反射あり（y 下向き = 走査地図 world file の通常形）。 */
  reflected: Array<{ pixel: [number, number]; geo: [number, number] }>;
  /** 真値 CRS における投影座標（実 engine の出力）。 */
  truthProjected: Array<[number, number]>;
}

let gcpSetsPromise: Promise<GcpSets> | undefined;

function gcpSets(): Promise<GcpSets> {
  if (!gcpSetsPromise) {
    gcpSetsPromise = (async (): Promise<GcpSets> => {
      const [truth] = pickById(await catalogWide(), [TRUE_ID]);
      const projected = await transformLonLatArrayToProjected(truth, GCP_LONLAT);
      if (projected === null) throw new Error('真値 CRS への変換が null を返した');

      const [e0, n0] = projected[0];
      const forward = GCP_LONLAT.map((geo, index): { pixel: [number, number]; geo: [number, number] } => ({
        pixel: [
          (projected[index][0] - e0) / METERS_PER_PIXEL,
          (projected[index][1] - n0) / METERS_PER_PIXEL,
        ],
        geo: [geo[0], geo[1]],
      }));
      const reflected = forward.map(({ pixel, geo }): { pixel: [number, number]; geo: [number, number] } => ({
        pixel: [pixel[0], -pixel[1]],
        geo,
      }));
      return { forward, reflected, truthProjected: projected };
    })();
  }
  return gcpSetsPromise;
}

// ---------------------------------------------------------------------------
// 反射判定 helper（設計 §5.6。本ファイル内の非 export helper）
// ---------------------------------------------------------------------------

type ReflectionVerdict = 'reflected' | 'forward' | 'undetermined';

interface ReflectionReport {
  verdict: ReflectionVerdict;
  reflect: number;
  forward: number;
  degenerate: number;
  disagreementRatio: number | null;
}

type Point2 = readonly [number, number];

/**
 * 3 点の共分散行列の固有値比 `λ2/λ1`。
 *
 * `Daedalus/src/fitting/similarity.ts:228-250` と**同形**の再実装である（import しない —
 * 当該量は `@c4h/daedalus` の公開 export に無く、`Daedalus/src` 直参照は AC-T2 の禁止
 * needle に該当し、Daedalus は m0 凍結である。設計 §5.6.4 / 案 F）。
 */
function eigRatio(a: Point2, b: Point2, c: Point2): number {
  const points = [a, b, c];
  const n = points.length;
  const meanX = (a[0] + b[0] + c[0]) / n;
  const meanY = (a[1] + b[1] + c[1]) / n;

  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    suu += dx * dx;
    svv += dy * dy;
    suv += dx * dy;
  }
  suu /= n;
  svv /= n;
  suv /= n;

  const trace = suu + svv;
  const det = suu * svv - suv * suv;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  const lambda1 = (trace + discriminant) / 2;
  const lambda2 = (trace - discriminant) / 2;

  if (lambda1 <= 0) return 0;
  return lambda2 / lambda1;
}

/** 靴紐公式による符号付き面積の 2 倍（`(b-a) × (c-a)`）。 */
function signedArea2(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * 三角形の部分集合（設計 §5.6.3・K14）。
 *
 * `n <= 12` は `C(n,3)` の全組合せ（標本の選び方という自由度そのものを消せる）。
 * 超えるときは辞書式列挙を決定的に間引く（乱数は使わない）。
 */
function triangleIndices(n: number): Array<[number, number, number]> {
  const total = (n * (n - 1) * (n - 2)) / 6;
  const limit = 220; // = C(12,3)。境界で挙動が跳ばないように合わせてある
  const stride = total <= limit ? 1 : Math.ceil(total / limit);

  const all: Array<[number, number, number]> = [];
  let ordinal = 0;
  for (let i = 0; i < n - 2; i += 1) {
    for (let j = i + 1; j < n - 1; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        if (ordinal % stride === 0 && all.length < limit) all.push([i, j, k]);
        ordinal += 1;
      }
    }
  }
  return all;
}

/**
 * 符号付き面積の符号一致・不一致を三角形ごとに数え、多数決で反射を判定する。
 *
 * 原理: affine 写像 `p ↦ Mp + t` のもとで任意の多角形の符号付き面積は厳密に `det(M)` 倍される
 * ∴ `sign(面積_geo) = sign(det M) · sign(面積_pixel)`。点順序は任意でよく、自己交差していても
 * 成立し、フィッティング不要で `O(n³)`（三角形数）。
 *
 * 縮退閾値は Daedalus の `DEFAULT_COLLINEARITY_THRESHOLD` と**同じ量・同じ値**（`0.01`）を
 * 使い、新しい閾値語彙を作らない（設計 K15）。pixel 側・投影側の**両側**を見る（`min`）。
 */
function judgeReflection(
  pixels: readonly Point2[],
  geos: readonly Point2[],
  tau = 0.01,
): ReflectionReport {
  let reflect = 0;
  let forward = 0;
  let degenerate = 0;

  for (const [i, j, k] of triangleIndices(pixels.length)) {
    const qP = eigRatio(pixels[i], pixels[j], pixels[k]);
    const qG = eigRatio(geos[i], geos[j], geos[k]);
    if (Math.min(qP, qG) <= tau) {
      degenerate += 1;
      continue;
    }
    const aP = signedArea2(pixels[i], pixels[j], pixels[k]);
    const aG = signedArea2(geos[i], geos[j], geos[k]);
    if (Math.sign(aP) !== Math.sign(aG)) reflect += 1;
    else forward += 1;
  }

  const verdict: ReflectionVerdict =
    reflect > forward ? 'reflected' : forward > reflect ? 'forward' : 'undetermined';
  const decided = reflect + forward;

  return {
    verdict,
    reflect,
    forward,
    degenerate,
    disagreementRatio: decided === 0 ? null : Math.min(reflect, forward) / decided,
  };
}

// ---------------------------------------------------------------------------
// 数値 assert の共通 helper
// ---------------------------------------------------------------------------

/** 相対 tolerance での一致（tolerance は §3.5.4 の行ごとに違う ∴ 呼出側が必ず渡す）。 */
function expectRelativeClose(actual: number, expected: number, relativeTolerance: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relativeTolerance);
}

/**
 * 2 つの点列の「最大差」（点ごとのユークリッド距離の最大値・m）。
 *
 * 設計 §3.5.1 / AC-14 の `13.639282286267992` m はこの定義で測られている
 * （成分ごとの最大差では `12.931680195499212` m になり別の量になる。実装時に両方を測って
 * 設計時プローブ値を全桁再現する側を採った）。
 */
function maxPointDistance(
  left: ReadonlyArray<readonly [number, number]>,
  right: ReadonlyArray<readonly [number, number]>,
): number {
  let max = 0;
  for (let index = 0; index < left.length; index += 1) {
    max = Math.max(max, Math.hypot(left[index][0] - right[index][0], left[index][1] - right[index][1]));
  }
  return max;
}

function rmsOf(result: EstimationResult, id: string): number {
  const found = result.ranked.find((entry) => `${entry.authority}:${entry.code}` === id);
  if (found === undefined) throw new Error(`ranked に ${id} が無い`);
  return found.rmsMeters;
}

function rankedIds(result: EstimationResult): string[] {
  return result.ranked.map((entry) => `${entry.authority}:${entry.code}`);
}

// ---------------------------------------------------------------------------
// AC-6 / AC-1(b): 実 engine E2E
// ---------------------------------------------------------------------------

describe('m2a-t1/AC-6: 実 engine を注入した estimateCrs（反射なしセット）', () => {
  it('絞り込み前にカタログ実結果そのものを固定する（候補が消えた回帰を別失敗として捉える）', async () => {
    const wide = await catalogWide();
    const wideIds = new Set(wide.map((info) => info.id));
    expect(REQUIRED_IDS.filter((id) => !wideIds.has(id))).toEqual([]);
    expect(wide).toHaveLength(13);

    const byDefault = await catalogDefault();
    expect(byDefault.map((info) => info.id).sort()).toEqual([
      'EPSG:2448',
      'EPSG:30166',
      'EPSG:3094',
      'EPSG:6674',
      'ESRI:112206',
    ]);
  });

  it('真値 EPSG:6674 が ranked[0] であり、untransformableIds が空である', async () => {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const { forward } = await gcpSets();

    const result = await estimateCrs(forward, candidates, {
      transformer: createCandidateTransformer(candidates),
    });

    expect(result.untransformableIds).toEqual([]);
    expect(result.ranked).toHaveLength(3);
    expect(rankedIds(result)[0]).toBe(TRUE_ID);

    // AC-1(b): 実行時 identity 往復（Atlas の ProjectedCrsInfo.id と一致する）
    expect(result.selected).not.toBeNull();
    const selected = result.selected as NonNullable<EstimationResult['selected']>;
    expect(`${selected.identity.authority}:${selected.identity.code}`).toBe(TRUE_ID);
    expect(candidates.some((info) => info.id === TRUE_ID)).toBe(true);
  });

  it('候補入力順を反転しても ranked は不変である（決定性）', async () => {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const { forward } = await gcpSets();

    const straight = await estimateCrs(forward, candidates, {
      transformer: createCandidateTransformer(candidates),
    });
    const reversed = await estimateCrs(forward, [...candidates].reverse(), {
      transformer: createCandidateTransformer(candidates),
    });

    expect(rankedIds(reversed)).toEqual(rankedIds(straight));
    expect(reversed.ranked.map((entry) => entry.rmsMeters)).toEqual(
      straight.ranked.map((entry) => entry.rmsMeters),
    );
  });

  it('ProjectedCrsInfo をそのまま CandidateCrs として渡せる（受取契約の実行時側）', async () => {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const asCandidates: readonly CandidateCrs[] = candidates;
    expect(asCandidates.map((c) => `${c.authority}:${c.code}`)).toEqual([...REQUIRED_IDS]);
  });
});

// ---------------------------------------------------------------------------
// AC-7: 反射を含む実 GCP セットでの候補間相対順位（実測固定。K22）
// ---------------------------------------------------------------------------

describe('AC-7: 実測固定・正規化なし（direct-only） — 反射が候補弁別に与える影響（期待仕様の表明ではない）', () => {
  /**
   * tolerance は**行ごとに違う**。設計 §3.5.4 の摂動感度表の当該行を転記する。
   * 一律の `1e-6` 相対ではない。表に無い値はテストへ焼かない（空欄＝未判定）。
   *
   * #1 AC-7(b-1) 反射なし `EPSG:6674` `rmsMeters`
   *   基準値 `7.321291122024597e-12` m / 変動源 1（実装間）`9.4553e-1`（相対）
   *   変動源 2（PROJ 感度・eps=1e-6 m）相対は**発散**・絶対で最大 `2.983364e-11` m
   *   必要 = 相対不可 ∴ 絶対 `3.0e-11` m / 採用 **`< 1e-6` m（絶対・上限のみ。値を焼かない）**
   *   下限余裕 **4.53 桁** / 上限余裕 7.0 桁（軸順取り違え ≈1e5 m / datum 取り違え 13.64 m）
   *   ∵ この値は入力座標の 1 ulp（`1.4552e-11` m）と同程度の桁落ち量であり、値ではなく
   *     **厳密適合であること**を検査している。相対 tolerance を置ける帯が存在しない。
   *
   * #2 AC-7(b-2) 反射なし `EPSG:6675`
   *   基準値 `3.5823637746029902e-1` m / 変動源 1 `0`（6 配置）/ 変動源 2 `5.3969e-6`
   *   必要 `5.4e-6` / 採用 **`1e-3` 相対** / 下限余裕 **2.27 桁**
   *   上限余裕 1.63 桁（`EPSG:6673` とは 43% 離れている ∴ 混同しない）
   *
   * #3 AC-7(b-2) 反射なし `EPSG:6673`
   *   基準値 `5.1172910876252709e-1` m / 変動源 1 `0` / 変動源 2 `3.7775e-6`
   *   必要 `3.8e-6` / 採用 **`1e-3` 相対** / 下限余裕 **2.42 桁** / 上限余裕 1.63 桁
   *
   * #4 AC-7(b-2) 反射あり `EPSG:6674`
   *   基準値 `1.5418504974201469e+4` m / 変動源 1 `1.1797e-16` / 変動源 2 `8.3376e-11`
   *   必要 `8.3e-11` / 採用 **`1e-6` 相対**（据置）/ 下限余裕 4.08 桁
   *   上限余裕 1.30 桁（候補取り違えは ≥2.0e-4 相対）
   *
   * #5 AC-7(b-2) 反射あり `EPSG:6673`
   *   基準値 `1.5421583164607415e+4` m / 変動源 1 `0` / 変動源 2 `9.8502e-11`
   *   必要 `9.9e-11` / 採用 **`1e-6` 相対** / 下限余裕 4.01 桁 / 上限余裕 1.30 桁
   *
   * #6 AC-7(b-2) 反射あり `EPSG:6675`
   *   基準値 `1.5421583165489425e+4` m / 変動源 1 `0` / 変動源 2 `9.8501e-11`
   *   必要 `9.9e-11` / 採用 **`1e-6` 相対** / 下限余裕 4.01 桁 / 上限余裕 1.30 桁
   *
   * #7 AC-7(a) 反射なし 2 位・3 位の相対差
   *   基準値 `2.9994918928e-1` / 変動源 1 `0` / 変動源 2 `2.1409e-5`（絶対 `6.4216e-6`）
   *   必要 `2.1e-5` / 採用 **閾値 `> 1e-2`**（据置）/ 下限余裕 1.48 桁 / 上限 対比 5 桁
   *
   * #8 AC-7(a) 反射あり 2 位・3 位の相対差
   *   基準値 `5.7193205290e-11` / 変動源 1 `0` / 変動源 2 絶対 `1.6315e-10` ∴ 最悪 `2.2034e-10`
   *   必要 `2.2e-10` / 採用 **閾値 `< 1e-7`** / 下限余裕 **2.66 桁**（旧 `1e-9` は 0.66 桁で不足）
   *
   * #9 AC-7(c) 反射なし 真値と次点の RMS 比
   *   基準値 `4.893077e+10` / 変動源 1 域 `[2.398886e+10, 4.403769e+11]`
   *   変動源 2 合成域 `[1.200778e+10, 4.403793e+11]` / 必要 最小 `1.2008e+10`
   *   採用 **閾値 `> 1e7`**（据置）/ 下限余裕 **3.08 桁** / 上限 対比 7 桁
   *
   * #10 AC-7(c) 反射あり 真値と次点の RMS 比
   *   基準値 `1.000199642599` / 変動源 1 `2.2200e-16` / 変動源 2 `1.6317e-10`
   *   必要 `1.6e-10` / 採用 **閾値 `< 1.001`**（据置）/ 下限余裕 **6.69 桁** / 上限 対比 7 桁
   *   ※ R4-MIN-3: 表 #10 は「次点を identity 固定」モデルである。rank ベース（実際に
   *     `ranked[1]` を次点に取る）で計算すると PROJ 感度は `1.8756e-10` となり、余裕は
   *     6.69 → **6.63 桁**へ動く。**閾値の判定は変わらない** ∴ 測り直さず脚注に留める。
   *
   * #11 AC-7(d) 反射あり 相対差 `EPSG:3094`
   *   基準値 `3.6120844592e-4` / 変動源 1 `6.5300e-13` / 変動源 2 `4.5172e-7`
   *   必要 `4.5e-7` / 採用 **`1e-3` 相対** / 下限余裕 **3.35 桁** / 上限余裕 2.5 桁
   *
   * #12 AC-7(d) 反射あり 相対差 `EPSG:30166`
   *   基準値 `1.1252316755e-4` / 変動源 1 `2.0967e-12` / 変動源 2 **`1.4503e-6`**
   *   必要 `1.5e-6` / 採用 **`1e-3` 相対**（旧 `1e-6` は **−0.16 桁**で不足していた）
   *   下限余裕 **2.84 桁** / 上限余裕 2.5 桁（2 値は互いに 69% 離れている ∴ 混同しない）
   */
  /**
   * 焼いてある値は**実 `estimateCrs` の出力を実装時に測ったもの**である（§14 implementer 6）。
   * 設計 §3.5.2 / §3.5.4 の値は Daedalus 本体を通していない設計時プローブだが、実測の結果
   * **全桁一致した**（差分そのものが診断情報になるため、一致したことも記録する）。
   *
   * assert しない観測値（K10 の観測義務。task-state へも転記する）:
   *   反射なし 真値と次点の RMS 比 = `48930765283.00024`（= `4.8930765283e+10`）
   *   反射あり 真値と次点の RMS 比 = `1.0001996425990132`
   *   反射なし 2 位・3 位の相対差   = `0.29994918928…`（表 #7 の基準値 `2.9994918928e-1` と一致）
   *   反射あり 2 位・3 位の相対差   = `5.7193205293576197e-11`（表 #8 の `5.7193205290e-11` と一致）
   *   反射あり / 反射なし の真値 RMS 劣化倍率 = `2105981679627254.5`（≈ `2.11e+15`）
   */
  const FORWARD_RMS_6674_UPPER_BOUND_METERS = 1e-6; // #1（絶対・上限のみ）
  const FORWARD_RMS_6675 = 0.358236377460299; // #2（実測）
  const FORWARD_RMS_6673 = 0.5117291087625271; // #3（実測）
  const REFLECTED_RMS_6674 = 15418.504974201469; // #4（実測）
  const REFLECTED_RMS_6673 = 15421.583164607415; // #5（実測）
  const REFLECTED_RMS_6675 = 15421.583165489425; // #6（実測）
  const NON_EXACT_FIT_RELATIVE_TOLERANCE = 1e-3; // #2 / #3
  const REFLECTED_RELATIVE_TOLERANCE = 1e-6; // #4 / #5 / #6
  const DEFAULT_CATALOG_RELATIVE_TOLERANCE = 1e-3; // #11 / #12
  const RELATIVE_DIFF_3094 = 0.0003612084459245531; // #11（実測）
  const RELATIVE_DIFF_30166 = 0.00011252316754670682; // #12（実測）

  async function runThreeSet(reflectedSet: boolean): Promise<EstimationResult> {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const sets = await gcpSets();
    return estimateCrs(reflectedSet ? sets.reflected : sets.forward, candidates, {
      transformer: createCandidateTransformer(candidates),
      chirality: 'direct-only',
    });
  }

  it('(b-1) 反射なしの真値は厳密適合であり、rmsMeters が 1e-6 m 未満である（値は焼かない）', async () => {
    const result = await runThreeSet(false);
    const rms = rmsOf(result, TRUE_ID);
    expect(rms).toBeGreaterThanOrEqual(0);
    expect(rms).toBeLessThan(FORWARD_RMS_6674_UPPER_BOUND_METERS);
  });

  it('(b-2) 反射なしの誤候補 2 件の rmsMeters を 1e-3 相対で固定する', async () => {
    const result = await runThreeSet(false);
    expectRelativeClose(rmsOf(result, 'EPSG:6675'), FORWARD_RMS_6675, NON_EXACT_FIT_RELATIVE_TOLERANCE);
    expectRelativeClose(rmsOf(result, 'EPSG:6673'), FORWARD_RMS_6673, NON_EXACT_FIT_RELATIVE_TOLERANCE);
  });

  it('(b-2) 反射ありの 3 候補の rmsMeters を 1e-6 相対で固定する', async () => {
    const result = await runThreeSet(true);
    expectRelativeClose(rmsOf(result, 'EPSG:6674'), REFLECTED_RMS_6674, REFLECTED_RELATIVE_TOLERANCE);
    expectRelativeClose(rmsOf(result, 'EPSG:6673'), REFLECTED_RMS_6673, REFLECTED_RELATIVE_TOLERANCE);
    expectRelativeClose(rmsOf(result, 'EPSG:6675'), REFLECTED_RMS_6675, REFLECTED_RELATIVE_TOLERANCE);
  });

  it('(a) 真値の ranked[0] のみ完全一致 assert し、残り 2 件は順不同集合として扱う', async () => {
    const forwardResult = await runThreeSet(false);
    const reflectedResult = await runThreeSet(true);

    expect(rankedIds(forwardResult)[0]).toBe(TRUE_ID);
    expect(rankedIds(forwardResult).slice(1).sort()).toEqual(['EPSG:6673', 'EPSG:6675']);
    expect(rankedIds(reflectedResult).slice(1).sort()).toEqual(['EPSG:6673', 'EPSG:6675']);
  });

  it('(a) 順位ではなく「2 位・3 位の相対差の桁」で現象を固定する（K16）', async () => {
    const forwardResult = await runThreeSet(false);
    const reflectedResult = await runThreeSet(true);

    // 「相対差」は設計 §3.5.2 / §3.5.4 #7 / #8 と同じ定義（差 ÷ 大きいほう = 3 位の値）を採る。
    // 実測: 反射なし 0.29994918928…（表 #7 の 2.9994918928e-1 と一致）/
    //       反射あり 5.7193205293576197e-11（表 #8 の 5.7193205290e-11 と一致）
    const relativeGap = (result: EstimationResult): number => {
      const second = result.ranked[1].rmsMeters;
      const third = result.ranked[2].rmsMeters;
      return Math.abs(third - second) / Math.max(Math.abs(second), Math.abs(third));
    };

    // 反射なしでは 2 位・3 位が頑健に分離する
    expect(relativeGap(forwardResult)).toBeGreaterThan(1e-2);
    // 反射ありでは識別力がほぼ消滅する（順位はもはや差では決まっていない）
    expect(relativeGap(reflectedResult)).toBeLessThan(1e-7);
  });

  it('(c) 真値と次点の RMS 比で識別力の消滅を捉える', async () => {
    const forwardResult = await runThreeSet(false);
    const reflectedResult = await runThreeSet(true);

    const ratio = (result: EstimationResult): number => {
      const sorted = [...result.ranked].sort((a, b) => a.rmsMeters - b.rmsMeters);
      return sorted[1].rmsMeters / sorted[0].rmsMeters;
    };

    expect(ratio(forwardResult)).toBeGreaterThan(1e7);
    expect(ratio(reflectedResult)).toBeLessThan(1.001);
  });

  it('(d) 既定カタログ 5 件を絞らずに使うと、反射ありで真値が ranked[0] から落ちる', async () => {
    const candidates = await catalogDefault();
    const sets = await gcpSets();
    const transformer = createCandidateTransformer(candidates);

    const reflectedResult = await estimateCrs(sets.reflected, candidates, { transformer, chirality: 'direct-only' });
    const forwardResult = await estimateCrs(sets.forward, candidates, { transformer, chirality: 'direct-only' });

    expect(reflectedResult.untransformableIds).toEqual([]);
    const reflectedIds = rankedIds(reflectedResult);
    expect(reflectedIds[0]).toBe('EPSG:3094');
    expect(reflectedIds[1]).toBe('EPSG:30166');
    // 真値は縮退クラスごと 3〜5 位へ落ちる
    expect(reflectedIds.slice(2).sort()).toEqual(['EPSG:2448', 'EPSG:6674', 'ESRI:112206']);

    // 真値クラスに対する相対差（1e-3 相対。#11 / #12）
    const truthClassRms = rmsOf(reflectedResult, TRUE_ID);
    expectRelativeClose(
      Math.abs(truthClassRms - rmsOf(reflectedResult, 'EPSG:3094')) / truthClassRms,
      RELATIVE_DIFF_3094,
      DEFAULT_CATALOG_RELATIVE_TOLERANCE,
    );
    expectRelativeClose(
      Math.abs(truthClassRms - rmsOf(reflectedResult, 'EPSG:30166')) / truthClassRms,
      RELATIVE_DIFF_30166,
      DEFAULT_CATALOG_RELATIVE_TOLERANCE,
    );

    // 反射なしでは真値が縮退クラス（ranked[0..2]）に入る
    expect(rankedIds(forwardResult).slice(0, 3).sort()).toEqual([
      'EPSG:2448',
      'EPSG:6674',
      'ESRI:112206',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-13: 反射判定の実 engine 成立性（実測固定。人間追加入力への回答）
// ---------------------------------------------------------------------------

describe('AC-13: 実測固定・正規化なし（direct-only） — 符号付き面積・部分集合多数決による反射判定', () => {
  /**
   * 判定結果は診断値であり、ranking にも AC-6 にも影響させない（設計 §5.6.1 / K13）。
   * 反射時の挙動を決めるのは m2b である。
   *
   * #18（§3.5.4）: `reflect` / `forward` / `degenerate` の内訳は離散量であり、
   *   変動源 1・2 とも `0`（面積の符号は `min|area2|` に対し摂動の寄与が `1e-9` 相対、
   *   縮退判定は `min(λ2/λ1)` が閾値 `0.01` から両側 1.34 桁以上離れている）
   *   ∴ **完全一致 assert**（tolerance を置かない）。上限余裕 7 桁。
   * #19（§3.5.4）: `disagreementRatio` は #18 の内訳から決まる有理数 ∴ 完全一致。
   */
  async function reportsFor(reflectedSet: boolean): Promise<Map<string, ReflectionReport>> {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const sets = await gcpSets();
    const gcps = reflectedSet ? sets.reflected : sets.forward;
    const pixels = gcps.map(({ pixel }) => pixel as Point2);

    const reports = new Map<string, ReflectionReport>();
    for (const candidate of candidates) {
      const projected = await transformLonLatArrayToProjected(candidate, GCP_LONLAT);
      if (projected === null) throw new Error(`${candidate.id} の変換が null`);
      reports.set(candidate.id, judgeReflection(pixels, projected as Point2[]));
    }
    return reports;
  }

  it('反射なしセットでは全候補が forward と判定される', async () => {
    const reports = await reportsFor(false);
    for (const id of REQUIRED_IDS) {
      const report = reports.get(id) as ReflectionReport;
      expect(report.verdict).toBe('forward');
      expect(report).toMatchObject({ reflect: 0, forward: 8, degenerate: 2, disagreementRatio: 0 });
    }
  });

  it('反射ありセットでは全候補が reflected と判定される（内訳は候補間で同一）', async () => {
    const reports = await reportsFor(true);
    for (const id of REQUIRED_IDS) {
      const report = reports.get(id) as ReflectionReport;
      expect(report.verdict).toBe('reflected');
      expect(report).toMatchObject({ reflect: 8, forward: 0, degenerate: 2, disagreementRatio: 0 });
    }
  });

  it('実 CRS 投影の非 affine 性は全会一致を崩さない（disagreementRatio が 0）', async () => {
    const forwardReports = await reportsFor(false);
    const reflectedReports = await reportsFor(true);
    for (const reports of [forwardReports, reflectedReports]) {
      for (const report of reports.values()) {
        expect(report.disagreementRatio).toBe(0);
      }
    }
  });

  it('verdict === reflected と真値候補の basic RMS 劣化が同時に起きる（対応関係）', async () => {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const sets = await gcpSets();
    const transformer = createCandidateTransformer(candidates);

    const forwardResult = await estimateCrs(sets.forward, candidates, { transformer, chirality: 'direct-only' });
    const reflectedResult = await estimateCrs(sets.reflected, candidates, { transformer, chirality: 'direct-only' });

    const reflectedReports = await reportsFor(true);
    expect((reflectedReports.get(TRUE_ID) as ReflectionReport).verdict).toBe('reflected');

    const degradation = rmsOf(reflectedResult, TRUE_ID) / rmsOf(forwardResult, TRUE_ID);
    expect(degradation).toBeGreaterThan(1e11);
  });

  it('判定は ranking へ影響しない（反射ありでも ranked は helper 非依存のまま）', async () => {
    const candidates = pickById(await catalogWide(), REQUIRED_IDS);
    const sets = await gcpSets();
    const transformer = createCandidateTransformer(candidates);
    const result = await estimateCrs(sets.reflected, candidates, { transformer, chirality: 'direct-only' });
    expect(result.ranked).toHaveLength(3);
    expect(result.untransformableIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-14: 縮退クラスの実測固定（K9 改訂）
// ---------------------------------------------------------------------------

describe('m2a-t1/AC-14: 実測固定 — PROJ-5 文字列が同一へ潰れる authority エントリ集合', () => {
  /**
   * #13（§3.5.4）: `EPSG:30166` との最大差 `13.639282286267992` m
   *   変動源 1 `0`（最小二乗を通らない差分）/ 変動源 2 `1.8582e-7` 相対（絶対 `2.5344e-6` m）
   *   必要 `1.9e-7` / 採用 **`1e-4` 相対** / 下限余裕 **2.73 桁**
   *   上限余裕 大（対立仮説は `0` m）∴ 完全一致 assert は偽 RED になる。
   *
   * #14（§3.5.4）: 縮退クラス内最大差 `0` m
   *   採用 **`toBe(0)`**（tolerance を置かない）。独立摂動の保守モデルでは `2.8284e-6` m
   *   動きうるが、同クラスの 3 者は `proj4` 文字列が**完全同一**である ∴
   *   `transformLonLatArrayToProjected` が同一引数で同一の純関数を呼び、差はどのビルドでも
   *   構造的に厳密 `0` である（§3.5.4 の脚注 †。相関が構造から言える唯一の行）。
   */
  const DIFF_TO_30166_METERS = 13.639282286267992; // #13
  const DEGENERATE_DIFF_RELATIVE_TOLERANCE = 1e-4; // #13

  it('既定カタログを proj4 でグループ化すると、要素 2 以上のクラスは 1 つだけである', async () => {
    const rows = await catalogDefault();
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = groups.get(row.proj4);
      if (bucket === undefined) groups.set(row.proj4, [row.id]);
      else bucket.push(row.id);
    }
    const degenerateClasses = [...groups.values()]
      .filter((ids) => ids.length >= 2)
      .map((ids) => [...ids].sort());

    expect(degenerateClasses).toEqual([['EPSG:2448', 'EPSG:6674', 'ESRI:112206']]);
  });

  it('同一クラス内の 3 者は変換結果が厳密に一致する（最大差 0 m。tolerance を置かない）', async () => {
    const rows = await catalogDefault();
    const members = pickById(rows, ['EPSG:2448', 'EPSG:6674', 'ESRI:112206']);
    const projected: Array<Array<[number, number]>> = [];
    for (const member of members) {
      const result = await transformLonLatArrayToProjected(member, GCP_LONLAT);
      expect(result).not.toBeNull();
      projected.push(result as Array<[number, number]>);
    }

    let maxDiff = 0;
    for (let i = 1; i < projected.length; i += 1) {
      maxDiff = Math.max(maxDiff, maxPointDistance(projected[0], projected[i]));
    }
    expect(maxDiff).toBe(0);
  });

  it('近縁だが同一でない EPSG:30166（ellipsoid だけ bessel）は同クラスに入らない', async () => {
    const rows = await catalogDefault();
    const [truth, bessel] = pickById(rows, ['EPSG:6674', 'EPSG:30166']);
    expect(truth.proj4).not.toBe(bessel.proj4);
    expect(truth.proj4).toContain('+ellps=GRS80');
    expect(bessel.proj4).toContain('+ellps=bessel');

    const a = (await transformLonLatArrayToProjected(truth, GCP_LONLAT)) as Array<[number, number]>;
    const b = (await transformLonLatArrayToProjected(bessel, GCP_LONLAT)) as Array<[number, number]>;
    expectRelativeClose(
      maxPointDistance(a, b),
      DIFF_TO_30166_METERS,
      DEGENERATE_DIFF_RELATIVE_TOLERANCE,
    );
  });
});

// ---------------------------------------------------------------------------
// chirality 正規化（既定）: 既定カタログで反射の有無によらず真値の縮退クラスが先頭を占める
// ---------------------------------------------------------------------------

describe('chirality 正規化（既定）: 実 engine・既定カタログ', () => {
  /** 候補のうち `proj4` が真値と一致するもの（真値の縮退クラス）。大きさは実行時に決まる。 */
  async function truthClass(rows: readonly ProjectedCrsInfo[]): Promise<string[]> {
    const [truth] = pickById(rows, [TRUE_ID]);
    return rows.filter((row) => row.proj4 === truth.proj4).map((row) => row.id).sort();
  }

  async function run(reflectedSet: boolean): Promise<{ result: EstimationResult; klass: string[] }> {
    const candidates = await catalogDefault();
    const sets = await gcpSets();
    const result = await estimateCrs(reflectedSet ? sets.reflected : sets.forward, candidates, {
      transformer: createCandidateTransformer(candidates),
    });
    return { result, klass: await truthClass(candidates) };
  }

  it('反射なし: 真値の縮退クラスが ranked[0..k-1] と集合として一致し、EPSG:6674 を含む', async () => {
    const { result, klass } = await run(false);
    expect(klass).toContain(TRUE_ID);
    expect(rankedIds(result).slice(0, klass.length).sort()).toEqual(klass);
    expect(result.selected?.worldFile.yScale as number).toBeGreaterThan(0);
  });

  it('反射あり: 真値の縮退クラスが ranked[0..k-1] と集合として一致し、EPSG:6674 を含み、yScale が負', async () => {
    const { result, klass } = await run(true);
    expect(result.untransformableIds).toEqual([]);
    expect(klass).toContain(TRUE_ID);
    expect(rankedIds(result).slice(0, klass.length).sort()).toEqual(klass);
    expect(result.selected?.worldFile.yScale as number).toBeLessThan(0);
  });

  it('反射ありの ranked の rmsMeters は反射なしの値と相対 1e-9 以内で一致する', async () => {
    const forward = await run(false);
    const reflected = await run(true);
    expect(rankedIds(reflected.result)).toEqual(rankedIds(forward.result));
    for (const entry of forward.result.ranked) {
      const id = `${entry.authority}:${entry.code}`;
      const a = rmsOf(reflected.result, id);
      expect(Math.abs(a - entry.rmsMeters)).toBeLessThanOrEqual(1e-9 * Math.max(1, entry.rmsMeters));
    }
  });
});
