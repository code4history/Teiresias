/**
 * scripts/consumer-smoke.mjs の場面の判定を、合成した結果で両向きに確かめる。
 * 流れ自体（tarball を空のディレクトリへ入れて推定する）は CI の `pnpm run smoke:consumer` が流す。
 */
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 型宣言の無い .mjs を読む
import { SCENES } from '../scripts/consumer-smoke.mjs';

type Row = { id: string; proj4: string };
type Ranked = { authority: string; code: string };
type Scene = {
  id: string;
  truthId: string;
  pixelSpec: { metresPerPixel: number; yDown: boolean };
  check: (
    result: { ranked: Ranked[]; selected: { worldFile: { yScale: number } } | null },
    candidates: Row[],
  ) => { ok: boolean; reason: string; k?: number };
};

const scenes = SCENES as Scene[];
const byId = (id: string): Scene => {
  const scene = scenes.find((s) => s.id === id);
  if (scene === undefined) throw new Error(`no scene ${id}`);
  return scene;
};

const candidates: Row[] = [
  { id: 'EPSG:2448', proj4: 'same' },
  { id: 'EPSG:30166', proj4: 'other-1' },
  { id: 'EPSG:3094', proj4: 'other-2' },
  { id: 'EPSG:6674', proj4: 'same' },
  { id: 'ESRI:112206', proj4: 'same' },
];
const ranked = (ids: string[]): Ranked[] =>
  ids.map((id) => {
    const [authority, code] = id.split(':');
    return { authority, code };
  });

describe('consumer-smoke の場面', () => {
  it('(a)(b)(c) の 3 場面を持ち、(a) は y 上向き・(b)(c) は y 下向き', () => {
    expect(scenes.map((s) => s.id)).toEqual(['a-y-up', 'b-y-down', 'c-y-down-yscale-negative']);
    expect(byId('a-y-up').pixelSpec.yDown).toBe(false);
    expect(byId('b-y-down').pixelSpec.yDown).toBe(true);
    expect(byId('c-y-down-yscale-negative').pixelSpec.yDown).toBe(true);
    for (const scene of scenes) expect(scene.truthId).toBe('EPSG:6674');
  });

  it('上位 k 件が縮退クラスと一致すれば真で、k は実行時に数える', () => {
    const verdict = byId('a-y-up').check(
      { ranked: ranked(['ESRI:112206', 'EPSG:6674', 'EPSG:2448', 'EPSG:3094', 'EPSG:30166']), selected: null },
      candidates,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.k).toBe(3);
  });

  it('上位 k 件にクラスの外の候補が混ざれば偽', () => {
    const verdict = byId('b-y-down').check(
      { ranked: ranked(['EPSG:3094', 'EPSG:30166', 'EPSG:2448', 'EPSG:6674', 'ESRI:112206']), selected: null },
      candidates,
    );
    expect(verdict.ok).toBe(false);
  });

  it('真値が候補に無ければ偽', () => {
    const verdict = byId('a-y-up').check({ ranked: ranked(['EPSG:2448']), selected: null }, [
      { id: 'EPSG:2448', proj4: 'same' },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('(c) は selected の yScale が負のときだけ真', () => {
    const scene = byId('c-y-down-yscale-negative');
    expect(scene.check({ ranked: [], selected: { worldFile: { yScale: -0.5 } } }, candidates).ok).toBe(true);
    expect(scene.check({ ranked: [], selected: { worldFile: { yScale: 0.5 } } }, candidates).ok).toBe(false);
    expect(scene.check({ ranked: [], selected: null }, candidates).ok).toBe(false);
  });
});
