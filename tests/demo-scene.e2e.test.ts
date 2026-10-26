/**
 * デモの**現象**を実 Atlas engine で固定する E2E（m3-t1 設計 v1.3 §9.1 / m3-t1/AC-5）。
 *
 * 対応 AC（設計 §9.1 の m3-t1/AC-5 の (a)〜(e)）:
 * - (a) 反射なしで真値 `EPSG:6674` が `ranked[0]`
 * - (b) 反射なしの `rms[2位]/rms[1位]` が `1e6` を超える
 * - (c) 反射ありで同比が `1.01` 未満に落ちる（= 識別力が潰れる）
 * - (d) 既定カタログ + 反射ありで真値が `ranked[0]` から外れる
 *
 * (c)(d) はデモの「反射を吸収する」を外した側（`chirality: 'direct-only'`）の固定である。
 * 正規化あり（既定）の側は (c')(d') が固定する — 反射の有無によらず真値の縮退クラスが上位を
 * 占め、選ばれた world file の `yScale` の符号だけが分かれる。
 * - (e) GCP を 1 点だけ動かすと `ranked` の並びまたは `rmsMeters` が変わる
 *
 * **デモの画面に出る数値そのものは固定しない**（GCP を動かせば値は変わるのが正しい）。
 * 固定するのは**現象**であり、閾値は `estimate-crs.real-engine.e2e.test.ts` の摂動感度表
 * （#9 `> 1e7` / #10 `< 1.001`）より**緩い側**に置いてある ∴ 同じ実測から導かれる。
 *
 * 本ファイルは `demo/estimate-scene.js`（純関数）と `demo/atlas-engine.js`（engine adapter）
 * を**実際に呼ぶ**。実コードのロジックをテスト内で再現しない。
 * `loadEngine()` だけは呼ばない — proj-wasm の asset base URL 解決が `document.baseURI` に
 * 依存する browser 専用経路であり、Node では Atlas 側が自前で初期化するためである
 * （`Atlas/src/proj-wasm-crs.ts` の `installProjWasmAssetResolver` は browser 判定で早期 return する）。
 */
import { describe, expect, it } from 'vitest';

import { loadCandidates, makeTransformer, projectTruth } from '../demo/atlas-engine.js';
import {
  COLLAPSE_THRESHOLD,
  GCP_LONLAT,
  METERS_PER_PIXEL,
  TRUE_ID,
  basePixelsFromProjected,
  discriminationOf,
  runScene,
} from '../demo/estimate-scene.js';

const geoPoints = GCP_LONLAT.map((point) => [point[0], point[1]] as [number, number]);

interface SceneInput {
  mode: 'zones' | 'catalog';
  yFlip: boolean;
  chirality?: 'normalize' | 'direct-only';
  mutate?: (pixels: Array<[number, number]>) => void;
}

const cache = new Map<string, Promise<{ candidates: unknown[]; basePixels: Array<[number, number]> }>>();

function contextFor(mode: 'zones' | 'catalog') {
  if (!cache.has(mode)) {
    cache.set(
      mode,
      (async () => {
        const candidates = await loadCandidates(mode);
        const projected = await projectTruth(candidates);
        return { candidates, basePixels: basePixelsFromProjected(projected, METERS_PER_PIXEL) };
      })(),
    );
  }
  return cache.get(mode)!;
}

async function scene({ mode, yFlip, chirality, mutate }: SceneInput) {
  const { candidates, basePixels } = await contextFor(mode);
  const pixels = basePixels.map((point) => [point[0], point[1]] as [number, number]);
  mutate?.(pixels);
  return runScene({
    pixels,
    geoPoints,
    yFlip,
    chirality,
    candidates,
    transformer: makeTransformer(candidates as never),
  });
}

describe('m3-t1/AC-5: デモの現象を実 Atlas engine で固定する', () => {
  it('(a) 反射なしで真値 EPSG:6674 が ranked[0] である', async () => {
    const result = await scene({ mode: 'zones', yFlip: false });
    expect(result.ranked.length).toBeGreaterThanOrEqual(2);
    expect(result.ranked[0].id).toBe(TRUE_ID);
    expect(result.ranked[0].isTruth).toBe(true);
    expect(result.untransformableIds).toEqual([]);
  }, 30_000);

  it('(b) 反射なしの rms[2位]/rms[1位] が 1e6 を超える（識別できている）', async () => {
    const result = await scene({ mode: 'zones', yFlip: false });
    const { ratio, collapsed } = result.discrimination;
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeGreaterThan(1e6);
    expect(collapsed).toBe(false);
  }, 30_000);

  it('(c) 正規化なし（direct-only）: 反射ありで同じ比が 1.01 未満へ落ちる（識別力が潰れる）', async () => {
    const result = await scene({ mode: 'zones', yFlip: true, chirality: 'direct-only' });
    const { ratio, collapsed } = result.discrimination;
    expect(ratio).not.toBeNull();
    expect(ratio as number).toBeLessThan(COLLAPSE_THRESHOLD);
    expect(collapsed).toBe(true);
  }, 30_000);

  it('(d) 正規化なし（direct-only）: 既定カタログ + 反射ありでは真値が ranked[0] から外れる', async () => {
    const reflected = await scene({ mode: 'catalog', yFlip: true, chirality: 'direct-only' });
    const forward = await scene({ mode: 'catalog', yFlip: false, chirality: 'direct-only' });

    expect(reflected.ranked.length).toBeGreaterThan(3);
    expect(reflected.ranked[0].id).not.toBe(TRUE_ID);
    expect(reflected.ranked.some((entry) => entry.isTruth)).toBe(true);
    // 反射なしでは真値が縮退クラスごと先頭 3 件に入る（対照）
    expect(forward.ranked.slice(0, 3).some((entry) => entry.isTruth)).toBe(true);
  }, 30_000);

  it("(c') 正規化あり（既定）: 反射ありでも真値が ranked[0] で識別できていて、yScale が負", async () => {
    const result = await scene({ mode: 'zones', yFlip: true });
    expect(result.ranked[0].id).toBe(TRUE_ID);
    expect(result.discrimination.collapsed).toBe(false);
    expect(result.selected?.worldFile.yScale as number).toBeLessThan(0);
  }, 30_000);

  it("(d') 正規化あり（既定）: 既定カタログで y の向きによらず真値が先頭 3 件に入り、yScale の符号だけが分かれる", async () => {
    const reflected = await scene({ mode: 'catalog', yFlip: true });
    const forward = await scene({ mode: 'catalog', yFlip: false });
    expect(reflected.ranked.map((entry) => entry.id)).toEqual(forward.ranked.map((entry) => entry.id));
    expect(reflected.ranked.slice(0, 3).some((entry) => entry.isTruth)).toBe(true);
    expect(forward.selected?.worldFile.yScale as number).toBeGreaterThan(0);
    expect(reflected.selected?.worldFile.yScale as number).toBeLessThan(0);
  }, 30_000);

  it('(e) GCP を 1 点だけ動かすと ranked の並びまたは rmsMeters が変わる', async () => {
    const base = await scene({ mode: 'zones', yFlip: false });
    const moved = await scene({
      mode: 'zones',
      yFlip: false,
      mutate: (pixels) => {
        pixels[0] = [pixels[0][0] + 120, pixels[0][1] - 80];
      },
    });

    const baseOrder = base.ranked.map((entry) => entry.id);
    const movedOrder = moved.ranked.map((entry) => entry.id);
    const baseRms = base.ranked.map((entry) => entry.rmsMeters);
    const movedRms = moved.ranked.map((entry) => entry.rmsMeters);

    const orderChanged = JSON.stringify(baseOrder) !== JSON.stringify(movedOrder);
    const rmsChanged = JSON.stringify(baseRms) !== JSON.stringify(movedRms);
    expect(orderChanged || rmsChanged).toBe(true);
  }, 30_000);
});

describe('m3-t1/AC-5: discriminationOf の境界（純関数側）', () => {
  it('候補が 1 件以下なら ratio / collapsed は null（判定不能を偽で表さない）', () => {
    expect(discriminationOf([])).toMatchObject({ ratio: null, collapsed: null });
    expect(discriminationOf([{ rmsMeters: 1 }])).toMatchObject({ ratio: null, collapsed: null });
  });

  it('1 位が厳密適合（0 m）なら ratio は Infinity である（0 除算を作らない）', () => {
    const report = discriminationOf([{ rmsMeters: 0 }, { rmsMeters: 3 }]);
    expect(report.ratio).toBe(Infinity);
    expect(report.collapsed).toBe(false);
  });

  it('閾値のすぐ下は collapsed、すぐ上は not collapsed である（検査が実際に発火する）', () => {
    expect(discriminationOf([{ rmsMeters: 1 }, { rmsMeters: COLLAPSE_THRESHOLD - 1e-6 }]).collapsed).toBe(true);
    expect(discriminationOf([{ rmsMeters: 1 }, { rmsMeters: COLLAPSE_THRESHOLD + 1e-6 }]).collapsed).toBe(false);
  });
});
