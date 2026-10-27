/**
 * scripts/consumer-smoke.mjs の場面の判定を、合成した結果で両向きに確かめる。
 * 流れ自体（tarball を空のディレクトリへ入れて推定する）は CI の `pnpm run smoke:consumer` が流す。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- 型宣言の無い .mjs を読む
import { SCENES, TIME_LIMIT_MS, cleanupConsumerDir, pnpm, remainingMs } from '../scripts/consumer-smoke.mjs';

type Row = { id: string; proj4: string };
type Ranked = { authority: string; code: string };
type Selected = {
  worldFile: { yScale: number };
  unit: { name: string; metresPerUnit: number };
};
type Scene = {
  id: string;
  truthId: string;
  pixelSpec: { metresPerPixel: number; yDown: boolean };
  check: (
    result: { ranked: Ranked[]; selected: Selected | null },
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
const metreUnit = { name: 'metre', metresPerUnit: 1 };
const ranked = (ids: string[]): Ranked[] =>
  ids.map((id) => {
    const [authority, code] = id.split(':');
    return { authority, code };
  });

describe('consumer-smoke の打ち切りと後始末', () => {
  it('残り時間は全体の上限から経過分を引いた値になる', () => {
    expect(remainingMs(0, TIME_LIMIT_MS)).toBe(0);
    expect(remainingMs(0, TIME_LIMIT_MS + 1)).toBe(-1);
    expect(remainingMs(0, 0)).toBe(TIME_LIMIT_MS);
  });

  it('pnpm の呼び出しに残り時間を timeout として渡す（pack も install も同じ経路）', () => {
    const calls: Array<{ file: string; args: string[]; options: { cwd: string; timeout: number } }> = [];
    const run = (file: string, args: string[], options: { cwd: string; timeout: number }): void => {
      calls.push({ file, args, options });
    };
    pnpm(['pack'], '/work/Atlas', Date.now(), run as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('pnpm');
    expect(calls[0].args).toEqual(['pack']);
    expect(calls[0].options.cwd).toBe('/work/Atlas');
    expect(calls[0].options.timeout).toBeGreaterThan(0);
    expect(calls[0].options.timeout).toBeLessThanOrEqual(TIME_LIMIT_MS);
  });

  it('残り時間が無ければ pnpm を起動せずに打ち切りエラーにする', () => {
    const run = (): void => {
      throw new Error('must not run');
    };
    expect(() => pnpm(['install'], '/work/consumer', Date.now() - TIME_LIMIT_MS - 1, run as never)).toThrow(
      /timed out after 300 s/,
    );
  });

  it('pnpm 自身の時間切れも打ち切りと同じ扱いにする', () => {
    const run = (): void => {
      const error = new Error('spawnSync pnpm ETIMEDOUT') as Error & { code?: string };
      error.code = 'ETIMEDOUT';
      throw error;
    };
    expect(() => pnpm(['pack'], '/work/Atlas', Date.now(), run as never)).toThrow(/timed out after 300 s/);
  });

  it('成功したときだけ一時ディレクトリを消し、失敗したときは残す', () => {
    const removed = mkdtempSync(join(tmpdir(), 'teiresias-consumer-test-'));
    writeFileSync(join(removed, 'marker'), 'x');
    cleanupConsumerDir(removed, true);
    expect(existsSync(removed)).toBe(false);

    const kept = mkdtempSync(join(tmpdir(), 'teiresias-consumer-test-'));
    writeFileSync(join(kept, 'marker'), 'x');
    cleanupConsumerDir(kept, false);
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(join(kept, 'marker'), 'utf8')).toBe('x');
    rmSync(kept, { recursive: true, force: true });
  });

  it('本体の成功判定で後始末を呼ぶ（script 本文）', () => {
    const source = readFileSync(new URL('../scripts/consumer-smoke.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/cleanupConsumerDir\(dir, outcome\.ok === true\)/);
  });
});

describe('consumer-smoke の場面', () => {
  it('(a)〜(c) は metre の真値で (a) だけ y 上向き、(d) は格子の単位の真値で y 下向き', () => {
    expect(scenes.map((s) => s.id)).toEqual([
      'a-y-up',
      'b-y-down',
      'c-y-down-yscale-negative',
      'd-utjcp-y-down',
    ]);
    expect(byId('a-y-up').pixelSpec.yDown).toBe(false);
    expect(byId('b-y-down').pixelSpec.yDown).toBe(true);
    expect(byId('c-y-down-yscale-negative').pixelSpec.yDown).toBe(true);
    expect(byId('d-utjcp-y-down').pixelSpec.yDown).toBe(true);
    for (const scene of scenes.filter((s) => s.id !== 'd-utjcp-y-down')) {
      expect(scene.truthId).toBe('EPSG:6674');
    }
    expect(byId('d-utjcp-y-down').truthId).toBe('UTJCP:ZONE-B');
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
    expect(scene.check({ ranked: [], selected: { worldFile: { yScale: -0.5 }, unit: metreUnit } }, candidates).ok).toBe(
      true,
    );
    expect(scene.check({ ranked: [], selected: { worldFile: { yScale: 0.5 }, unit: metreUnit } }, candidates).ok).toBe(
      false,
    );
    expect(scene.check({ ranked: [], selected: null }, candidates).ok).toBe(false);
  });

  it('(d) は ranked[0] が格子の候補で selected.unit が yard のときだけ真', () => {
    const scene = byId('d-utjcp-y-down');
    const yardUnit = { name: 'yard (Japan City Plans)', metresPerUnit: 0.9143985307444408 };
    const selected = { worldFile: { yScale: -10 }, unit: yardUnit };
    const onTop = ranked(['UTJCP:ZONE-B', 'EPSG:6674']);

    const verdict = scene.check({ ranked: onTop, selected }, candidates);
    expect(verdict.ok).toBe(true);
    // reason には両方の実値を入れる（どちらが外れたかを 1 行で分かるようにする）
    expect(verdict.reason).toContain('UTJCP:ZONE-B');
    expect(verdict.reason).toContain('0.9143985307444408');

    expect(scene.check({ ranked: ranked(['EPSG:6674', 'UTJCP:ZONE-B']), selected }, candidates).ok).toBe(false);
    expect(scene.check({ ranked: onTop, selected: { worldFile: { yScale: -10 }, unit: metreUnit } }, candidates).ok).toBe(
      false,
    );
    expect(scene.check({ ranked: [], selected: null }, candidates).ok).toBe(false);
  });
});
