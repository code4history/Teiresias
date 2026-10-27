/**
 * デモのプリセットの A と B で出力が分かれることを、実 Atlas engine で固定する E2E。
 *
 * 対応する受け入れ条件:
 * - `place`: A（京都）の上位の縮退クラス（`proj4` が真値と一致する候補）と B（東京）の
 *   縮退クラスが交わらず、それぞれの真値を含む
 * - `y-direction`: A・B の上位 k 件が同じ集合で真値を含み、`selected.worldFile.yScale` の
 *   符号だけが逆になる
 * - `normalization`: A（正規化あり）は真値の組が上位で `collapsed` が偽（比べた相手が
 *   真値の組の外）、B（正規化なし）は `ranked[0]` が真値の組の外で `collapsed` が真
 *
 * 比の値と件数は**実行時に出す**（テストの期待値に焼かない — 候補の件数も残差も環境で動く）。
 * 本ファイルは `demo/presets.js`（プリセットの値）と `demo/scenes.js`（場面の値）を import し、
 * `demo/estimate-scene.js`（計算）・`demo/atlas-engine.js`（engine 接続）を実際に呼ぶ
 * （入力の値や CRS の ID を本ファイルへ書き写さない）。`loadEngine()` は呼ばない
 * （proj-wasm の asset URL 解決が browser 専用経路であるため。`tests/demo-scene.e2e.test.ts` と同じ）。
 */
import { describe, expect, it, vi } from 'vitest';

import { loadCandidates, makeTransformer, projectTruth } from '../demo/atlas-engine.js';
import { METERS_PER_PIXEL, basePixelsFromProjected, runScene } from '../demo/estimate-scene.js';
import { findPreset } from '../demo/presets.js';
import { scenes } from '../demo/scenes.js';

import { REAL_ENGINE_TEST_TIMEOUT_MS } from './fixtures/timeouts.js';

// 実 engine の初回のカタログ読み込み（proj.db の展開）は最初に呼んだテストが払う（値と決め方は
// tests/fixtures/timeouts.ts）。
vi.setConfig({ testTimeout: REAL_ENGINE_TEST_TIMEOUT_MS });

function optionOf(presetId: string, optionId: string) {
  const option = findPreset(presetId, optionId);
  if (option === undefined) throw new Error(`プリセット ${presetId}:${optionId} が無い`);
  return option;
}

type CandidateRows = ReadonlyArray<{ id: string; proj4?: string }>;

const cache = new Map<string, Promise<{ candidates: CandidateRows; basePixels: Array<[number, number]> }>>();

/** 場面と候補の集め方ごとに、候補と pixel 格子を 1 回だけ作る。 */
function contextFor(option: ReturnType<typeof optionOf>) {
  const key = `${option.input.scene}:${option.input.candidateMode}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async () => {
        const candidates = (await loadCandidates(option.input.candidateMode, option.scene)) as CandidateRows;
        const projected = await projectTruth(candidates, option.scene);
        return {
          candidates,
          basePixels: basePixelsFromProjected(projected, METERS_PER_PIXEL) as Array<[number, number]>,
        };
      })(),
    );
  }
  return cache.get(key)!;
}

/** プリセットの 1 側を計算する（入力はプリセットの値、計算はデモと同じ関数）。 */
async function runPresetOption(option: ReturnType<typeof optionOf>) {
  const { candidates, basePixels } = await contextFor(option);
  const scene = option.scene;
  const result = await runScene({
    pixels: basePixels.map((point) => [point[0], point[1]] as [number, number]),
    geoPoints: scene.gcpLonLat.map((point) => [point[0], point[1]] as [number, number]),
    yFlip: option.input.yFlip,
    chirality: option.input.chirality,
    candidates,
    transformer: makeTransformer(candidates as never),
    scene,
  });
  return { scene, candidates, result };
}

/** 場面の真値と定義（`proj4`）が同じ候補の ID（= 真値の縮退クラス）。 */
function truthClassIds(option: ReturnType<typeof optionOf>, candidates: CandidateRows): string[] {
  const truth = candidates.find((row) => row.id === option.scene.truthId);
  if (truth === undefined) throw new Error(`候補に真値 ${option.scene.truthId} が無い`);
  return candidates
    .filter((row) => row.proj4 === truth.proj4)
    .map((row) => row.id)
    .sort();
}

function headIds(ranked: ReadonlyArray<{ id: string }>, k: number): string[] {
  return ranked.slice(0, k).map((entry) => entry.id).sort();
}

function topIds(ranked: ReadonlyArray<{ id: string }>, k: number): string[] {
  return ranked.slice(0, k).map((entry) => entry.id);
}

describe('デモのプリセットの A と B で出力が分かれる（実 engine）', () => {
  it('place: 京都と東京で上位の縮退クラスが交わらず、それぞれの真値を含む', async () => {
    const a = await runPresetOption(optionOf('place', 'a'));
    const b = await runPresetOption(optionOf('place', 'b'));
    const klassA = truthClassIds(optionOf('place', 'a'), a.candidates);
    const klassB = truthClassIds(optionOf('place', 'b'), b.candidates);

    console.info(
      `[place] A: 候補 ${a.candidates.length} 件・真値の組 ${klassA.join(', ')}・上位 ${a.result.ranked
        .length} 件の先頭 ${topIds(a.result.ranked, klassA.length).join(', ')} / B: 候補 ${
        b.candidates.length
      } 件・真値の組 ${klassB.join(', ')}・上位 ${b.result.ranked.length} 件の先頭 ${topIds(
        b.result.ranked,
        klassB.length,
      ).join(', ')}`,
    );

    // それぞれの真値を含む
    expect(klassA).toContain(scenes.kyoto.truthId);
    expect(klassB).toContain(scenes.tokyo.truthId);
    // 2 つの組は交わらない
    expect(klassA.filter((id) => klassB.includes(id))).toEqual([]);

    // 上位（縮退クラスの件数だけの先頭）はその場面の真値の組であり、もう一方の場面の組を含まない
    expect(headIds(a.result.ranked, klassA.length)).toEqual(klassA);
    expect(headIds(b.result.ranked, klassB.length)).toEqual(klassB);
    expect(headIds(a.result.ranked, klassA.length)).not.toContain(scenes.tokyo.truthId);
    expect(headIds(b.result.ranked, klassB.length)).not.toContain(scenes.kyoto.truthId);
    // 「真値」の印は場面の真値だけに付く
    expect(a.result.ranked.filter((entry) => entry.isTruth).map((entry) => entry.id)).toEqual([
      scenes.kyoto.truthId,
    ]);
    expect(b.result.ranked.filter((entry) => entry.isTruth).map((entry) => entry.id)).toEqual([
      scenes.tokyo.truthId,
    ]);
  });

  it('y-direction: y の向きによらず上位が同じで、yScale の符号だけが逆になる', async () => {
    const a = await runPresetOption(optionOf('y-direction', 'a'));
    const b = await runPresetOption(optionOf('y-direction', 'b'));
    const klass = truthClassIds(optionOf('y-direction', 'a'), a.candidates);
    const yScaleA = a.result.selected?.worldFile.yScale as number;
    const yScaleB = b.result.selected?.worldFile.yScale as number;

    console.info(
      `[y-direction] 真値の組 ${klass.join(', ')}・上位 ${klass.length} 件 A: ${topIds(
        a.result.ranked,
        klass.length,
      ).join(', ')} / B: ${topIds(b.result.ranked, klass.length).join(', ')}・yScale A: ${yScaleA} / B: ${yScaleB}`,
    );

    expect(headIds(a.result.ranked, klass.length)).toEqual(headIds(b.result.ranked, klass.length));
    expect(headIds(a.result.ranked, klass.length)).toContain(a.scene.truthId);
    expect(klass.every((id) => headIds(a.result.ranked, klass.length).includes(id))).toBe(true);
    expect(Math.sign(yScaleA)).not.toBe(0);
    expect(Math.sign(yScaleB)).toBe(-Math.sign(yScaleA));
  });

  it('historical-grid: A は VI 系の同値の組が上位、B は歴史グリッド B 帯が 1 位で yard 単位になる', async () => {
    const optionA = optionOf('historical-grid', 'a');
    const optionB = optionOf('historical-grid', 'b');

    // 入力の値はプリセットが持つ（候補の集め方・場面）。テストへ書き写さない。
    expect(optionA.input.candidateMode).toBe('catalog-custom');
    expect(optionB.input.candidateMode).toBe('catalog-custom');
    expect(optionA.input.yFlip).toBe(true);
    expect(optionB.input.yFlip).toBe(true);
    expect(optionA.input.chirality).toBe('normalize');
    expect(optionB.input.chirality).toBe('normalize');
    expect(optionA.scene.id).toBe('kyoto');
    expect(optionB.scene.id).toBe('kyoto-utjcp');
    expect(optionB.scene.truthId).toBe('UTJCP:ZONE-B');

    const a = await runPresetOption(optionA);
    const b = await runPresetOption(optionB);
    const klassA = truthClassIds(optionA, a.candidates);

    console.info(
      `[historical-grid] A: 候補 ${a.candidates.length} 件・真値の組 ${klassA.join(', ')}・先頭 ${topIds(
        a.result.ranked,
        Math.min(klassA.length, a.result.ranked.length),
      ).join(', ')}` +
        ` / B: 候補 ${b.candidates.length} 件・1 位 ${b.result.ranked[0]?.id}（rms ${b.result.ranked[0]?.rmsMeters}）` +
        `・2 位 ${b.result.ranked[1]?.id}（rms ${b.result.ranked[1]?.rmsMeters}）` +
        `・単位 ${b.result.selected?.unit.name}（${b.result.selected?.unit.metresPerUnit}）` +
        ` / 変換不能 A: ${JSON.stringify(a.result.untransformableIds)} B: ${JSON.stringify(b.result.untransformableIds)}`,
    );

    // A: 1 位から縮退クラスの件数までが、真値 EPSG:6674 の縮退クラスである
    expect(klassA).toContain('EPSG:6674');
    expect(klassA).not.toContain('UTJCP:ZONE-B');
    expect(headIds(a.result.ranked, klassA.length)).toEqual(klassA);
    expect(a.result.selected?.unit.name).toBe('metre');

    // B: 1 位は歴史グリッドの B 帯で、world file の値は yard である
    expect(b.result.ranked[0]?.id).toBe('UTJCP:ZONE-B');
    expect(b.result.ranked[0]?.isTruth).toBe(true);
    expect(b.result.selected?.unit.name).toBe('yard (Japan City Plans)');
    expect(b.result.selected?.unit.metresPerUnit).toBe(0.9143985307444408);

    // どちらも「変換できなかった候補」に歴史グリッドが並ばない
    expect(a.result.untransformableIds.filter((id) => id.startsWith('UTJCP:'))).toEqual([]);
    expect(b.result.untransformableIds.filter((id) => id.startsWith('UTJCP:'))).toEqual([]);
  });

  it('normalization: 正規化ありは真値の組が上位で識別できており、なしは真値が落ちて潰れる', async () => {
    const a = await runPresetOption(optionOf('normalization', 'a'));
    const b = await runPresetOption(optionOf('normalization', 'b'));
    const klass = truthClassIds(optionOf('normalization', 'a'), a.candidates);

    console.info(
      `[normalization] 真値の組 ${klass.join(', ')}（${klass.length} 件）・結果 ${a.result.ranked.length} 件` +
        ` / A: 比 ${a.result.discrimination.ratio}・比べた相手 ${a.result.discrimination.against}・潰れている ${a.result.discrimination.collapsed}` +
        ` / B: 比 ${b.result.discrimination.ratio}・比べた相手 ${b.result.discrimination.against}・潰れている ${b.result.discrimination.collapsed}` +
        ` / B の 1 位 ${b.result.ranked[0]?.id}`,
    );

    // A: 真値の組が上位で、識別できている（比べた相手は真値の組の外）
    expect(headIds(a.result.ranked, klass.length)).toEqual(klass);
    expect(a.result.discrimination.collapsed).toBe(false);
    expect(klass).not.toContain(a.result.discrimination.against);
    expect(a.result.discrimination.ratio as number).not.toBeNull();

    // B: 真値が上位から落ち、識別力が潰れている
    expect(klass).not.toContain(b.result.ranked[0]?.id);
    expect(b.result.discrimination.collapsed).toBe(true);
    expect(b.result.discrimination.ratio as number).toBeLessThan(
      a.result.discrimination.ratio === Infinity ? Number.MAX_VALUE : (a.result.discrimination.ratio as number),
    );
  });
});
