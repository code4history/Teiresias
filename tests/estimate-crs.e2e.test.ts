/**
 * AC-m1-2: Teiresias 所有 deterministic mock の 2 候補 E2E（設計 §7.2 / §8.2）。
 *
 * node 環境で package 境界（Teiresias -> `@c4h/daedalus`）、adapter、候補 loop、実数 ranking を
 * 一体で検証する。deterministic mock E2E は実 engine E2E を代替しない（Atlas 実 engine 注入は
 * m2a、browser runtime は m2b の既知欠落）。
 */
import { fitWorldFile } from '@c4h/daedalus';
import { describe, expect, it } from 'vitest';

import { estimateCrs } from '../src/index.js';
import { geoBasisLonLat, recommendedE2eGcps } from './fixtures/mockContractFixture.js';
import {
  asyncMockTransformer,
  expectedPlaneAWorldFile,
  mockTransformer,
  teiresiasE2eGcps,
} from './fixtures/mockTransformer.js';

import type { GcpPair, GeoBasis, WorldFile } from '../src/index.js';

const planeA = { authority: 'MOCK', code: 'PLANE-A' } as const;
const planeB = { authority: 'MOCK', code: 'PLANE-B' } as const;
const planarMetre: GeoBasis = { kind: 'planar_xy', axisOrder: 'xy', unit: 'm' };
const WORLD_FILE_KEYS = ['xScale', 'xSkew', 'xOrigin', 'ySkew', 'yScale', 'yOrigin'] as const;

/** 候補 id の変換後 GcpPair を作る（Daedalus を直接呼ぶ対照実験用）。 */
function transformedPairs(id: string, gcps: ReadonlyArray<GcpPair>): GcpPair[] {
  const points = mockTransformer(
    id,
    gcps.map((g) => g.geo),
    geoBasisLonLat,
  );
  if (points === null) throw new Error(`mock returned null for ${id}`);
  return gcps.map((g, i) => ({ pixel: g.pixel, geo: points[i] }));
}

function expectWorldFileClose(actual: WorldFile, expected: Readonly<Record<string, number>>): void {
  for (const key of WORLD_FILE_KEYS) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(1e-9);
  }
}

describe('AC-m1-2: 2 候補 E2E（Teiresias 所有 GCP セット）', () => {
  it('PLANE-A が ranked[0] かつ selected identity になり、WorldFile 6 値が 1e-9 以内で一致する', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
    });

    expect(result.status).toBe('ok_with_warnings');
    expect(result.ranked.map((r) => `${r.authority}:${r.code}`)).toEqual([
      'MOCK:PLANE-A',
      'MOCK:PLANE-B',
    ]);
    expect(result.selected?.identity).toEqual({ authority: 'MOCK', code: 'PLANE-A' });
    expect(result.untransformableIds).toEqual([]);

    const selected = result.selected;
    expect(selected).not.toBeNull();
    if (selected === null) return;
    expectWorldFileClose(selected.worldFile, expectedPlaneAWorldFile);
    expect(Object.keys(selected.worldFile)).toEqual([...WORLD_FILE_KEYS]);

    // PLANE-A は basic similarity で厳密適合する ∴ basic RMS も score も 0
    expect(selected.rmsMeters).toBeLessThanOrEqual(1e-9);
    expect(selected.score).not.toBeNull();
    expect(selected.score as number).toBeLessThanOrEqual(1e-9);
    expect(selected.qualityGate).toBe('adoptable');
    // selected は ranked[0] と同じ basic RMS を持つ
    expect(selected.rmsMeters).toBe(result.ranked[0].rmsMeters);
    expect(selected.score).toBe(result.ranked[0].score);
  });

  it('候補入力順を反転しても順位・selected・WorldFile が変わらない', async () => {
    const forward = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
    });
    const reversed = await estimateCrs(teiresiasE2eGcps, [planeB, planeA], {
      transformer: mockTransformer,
    });
    expect(reversed).toEqual(forward);
  });

  it('同期 mock と async mock で同じ結果になる（MaybePromise の正規化）', async () => {
    const sync = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
    });
    const async = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: asyncMockTransformer,
    });
    expect(async).toEqual(sync);
  });

  it('mock は同じ引数 2 回に対して deep equal（契約(8) の決定性）', () => {
    const geo = teiresiasE2eGcps.map((g) => g.geo);
    expect(mockTransformer('MOCK:PLANE-A', geo, geoBasisLonLat)).toEqual(
      mockTransformer('MOCK:PLANE-A', geo, geoBasisLonLat),
    );
    expect(mockTransformer('MOCK:PLANE-B', geo, geoBasisLonLat)).toEqual(
      mockTransformer('MOCK:PLANE-B', geo, geoBasisLonLat),
    );
  });

  it('basic-before-shear が誤候補の affine 救済を防ぐ（final RMS を順位に使うと同着する）', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
    });

    const fitA = fitWorldFile(transformedPairs('MOCK:PLANE-A', teiresiasE2eGcps), {
      geoBasis: planarMetre,
      debug: true,
    });
    const fitB = fitWorldFile(transformedPairs('MOCK:PLANE-B', teiresiasE2eGcps), {
      geoBasis: planarMetre,
      debug: true,
    });

    // final RMS はどちらもほぼ 0（PLANE-B は affine が救済している）
    expect(fitA.rmsMeters as number).toBeLessThanOrEqual(1e-9);
    expect(fitB.rmsMeters as number).toBeLessThanOrEqual(1e-9);
    expect(fitA.similarityOnly).toBe(true);
    expect(fitB.similarityOnly).toBe(false);

    // basic RMS では明確に差がつき、その差が ranked の順位根拠になっている
    const basicB = Math.sqrt((fitB.debug?.sseSimilarity as number) / teiresiasE2eGcps.length);
    expect(basicB).toBeGreaterThan(1);
    expect(result.ranked[1].rmsMeters).toBeCloseTo(basicB, 9);
    expect(result.ranked[1].rmsMeters).toBeGreaterThan(result.ranked[0].rmsMeters);
  });

  it('selected.worldFile は Daedalus の最終返却で、ranked の rmsMeters は basic RMS である（§5.2 の区別）', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
      topK: 2,
    });
    const fitB = fitWorldFile(transformedPairs('MOCK:PLANE-B', teiresiasE2eGcps), {
      geoBasis: planarMetre,
      debug: true,
    });
    // PLANE-B の final RMS(≈0) と ranked の basic RMS(>1) は別物である
    expect(result.ranked[1].rmsMeters).not.toBeCloseTo(fitB.rmsMeters as number, 6);

    const fitA = fitWorldFile(transformedPairs('MOCK:PLANE-A', teiresiasE2eGcps), {
      geoBasis: planarMetre,
      debug: true,
    });
    expect(result.selected?.worldFile).toEqual(fitA.worldFile);
    expect(result.selected?.qualityGate).toBe(fitA.qualityGate);
  });
});

describe('実測固定: fixture の recommendedE2eGcps（反射あり）に対する挙動', () => {
  /**
   * 【発見事項の可視化】
   * fixture の `recommendedE2eGcps` は pixel -> geo が**反射**（`lat = 35 - v*0.0078125`）を
   * 含む。Daedalus の basic（Helmert）similarity は `{xScale:a, xSkew:-b, ySkew:b, yScale:a}`
   * すなわち行列式 `a²+b² > 0` の回転+等方スケールのみを表現でき、**反射を表現できない**。
   * ∴ fixture の doc comment が述べる「5 点・similarity 厳密適合」は、m0 で凍結された
   * Daedalus 実装に対しては成立しない（xScale=869.6875 かつ yScale=-869.6875 は
   * similarity 形では `a = 869.6875` かつ `a = -869.6875` を同時に要求する）。
   *
   * 本 describe は、その実測挙動をそのまま固定して**発見を可視化**するためのものであり、
   * 期待する仕様を表明するものではない。設計 §7.2 の AC-m1-2 は
   * `tests/fixtures/mockTransformer.ts` の `teiresiasE2eGcps`（反射なし）で満たしている。
   */
  const recommended: ReadonlyArray<GcpPair> = recommendedE2eGcps;

  it('basic score では PLANE-B が先着する（AC-m1-2 の期待と逆になる）', async () => {
    const result = await estimateCrs(recommended, [planeA, planeB], {
      transformer: mockTransformer,
    });
    expect(result.ranked.map((r) => `${r.authority}:${r.code}`)).toEqual([
      'MOCK:PLANE-B',
      'MOCK:PLANE-A',
    ]);
    expect(result.ranked[0].rmsMeters).toBeCloseTo(4791.8865398246935, 6);
    expect(result.ranked[1].rmsMeters).toBeCloseTo(5522.170500128557, 6);
  });

  it('PLANE-A の Daedalus 最終返却（affine）は fixture が記す WorldFile 6 値と 1e-9 以内で一致する', () => {
    const fitA = fitWorldFile(transformedPairs('MOCK:PLANE-A', recommended), {
      geoBasis: planarMetre,
      debug: true,
    });
    expect(fitA.similarityOnly).toBe(false);
    expectWorldFileClose(fitA.worldFile as WorldFile, {
      xScale: 869.6875,
      xSkew: 0,
      xOrigin: 0,
      ySkew: 0,
      yScale: -869.6875,
      yOrigin: 0,
    });
  });

  it('basic similarity は反射を表現できない（xScale === yScale が構造的に強制される）', () => {
    const fitA = fitWorldFile(transformedPairs('MOCK:PLANE-A', recommended), {
      geoBasis: planarMetre,
      debug: true,
    });
    // 反射なしのセットでは similarity が厳密適合し similarityOnly=true になる
    const fitPlain = fitWorldFile(transformedPairs('MOCK:PLANE-A', teiresiasE2eGcps), {
      geoBasis: planarMetre,
      debug: true,
    });
    expect(fitPlain.similarityOnly).toBe(true);
    expect(fitPlain.worldFile?.xScale).toBe(fitPlain.worldFile?.yScale);
    // 反射ありのセットでは similarity の SSE が大きく、affine が採用される
    expect(fitA.debug?.sseSimilarity as number).toBeGreaterThan(1e8);
  });
});
