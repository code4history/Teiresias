/**
 * m1-t1 の unit test。
 *
 * - AC-T1 (a): Teiresias 所有 mock が `contractPoints` に対して `expectedPlaneA` /
 *   `expectedPlaneB` と各座標 `1e-9` 以内で一致すること（m0-t3 からの委任 AC の前半）。
 * - `CandidateTransformer` 8 項目契約と違反シミュレータの全入力域挙動。
 * - AC-m1-3: candidate 単位の失敗隔離と全失敗時の status 規則。
 * - AC-INV: 設計 §6 の不変条件、非空 L_geo gate、option 正規化、warnings 帰属。
 * - 公開 API から到達不能な分岐（null-last / `status:'ok'`）は `../src/estimate-crs.js` の
 *   内部 helper を直接 import して単体検証する（設計 K14 / INF-5。package root へは公開しない）。
 */
import { fitWorldFile } from '@c4h/daedalus';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { estimateCrs } from '../src/index.js';
import {
  areScoresTied,
  basicRmsFromFit,
  computeObservationScale,
  deriveSuccessStatus,
  deriveTopLevelStatus,
  normalizeEpsilonMeters,
  normalizePositiveInteger,
  rankCandidates,
} from '../src/estimate-crs.js';
import {
  candidateDefinitions,
  candidateIds,
  contractPoints,
  emptyPoints,
  expectedPlaneA,
  expectedPlaneB,
  fixtureVersion,
  geoBasisLonLat,
  nonFinitePoints,
  outOfBboxPoints,
  planeAId,
  planeBId,
  recommendedE2eGcps,
  unknownId,
} from './fixtures/mockContractFixture.js';
import {
  asyncMockTransformer,
  brokenLengthMockTransformer,
  conformingTransformers,
  mockTransformer,
  nonFiniteOutputMockTransformer,
  rejectingMockTransformer,
  teiresiasE2eGcps,
  throwingMockTransformer,
} from './fixtures/mockTransformer.js';

import type {
  CandidateCrs,
  CandidateTransformer,
  EstimationResult,
  FitWarning,
  GcpPair,
  GeoBasis,
} from '../src/index.js';

const lonlat: GeoBasis = geoBasisLonLat;
const planar: GeoBasis = { kind: 'planar_xy', axisOrder: 'xy', unit: 'm' };

/** 期待点列との各座標 1e-9 以内一致を assert する。 */
function expectPointsClose(
  actual: Array<[number, number]> | null,
  expected: ReadonlyArray<readonly [number, number]>,
): void {
  expect(actual).not.toBeNull();
  const points = actual as Array<[number, number]>;
  expect(points).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(points[i][0] - expected[i][0])).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(points[i][1] - expected[i][1])).toBeLessThanOrEqual(1e-9);
  }
}

describe('AC-T1 (a): Teiresias 所有 mock が fixture の期待値に一致する', () => {
  it('fixture の版が契約文書の 1.0.1 である', () => {
    expect(fixtureVersion).toBe('1.0.1');
    expect(candidateIds).toEqual([planeAId, planeBId]);
    expect(candidateDefinitions.map((d) => d.id)).toEqual([planeAId, planeBId]);
  });

  it('MOCK:PLANE-A の出力が expectedPlaneA と各座標 1e-9 以内で一致する', () => {
    expectPointsClose(mockTransformer(planeAId, contractPoints, lonlat), expectedPlaneA);
  });

  it('MOCK:PLANE-B の出力が expectedPlaneB と各座標 1e-9 以内で一致する', () => {
    expectPointsClose(mockTransformer(planeBId, contractPoints, lonlat), expectedPlaneB);
  });

  it('Promise 側の適合実装（async mock）でも同じ期待値になる', async () => {
    expectPointsClose(await asyncMockTransformer(planeAId, contractPoints, lonlat), expectedPlaneA);
    expectPointsClose(await asyncMockTransformer(planeBId, contractPoints, lonlat), expectedPlaneB);
  });

  it('期待値の照合が実際に発火する（両候補の期待値は互いに異なる）', () => {
    // 期待値が同一なら上の 2 test は候補を取り違えても通ってしまう。差があることを固定する。
    expect(expectedPlaneA).not.toEqual(expectedPlaneB);
  });
});

describe('CandidateTransformer 8 項目契約（Teiresias 側実装）', () => {
  it('(1) 候補 id は `${authority}:${code}` 形式で、分解・再合成が元に戻る', () => {
    for (const id of candidateIds) {
      expect(id).toMatch(/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/);
      const separator = id.indexOf(':');
      const authority = id.slice(0, separator);
      const code = id.slice(separator + 1);
      expect(authority).not.toBe('');
      expect(code).not.toBe('');
      expect(`${authority}:${code}`).toBe(id);
    }
  });

  it('(2)(3) 出力は入力と同順同数で、i 番目が i 番目の変換結果である', () => {
    const output = mockTransformer(planeAId, contractPoints, lonlat);
    expect(output).toHaveLength(contractPoints.length);
    const single = mockTransformer(planeAId, [contractPoints[1]], lonlat);
    expectPointsClose(single, [expectedPlaneA[1]]);
  });

  it('(4) 空入力は null（`[]` を返さない）', () => {
    expect(mockTransformer(planeAId, emptyPoints, lonlat)).toBeNull();
    expect(mockTransformer(planeAId, [], lonlat)).toBeNull();
  });

  it('(5) 一点でも非有限なら全体 null（部分成功を返さない）', () => {
    expect(mockTransformer(planeAId, nonFinitePoints, lonlat)).toBeNull();
  });

  it('(5)(7) 有効域 bbox 外を含むと全体 null。境界は含む', () => {
    expect(mockTransformer(planeAId, outOfBboxPoints, lonlat)).toBeNull();
    const boundary = candidateDefinitions[0].bbox;
    expect(
      mockTransformer(planeAId, [[boundary.west, boundary.south]], lonlat),
    ).not.toBeNull();
    expect(
      mockTransformer(planeAId, [[boundary.east, boundary.north]], lonlat),
    ).not.toBeNull();
  });

  it('(7) 未知 id と対応外 geoBasis は throw せず null', () => {
    expect(() => mockTransformer(unknownId, contractPoints, lonlat)).not.toThrow();
    expect(mockTransformer(unknownId, contractPoints, lonlat)).toBeNull();
    expect(mockTransformer(planeAId, contractPoints, planar)).toBeNull();
  });

  it('(8) 同じ id・点列・basis に対して決定的である', () => {
    const first = mockTransformer(planeAId, contractPoints, lonlat);
    const second = mockTransformer(planeAId, contractPoints, lonlat);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('判定順序: 空入力は未知 id / 対応外 basis より先に評価される', () => {
    expect(mockTransformer(unknownId, [], planar)).toBeNull();
  });

  it('全 mock が公開型 CandidateTransformer に代入可能である', () => {
    expect(conformingTransformers).toHaveLength(6);
    for (const transformer of conformingTransformers) {
      expect(typeof transformer).toBe('function');
    }
  });
});

describe('違反シミュレータの全入力域挙動（契約文書 §3）', () => {
  it('throwing は入力によらず常に throw する（null 系入力を含む）', () => {
    expect(() => throwingMockTransformer(planeAId, contractPoints, lonlat)).toThrow(
      /always throws/,
    );
    expect(() => throwingMockTransformer(unknownId, [], planar)).toThrow(/always throws/);
  });

  it('rejecting は常に reject する', async () => {
    await expect(rejectingMockTransformer(planeAId, contractPoints, lonlat)).rejects.toThrow(
      /always rejects/,
    );
  });

  it('brokenLength は成功経路でのみ末尾 1 点を欠き、null 経路では null を返す', () => {
    const broken = brokenLengthMockTransformer(planeAId, contractPoints, lonlat);
    expect(broken).toHaveLength(contractPoints.length - 1);
    expect(brokenLengthMockTransformer(planeAId, emptyPoints, lonlat)).toBeNull();
    expect(brokenLengthMockTransformer(unknownId, contractPoints, lonlat)).toBeNull();
  });

  it('nonFiniteOutput は成功経路でのみ先頭点の easting を非有限にする', () => {
    const broken = nonFiniteOutputMockTransformer(planeAId, contractPoints, lonlat);
    expect(broken).toHaveLength(contractPoints.length);
    expect(Number.isFinite((broken as Array<[number, number]>)[0][0])).toBe(false);
    expect(Number.isFinite((broken as Array<[number, number]>)[1][0])).toBe(true);
    expect(nonFiniteOutputMockTransformer(planeAId, emptyPoints, lonlat)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T3: estimateCrs の unit test（AC-m1-3 / AC-INV）
// ---------------------------------------------------------------------------

const planeA = { authority: 'MOCK', code: 'PLANE-A' } as const;
const planeB = { authority: 'MOCK', code: 'PLANE-B' } as const;

/** transformer の呼出しを記録するラッパ。 */
function recording(inner: CandidateTransformer): {
  transformer: CandidateTransformer;
  calls: Array<{ id: string; points: ReadonlyArray<readonly [number, number]>; geoBasis: GeoBasis }>;
} {
  const calls: Array<{
    id: string;
    points: ReadonlyArray<readonly [number, number]>;
    geoBasis: GeoBasis;
  }> = [];
  return {
    calls,
    transformer: (id, points, geoBasis) => {
      calls.push({ id, points, geoBasis });
      return inner(id, points, geoBasis);
    },
  };
}

/** EstimationResult の不変条件（設計 §6 の 1〜7・9）を全数 assert する。 */
function assertInvariants(result: EstimationResult, inputs: readonly CandidateCrs[]): void {
  const inputIds = new Set(inputs.map((c) => `${c.authority}:${c.code}`));
  const rankedIds = result.ranked.map((r) => `${r.authority}:${r.code}`);

  // 1. ranked は入力 candidate 由来
  for (const id of rankedIds) expect(inputIds.has(id)).toBe(true);
  // 2. identity 重複なし
  expect(new Set(rankedIds).size).toBe(rankedIds.length);
  // 2. score 昇順（null は最後）
  const finite = result.ranked.filter((r) => r.score !== null).map((r) => r.score as number);
  const firstNull = result.ranked.findIndex((r) => r.score === null);
  if (firstNull >= 0) {
    expect(result.ranked.slice(firstNull).every((r) => r.score === null)).toBe(true);
  }
  for (let i = 1; i < finite.length; i++) expect(finite[i]).toBeGreaterThanOrEqual(finite[i - 1]);

  if (result.selected !== null) {
    // 3
    expect(result.ranked.length).toBeGreaterThanOrEqual(1);
    expect(result.selected.identity.authority).toBe(result.ranked[0].authority);
    expect(result.selected.identity.code).toBe(result.ranked[0].code);
    expect(result.selected.score).toBe(result.ranked[0].score);
    expect(result.selected.rmsMeters).toBe(result.ranked[0].rmsMeters);
    // 4
    expect(Object.values(result.selected.worldFile).every((v) => Number.isFinite(v))).toBe(true);
    expect(['adoptable', 'preview']).toContain(result.selected.qualityGate);
    expect(['ok', 'ok_with_warnings']).toContain(result.status);
  } else {
    // 5
    expect(['failed', 'insufficient']).toContain(result.status);
  }
  // 6
  if (result.status === 'ok') expect(result.warnings).toHaveLength(0);
  if (result.status === 'ok_with_warnings') expect(result.warnings.length).toBeGreaterThan(0);
  // 7
  expect(new Set(result.untransformableIds).size).toBe(result.untransformableIds.length);
  for (const id of result.untransformableIds) expect(rankedIds).not.toContain(id);
  // 10: failure は failed のときだけ非 null（理由の無い failed・理由つきの成功を作らない）
  expect(result.failure !== null).toBe(result.status === 'failed');
  // 9: FitWarning は Daedalus 型のまま（code は WarningCode の 7 値）
  for (const warning of result.warnings) {
    expect(FROZEN_WARNING_CODES).toContain(warning.code);
  }
}

const FROZEN_WARNING_CODES = [
  'insufficientPointCount',
  'nearCollinearSource',
  'affineSkippedCollinear',
  'affineSkippedInsufficientDof',
  'affineRejectedNonImproving',
  'validationSkipped',
  'unsupportedAxisOrder',
];

describe('AC-m1-3: candidate 単位の失敗隔離と全失敗時の status', () => {
  it('1 候補が業務的に null でも残候補を継続し、selected は成功候補になる', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [{ authority: 'MOCK', code: 'NO-SUCH' }, planeA], {
      transformer: mockTransformer,
    });
    expect(result.untransformableIds).toEqual(['MOCK:NO-SUCH']);
    expect(result.selected?.identity).toEqual({ authority: 'MOCK', code: 'PLANE-A' });
    assertInvariants(result, [{ authority: 'MOCK', code: 'NO-SUCH' }, planeA]);
  });

  it('空入力でも候補ごとに transformer を呼び、null を untransformableIds へ記録して insufficient', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs([], [planeA, planeB], { transformer: spy.transformer });
    expect(spy.calls.map((c) => c.id)).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
    expect(spy.calls[0].points).toEqual([]);
    expect(result.status).toBe('insufficient');
    expect(result.selected).toBeNull();
    expect(result.ranked).toEqual([]);
    expect(result.untransformableIds).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
  });

  it('全候補が長さ不一致なら adapter-contract-failure により failed（insufficient へ埋没させない）', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: brokenLengthMockTransformer,
    });
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.untransformableIds).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
    expect(result.failure?.reason).toBe('implementation-failure');
    expect(result.failure?.candidates.map((c) => [c.id, c.kind])).toEqual([
      ['MOCK:PLANE-A', 'adapter-contract-failure'],
      ['MOCK:PLANE-B', 'adapter-contract-failure'],
    ]);
    assertInvariants(result, [planeA, planeB]);
  });

  it('全候補が非有限出力でも failed', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: nonFiniteOutputMockTransformer,
    });
    expect(result.status).toBe('failed');
    expect(result.untransformableIds).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
  });

  it('全候補が throw / reject でも failed', async () => {
    const thrown = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: throwingMockTransformer,
    });
    expect(thrown.status).toBe('failed');
    const rejected = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: rejectingMockTransformer,
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.untransformableIds).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
    expect(thrown.failure?.candidates.map((c) => c.kind)).toEqual(['adapter-bug', 'adapter-bug']);
    expect(rejected.failure?.candidates).toEqual([
      { id: 'MOCK:PLANE-A', kind: 'adapter-bug', message: 'mock adapter bug: rejectingMockTransformer always rejects' },
      { id: 'MOCK:PLANE-B', kind: 'adapter-bug', message: 'mock adapter bug: rejectingMockTransformer always rejects' },
    ]);
  });

  it('業務的 null だけなら insufficient（failed にしない）', async () => {
    const result = await estimateCrs(
      teiresiasE2eGcps,
      [
        { authority: 'MOCK', code: 'NO-SUCH' },
        { authority: 'MOCK', code: 'NO-SUCH-2' },
      ],
      { transformer: mockTransformer },
    );
    expect(result.status).toBe('insufficient');
    expect(result.untransformableIds).toEqual(['MOCK:NO-SUCH', 'MOCK:NO-SUCH-2']);
    expect(result.failure).toBeNull();
  });

  it('throw する候補が 1 件でもあれば、残候補を評価したうえで failed にし selected を出さない', async () => {
    const transformer: CandidateTransformer = (id, points, geoBasis) => {
      if (id === 'MOCK:PLANE-B') throw new Error('boom');
      return mockTransformer(id, points, geoBasis);
    };
    const result = await estimateCrs(teiresiasE2eGcps, [planeB, planeA], { transformer });
    expect(result.untransformableIds).toEqual(['MOCK:PLANE-B']);
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure).toEqual({
      reason: 'implementation-failure',
      candidates: [{ id: 'MOCK:PLANE-B', kind: 'adapter-bug', message: 'boom' }],
    });
    // ranked は評価できた候補の診断として残る
    expect(result.ranked.map((entry) => `${entry.authority}:${entry.code}`)).toEqual(['MOCK:PLANE-A']);
    assertInvariants(result, [planeB, planeA]);
  });

  it('identity 空文字は transformer を呼ばず candidate failure にする', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs(
      teiresiasE2eGcps,
      [{ authority: '', code: 'PLANE-A' }, { authority: 'MOCK', code: '' }, planeA],
      { transformer: spy.transformer },
    );
    expect(spy.calls.map((c) => c.id)).toEqual(['MOCK:PLANE-A']);
    expect(result.untransformableIds).toEqual([':PLANE-A', 'MOCK:']);
    expect(result.selected?.identity.code).toBe('PLANE-A');
  });

  it('identity 重複は最初の 1 件だけ評価し、untransformableIds へ入れない', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeA, planeB], {
      transformer: spy.transformer,
    });
    expect(spy.calls.map((c) => c.id)).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B']);
    expect(result.untransformableIds).toEqual([]);
    expect(result.ranked).toHaveLength(2);
  });
});

describe('AC-INV: 非空 L_geo gate（K15）', () => {
  const tiny = [
    { pixel: [0, 0], geo: [135.0, 35.0] },
    { pixel: [10, 0], geo: [135.0001, 35.0] },
    { pixel: [0, 10], geo: [135.0, 35.0001] },
  ] as const;

  it('L_geo < epsilon なら candidate loop を開始せず insufficient を返す', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs(tiny, [planeA, planeB], { transformer: spy.transformer });
    expect(spy.calls).toEqual([]);
    expect(result).toEqual({
      status: 'insufficient',
      selected: null,
      ranked: [],
      warnings: [],
      untransformableIds: [],
      failure: null,
    });
  });

  it('非有限 geo 座標でも同じ早期返却になる', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs(
      [
        { pixel: [0, 0], geo: [135.0, 35.0] },
        { pixel: [10, 10], geo: [Number.NaN, 35.078125] },
      ],
      [planeA],
      { transformer: spy.transformer },
    );
    expect(spy.calls).toEqual([]);
    expect(result.status).toBe('insufficient');
    expect(result.untransformableIds).toEqual([]);
  });

  it('normalizeEpsilonMeters を小さくすれば同じ入力が gate を通る', async () => {
    const spy = recording(mockTransformer);
    const result = await estimateCrs(tiny, [planeA], {
      transformer: spy.transformer,
      normalizeEpsilonMeters: 1,
    });
    expect(spy.calls.map((c) => c.id)).toEqual(['MOCK:PLANE-A']);
    expect(result.untransformableIds).toEqual([]);
  });
});

describe('AC-INV: option 正規化と selected/ranked（K8）', () => {
  it('topK は ranked を切り詰めるが minCandidates 判定は切り詰め前の usable 全件で行う', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
      topK: 1,
      minCandidates: 2,
    });
    expect(result.ranked).toHaveLength(1);
    expect(result.selected).not.toBeNull();
    assertInvariants(result, [planeA, planeB]);
  });

  it('usable が minCandidates に満たなければ insufficient・selected:null。ranked は診断として返す', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
      minCandidates: 3,
    });
    expect(result.status).toBe('insufficient');
    expect(result.selected).toBeNull();
    expect(result.ranked).toHaveLength(2);
    assertInvariants(result, [planeA, planeB]);
  });

  it('正の整数でない minCandidates / topK / epsilon は既定へ正規化される', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
        transformer: mockTransformer,
        minCandidates: bad,
        topK: bad,
        normalizeEpsilonMeters: bad,
      });
      expect(result.ranked).toHaveLength(2);
      expect(result.selected?.identity.code).toBe('PLANE-A');
    }
  });
});

describe('AC-INV: transformer への引数と Daedalus へ渡す basis（K7）', () => {
  it('transformer は id と入力 geo 点列を同順で受け取り、既定 basis は lonlat_deg/lon-lat', async () => {
    const spy = recording(mockTransformer);
    await estimateCrs(teiresiasE2eGcps, [planeA], { transformer: spy.transformer });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].id).toBe('MOCK:PLANE-A');
    expect(spy.calls[0].points).toEqual(teiresiasE2eGcps.map((g) => g.geo));
    expect(spy.calls[0].geoBasis).toEqual({ kind: 'lonlat_deg', axisOrder: 'lon-lat' });
  });

  it('options.geoBasis はそのまま transformer へ渡される（L_geo も同 basis で評価される）', async () => {
    // planar_xy/m の入力。L_geo = hypot(1000,1000) ≈ 1414 m > 100 m ∴ gate を通る。
    const planarGcps = [
      { pixel: [0, 0], geo: [0, 0] },
      { pixel: [10, 0], geo: [1000, 0] },
      { pixel: [0, 10], geo: [0, 1000] },
    ] as const;
    const spy = recording(mockTransformer);
    await estimateCrs(planarGcps, [planeA], {
      transformer: spy.transformer,
      geoBasis: planar,
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].geoBasis).toEqual(planar);
    expect(spy.calls[0].points).toEqual(planarGcps.map((g) => g.geo));

    // 同じ入力を lonlat_deg として渡すと L_geo が桁違いになる ∴ basis は L_geo にも効いている
    expect(computeObservationScale(planarGcps, planar)).toBeCloseTo(Math.hypot(1000, 1000), 9);
    expect(computeObservationScale(planarGcps, { kind: 'lonlat_deg', axisOrder: 'lon-lat' })).toBeGreaterThan(1e8);
  });

  it('Daedalus へは planar_xy/m を渡す（入力 basis を横流ししない）', async () => {
    // 変換後の広がりが 1 m 程度になる transformer。planar_xy/m と解釈すれば
    // Daedalus の L_geo(=1m) < epsilon(100m) で insufficient になり usable 0 件になる。
    // 入力 basis(lonlat_deg) を横流しすると L_geo ≈ 111 km となり usable になってしまう。
    const metreScale: CandidateTransformer = (_id, points) =>
      points.map(([lon, lat]): [number, number] => [(lon - 135) * 12.8, (lat - 35) * 12.8]);
    const result = await estimateCrs(teiresiasE2eGcps, [planeA], { transformer: metreScale });
    expect(result.status).toBe('insufficient');
    expect(result.selected).toBeNull();
    expect(result.ranked).toEqual([]);
    expect(result.untransformableIds).toEqual([]);
  });
});

describe('AC-INV: warnings の帰属（K9）', () => {
  it('成功時 warnings は selected 候補の Daedalus FitWarning だけを同順・同形で返す', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
    });
    const selectedPoints = mockTransformer(
      'MOCK:PLANE-A',
      teiresiasE2eGcps.map((g) => g.geo),
      geoBasisLonLat,
    ) as Array<[number, number]>;
    const direct = fitWorldFile(
      teiresiasE2eGcps.map((g, i) => ({ pixel: g.pixel, geo: selectedPoints[i] })),
      { geoBasis: planar, debug: true },
    );
    expect(result.warnings).toEqual(direct.warnings);
  });

  it('candidate failure だけでは warnings に何も入らない', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [{ authority: 'MOCK', code: 'NO-SUCH' }], {
      transformer: mockTransformer,
    });
    expect(result.warnings).toEqual([]);
    expect(result.status).toBe('insufficient');
  });
});

describe('内部 helper の単体検証（公開 API から到達不能な分岐。K14 / K16 / INF-5）', () => {
  it('deriveSuccessStatus: 合成 warning 配列で ok / ok_with_warnings を導出する', () => {
    expect(deriveSuccessStatus([])).toBe('ok');
    expect(deriveSuccessStatus([{ code: 'validationSkipped' }])).toBe('ok_with_warnings');
    expect(
      deriveSuccessStatus([{ code: 'insufficientPointCount' }, { code: 'validationSkipped' }]),
    ).toBe('ok_with_warnings');
  });

  it('deriveTopLevelStatus: 4 行（打ち切り → 実装失敗 → usable 十分 → 不足）と重なりを全数再現する', () => {
    const base = {
      usableCount: 2,
      minCandidates: 1,
      hasImplementationFailure: false,
      hasTimeout: false,
      selectedWarnings: [] as FitWarning[],
    };
    // 行 3: usable 十分（warning 0 件なら ok）
    expect(deriveTopLevelStatus(base)).toBe('ok');
    expect(deriveTopLevelStatus({ ...base, selectedWarnings: [{ code: 'validationSkipped' }] })).toBe(
      'ok_with_warnings',
    );
    // 行 4: 不足
    expect(deriveTopLevelStatus({ ...base, usableCount: 1, minCandidates: 3 })).toBe('insufficient');
    expect(deriveTopLevelStatus({ ...base, usableCount: 0 })).toBe('insufficient');
    // 行 2: 実装失敗が 1 件でもあれば、usable の数によらず failed
    for (const usableCount of [0, 1, 2]) {
      for (const minCandidates of [1, 2, 3]) {
        expect(
          deriveTopLevelStatus({ ...base, usableCount, minCandidates, hasImplementationFailure: true }),
        ).toBe('failed');
      }
    }
    // 行 1: 打ち切り（実装失敗との重なりを含む）
    for (const hasImplementationFailure of [false, true]) {
      for (const usableCount of [0, 2]) {
        expect(deriveTopLevelStatus({ ...base, usableCount, hasImplementationFailure, hasTimeout: true })).toBe(
          'failed',
        );
      }
    }
  });

  it('areScoresTied: 機械精度由来の許容だけを同着とする', () => {
    expect(areScoresTied(1, 1)).toBe(true);
    expect(areScoresTied(1, 1 + 16 * Number.EPSILON)).toBe(true);
    expect(areScoresTied(1, 1.0001)).toBe(false);
    expect(areScoresTied(0, 0)).toBe(true);
  });

  it('rankCandidates: score 厳密昇順 → 隣接 epsilon group → group 内 prior / identity', () => {
    const entries = [
      { authority: 'B', code: '1', score: 1, datumFamily: 'LOW' },
      { authority: 'A', code: '1', score: 1 + 8 * Number.EPSILON, datumFamily: 'HIGH' },
      { authority: 'C', code: '1', score: 2, datumFamily: 'HIGH' },
    ];
    const ranked = rankCandidates(entries, ['HIGH', 'LOW']);
    // 1 と 1+8ε は同着 group ∴ group 内で prior HIGH の A が先着
    expect(ranked.map((e) => e.authority)).toEqual(['A', 'B', 'C']);
  });

  it('rankCandidates: prior は group をまたいで順位を逆転しない', () => {
    const entries = [
      { authority: 'B', code: '1', score: 1, datumFamily: 'LOW' },
      { authority: 'A', code: '1', score: 2, datumFamily: 'HIGH' },
    ];
    expect(rankCandidates(entries, ['HIGH', 'LOW']).map((e) => e.authority)).toEqual(['B', 'A']);
  });

  it('rankCandidates: 入力順に依存しない（順列を変えても同じ結果）', () => {
    const entries = [
      { authority: 'B', code: '1', score: 1, datumFamily: 'LOW' },
      { authority: 'A', code: '1', score: 1 + 8 * Number.EPSILON, datumFamily: 'HIGH' },
      { authority: 'C', code: '1', score: 2, datumFamily: 'HIGH' },
      { authority: 'D', code: '1', score: null },
    ];
    const expected = rankCandidates(entries, ['HIGH', 'LOW']).map((e) => e.authority);
    const permutations = [
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 3, 0, 1],
    ];
    for (const order of permutations) {
      expect(rankCandidates(order.map((i) => entries[i]), ['HIGH', 'LOW']).map((e) => e.authority)).toEqual(expected);
    }
  });

  it('rankCandidates: null score は最後（null-last）で、prior → identity の順に閉じる', () => {
    const entries = [
      { authority: 'Z', code: '1', score: null, datumFamily: 'LOW' },
      { authority: 'A', code: '1', score: null, datumFamily: 'HIGH' },
      { authority: 'M', code: '1', score: 5 },
    ];
    expect(rankCandidates(entries, ['HIGH', 'LOW']).map((e) => e.authority)).toEqual(['M', 'A', 'Z']);
  });

  it('rankCandidates: prior 未指定・一覧外・値なしは同順位で identity の code-unit 順に閉じる', () => {
    const entries = [
      { authority: 'B', code: '1', score: 1, datumFamily: 'UNLISTED' },
      { authority: 'A', code: '1', score: 1 },
      { authority: 'C', code: '1', score: 1, datumFamily: 'ALSO-UNLISTED' },
    ];
    expect(rankCandidates(entries, ['HIGH']).map((e) => e.authority)).toEqual(['A', 'B', 'C']);
    expect(rankCandidates(entries, undefined).map((e) => e.authority)).toEqual(['A', 'B', 'C']);
  });

  it('normalizePositiveInteger / normalizeEpsilonMeters が既定へ落とす', () => {
    expect(normalizePositiveInteger(3, 1)).toBe(3);
    for (const bad of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(normalizePositiveInteger(bad, 7)).toBe(7);
    }
    expect(normalizeEpsilonMeters(5)).toBe(5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(normalizeEpsilonMeters(bad)).toBe(100);
    }
  });

  it('computeObservationScale: 3 basis の L_geo を設計 §5.3 どおり算出する', () => {
    const lonlatGcps = [
      { pixel: [0, 0], geo: [135, 35] },
      { pixel: [1, 1], geo: [135.5, 35] },
    ] as const;
    const expectedLon = 0.5 * 111320 * Math.cos((35 * Math.PI) / 180);
    expect(computeObservationScale(lonlatGcps, { kind: 'lonlat_deg', axisOrder: 'lon-lat' })).toBeCloseTo(expectedLon, 6);

    const planarGcps = [
      { pixel: [0, 0], geo: [0, 0] },
      { pixel: [1, 1], geo: [300, 400] },
    ] as const;
    expect(computeObservationScale(planarGcps, planar)).toBe(500);
    expect(
      computeObservationScale(planarGcps, { kind: 'planar_xy', axisOrder: 'xy', unit: 'ft' }),
    ).toBeCloseTo(500 * 0.3048, 9);
  });

  it('basicRmsFromFit: sseSimilarity 優先、similarityOnly の fallback、契約違反の null', () => {
    const base = {
      status: 'ok_with_warnings' as const,
      qualityGate: 'adoptable' as const,
      worldFile: { xScale: 1, xSkew: 0, xOrigin: 0, ySkew: 0, yScale: 1, yOrigin: 0 },
      warnings: [],
    };
    expect(basicRmsFromFit({ ...base, similarityOnly: false, rmsMeters: 1, debug: { sse: 1, mse: 0.25, sseSimilarity: 16 } }, 4)).toBe(2);
    expect(basicRmsFromFit({ ...base, similarityOnly: true, rmsMeters: 3 }, 4)).toBe(3);
    // similarityOnly=false なのに有限な sseSimilarity が無い -> dependency-contract-failure
    expect(basicRmsFromFit({ ...base, similarityOnly: false, rmsMeters: 3 }, 4)).toBeNull();
    expect(basicRmsFromFit({ ...base, similarityOnly: true, rmsMeters: null }, 4)).toBeNull();
  });
});

describe('chirality 正規化: 候補ごとの双試行（unit）', () => {
  /** pixel の v を反転した GCP セット（geo は不変）。 */
  function flipPixelV(gcps: ReadonlyArray<GcpPair>): GcpPair[] {
    return gcps.map((g) => ({ pixel: [g.pixel[0], -g.pixel[1]], geo: g.geo }));
  }

  /** 入力の planar 点をそのまま返す transformer（候補は 1 件だけ想定）。 */
  const identityTransformer: CandidateTransformer = (_id, points) =>
    points.map((p): [number, number] => [p[0], p[1]]);

  /**
   * v 反転で対応の集合そのものが変わらない（geo(u, v) = geo(u, -v)）GCP セット。
   * direct と flip の SSE が一致し、Daedalus は similarity を採用し、yScale は 0 でない
   * ∴ flip 側を採れば yScale の符号が反転して観測できる。
   */
  const symmetricGcps: GcpPair[] = [
    [-10, -10],
    [10, -10],
    [-10, 10],
    [10, 10],
    [0, -5],
    [0, 5],
    [-20, 0],
    [20, 0],
  ].map(([u, v]) => ({
    pixel: [u, v] as [number, number],
    geo: [1000 + 100 * u + 30 * v * v + 0.5 * u * u, 2000 + 20 * v * v - 3 * u * u] as [number, number],
  }));

  it('同値（Z 述語の内）なら direct を採る（direct-only と同じ worldFile）', async () => {
    const options = { transformer: identityTransformer, geoBasis: planar };
    const normalized = await estimateCrs(symmetricGcps, [planeA], options);
    const directOnly = await estimateCrs(symmetricGcps, [planeA], { ...options, chirality: 'direct-only' });

    // 前提: 対称セットでは direct と flip の fit が一致し、yScale が 0 でない（取り違えれば観測できる）
    const fitDirect = fitWorldFile(symmetricGcps, { geoBasis: planar, debug: true });
    const fitFlip = fitWorldFile(flipPixelV(symmetricGcps), { geoBasis: planar, debug: true });
    expect(fitDirect.debug?.sseSimilarity).toBe(fitFlip.debug?.sseSimilarity);
    expect(fitDirect.similarityOnly).toBe(true);
    expect(Math.abs(fitDirect.worldFile?.yScale as number)).toBeGreaterThan(1);

    expect(normalized.selected?.worldFile).toEqual(directOnly.selected?.worldFile);
    expect(normalized.selected?.worldFile).toEqual(fitDirect.worldFile);
    expect(normalized.warnings).toEqual(directOnly.warnings);
  });

  it('transformer の呼び出し回数は正規化で増えない（候補数と等しい）', async () => {
    const candidates = [planeA, planeB];
    const count = async (chirality: 'normalize' | 'direct-only'): Promise<number> => {
      let calls = 0;
      const spy: CandidateTransformer = (id, points, basis) => {
        calls += 1;
        return mockTransformer(id, points, basis);
      };
      await estimateCrs(recommendedE2eGcps, candidates, { transformer: spy, chirality });
      return calls;
    };
    const normalizeCalls = await count('normalize');
    const directOnlyCalls = await count('direct-only');
    expect(normalizeCalls).toBe(candidates.length);
    expect(directOnlyCalls).toBe(candidates.length);
  });

  it('chirality を省略すると normalize と同じ結果になる（既定）', async () => {
    const omitted = await estimateCrs(recommendedE2eGcps, [planeA, planeB], { transformer: mockTransformer });
    const normalize = await estimateCrs(recommendedE2eGcps, [planeA, planeB], {
      transformer: mockTransformer,
      chirality: 'normalize',
    });
    expect(omitted).toEqual(normalize);
    // 反射ありの入力で flip 側が採られている（既定が direct-only ではない）
    expect(omitted.selected?.worldFile.yScale as number).toBeLessThan(0);
    expect(omitted.selected?.identity).toEqual({ authority: 'MOCK', code: 'PLANE-A' });
  });

  it('選択なしの経路でも、採らなかった側の warning を外へ出さない', async () => {
    // 反射ありの PLANE-A: direct 側は affine 採用、flip 側は similarity 厳密適合（affine 不採用）
    // ∴ 両側の warnings が異なる。minCandidates を候補数より大きくして選択なしの経路に通す。
    const reflected: ReadonlyArray<GcpPair> = recommendedE2eGcps;
    const options = { transformer: mockTransformer, minCandidates: 2 };
    const normalized = await estimateCrs(reflected, [planeA], options);
    const flippedDirectOnly = await estimateCrs(flipPixelV(reflected), [planeA], {
      ...options,
      chirality: 'direct-only',
    });
    const reflectedDirectOnly = await estimateCrs(reflected, [planeA], {
      ...options,
      chirality: 'direct-only',
    });

    expect(normalized.selected).toBeNull();
    expect(normalized.status).toBe('insufficient');
    // 前提: 両側の warnings は異なる（検査が発火しうる）
    expect(flippedDirectOnly.warnings).not.toEqual(reflectedDirectOnly.warnings);
    // 採った側（flip）の warnings だけが返る
    expect(normalized.warnings).toEqual(flippedDirectOnly.warnings);
  });

  it('flip 側を採ったら xSkew と yScale の符号だけを反転し、他の 4 値と RMS は採った側の値のまま', async () => {
    const reflected: ReadonlyArray<GcpPair> = recommendedE2eGcps;
    const normalized = await estimateCrs(reflected, [planeA], { transformer: mockTransformer });
    const flipped = await estimateCrs(flipPixelV(reflected), [planeA], {
      transformer: mockTransformer,
      chirality: 'direct-only',
    });
    const a = normalized.selected?.worldFile as NonNullable<EstimationResult['selected']>['worldFile'];
    const b = flipped.selected?.worldFile as NonNullable<EstimationResult['selected']>['worldFile'];
    expect(a.xScale).toBe(b.xScale);
    expect(a.xSkew).toBe(0 - b.xSkew);
    expect(a.xOrigin).toBe(b.xOrigin);
    expect(a.ySkew).toBe(b.ySkew);
    expect(a.yScale).toBe(-b.yScale);
    expect(a.yOrigin).toBe(b.yOrigin);
    expect(normalized.selected?.rmsMeters).toBe(flipped.selected?.rmsMeters);
    expect(normalized.selected?.qualityGate).toBe(flipped.selected?.qualityGate);
    expect(normalized.warnings).toEqual(flipped.warnings);
    expect(normalized.status).toBe(flipped.status);
  });
});

// ---------------------------------------------------------------------------
// 実装側の失敗を握らない（1 件でも failed・selected なし・理由は failure）
// ---------------------------------------------------------------------------

/** 候補 PLANE-B だけ inner に差し替え、PLANE-A は適合 mock のままにする transformer。 */
function planeBVia(inner: CandidateTransformer): CandidateTransformer {
  return (id, points, geoBasis) =>
    id === 'MOCK:PLANE-B' ? inner(id, points, geoBasis) : mockTransformer(id, points, geoBasis);
}

describe('実装側の失敗が 1 件でもあれば failed にする', () => {
  it('(a) throw と成功が混ざると failed・selected なし・failure に throw の候補・ranked に成功候補', async () => {
    const transformer = planeBVia(() => {
      throw new Error('boom');
    });
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer });
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure).toEqual({
      reason: 'implementation-failure',
      candidates: [{ id: 'MOCK:PLANE-B', kind: 'adapter-bug', message: 'boom' }],
    });
    expect(result.ranked.map((entry) => entry.code)).toEqual(['PLANE-A']);
    assertInvariants(result, [planeA, planeB]);
  });

  it('(b) reject でも同じ', async () => {
    const transformer = planeBVia(() => Promise.reject(new Error('boom')));
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer });
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure).toEqual({
      reason: 'implementation-failure',
      candidates: [{ id: 'MOCK:PLANE-B', kind: 'adapter-bug', message: 'boom' }],
    });
    expect(result.ranked.map((entry) => entry.code)).toEqual(['PLANE-A']);
  });

  it('(c) 長さ不一致は adapter-contract-failure で、message に期待した点数と実際の点数', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], {
      transformer: planeBVia(brokenLengthMockTransformer),
    });
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure?.reason).toBe('implementation-failure');
    expect(result.failure?.candidates).toEqual([
      { id: 'MOCK:PLANE-B', kind: 'adapter-contract-failure', message: 'expected 5 points, got 4' },
    ]);
  });

  it('(d) 業務的 null だけなら今と同じ（成功候補があれば選ぶ・無ければ insufficient）で failure は null', async () => {
    const withSuccess = await estimateCrs(
      teiresiasE2eGcps,
      [{ authority: 'MOCK', code: 'NO-SUCH' }, planeA],
      { transformer: mockTransformer },
    );
    expect(withSuccess.status).toBe('ok_with_warnings');
    expect(withSuccess.selected?.identity.code).toBe('PLANE-A');
    expect(withSuccess.failure).toBeNull();

    const onlyNull = await estimateCrs(teiresiasE2eGcps, [{ authority: 'MOCK', code: 'NO-SUCH' }], {
      transformer: mockTransformer,
    });
    expect(onlyNull.status).toBe('insufficient');
    expect(onlyNull.failure).toBeNull();
  });

  it('(e) 全件成功なら failure は null', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer: mockTransformer });
    expect(result.status).toBe('ok_with_warnings');
    expect(result.failure).toBeNull();
    assertInvariants(result, [planeA, planeB]);
  });

  it('複数の失敗は 1 件目で止めず、入力順に全件を failure.candidates に集める', async () => {
    const spy = recording((id) => {
      throw new Error(`broken ${id}`);
    });
    const candidates = [planeA, planeB, { authority: 'MOCK', code: 'C' }];
    const result = await estimateCrs(teiresiasE2eGcps, candidates, { transformer: spy.transformer });
    expect(spy.calls).toHaveLength(3);
    expect(result.failure?.candidates.map((c) => c.id)).toEqual(['MOCK:PLANE-A', 'MOCK:PLANE-B', 'MOCK:C']);
  });
});

// ---------------------------------------------------------------------------
// 打ち切り（timeoutMs）と中止（signal）
// ---------------------------------------------------------------------------

const never = (): Promise<never> => new Promise<never>(() => {});
const idsOf = (n: number): CandidateCrs[] =>
  Array.from({ length: n }, (_, index) => ({ authority: 'MOCK', code: `C${index + 1}` }));

describe('打ち切りと中止', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) 2 件目が答えないと timeoutMs で failed（理由 timeout）にし、3 件目を呼ばない', async () => {
    const spy = recording((id) => (id === 'MOCK:C2' ? never() : null));
    const started = performance.now();
    const result = await estimateCrs(teiresiasE2eGcps, idsOf(3), { transformer: spy.transformer, timeoutMs: 50 });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2_000);
    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure?.reason).toBe('timeout');
    expect(result.failure?.candidates.at(-1)).toMatchObject({ id: 'MOCK:C2', kind: 'adapter-timeout' });
    expect(spy.calls.map((call) => call.id)).toEqual(['MOCK:C1', 'MOCK:C2']);
    assertInvariants(result, idsOf(3));
  });

  it('打ち切りの前の実装失敗も failure.candidates に入り、打ち切った 1 件が最後に来る', async () => {
    const transformer: CandidateTransformer = (id) => {
      if (id === 'MOCK:C1') throw new Error('first');
      return never();
    };
    const result = await estimateCrs(teiresiasE2eGcps, idsOf(3), { transformer, timeoutMs: 20 });
    expect(result.failure?.reason).toBe('timeout');
    expect(result.failure?.candidates.map((c) => [c.id, c.kind])).toEqual([
      ['MOCK:C1', 'adapter-bug'],
      ['MOCK:C2', 'adapter-timeout'],
    ]);
  });

  it('(b)(f) timeoutMs 未指定は既定 120000 ms（119,999 ms では止まらず 120,000 ms で止まる）・タイマーが残らない', async () => {
    vi.useFakeTimers();
    let settled: EstimationResult | undefined;
    const pending = estimateCrs(teiresiasE2eGcps, idsOf(1), { transformer: () => never() }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled?.status).toBe('failed');
    expect(settled?.failure?.reason).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(c) timeoutMs: Infinity では止まらない', async () => {
    vi.useFakeTimers();
    let settled = false;
    void estimateCrs(teiresiasE2eGcps, idsOf(1), { transformer: () => never(), timeoutMs: Infinity }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1e9);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(f) 正常に終わった推定もタイマーを残さない', async () => {
    vi.useFakeTimers();
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer: asyncMockTransformer });
    expect(result.failure).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(d) 3 件目の評価中に abort すると AbortError で reject し、4 件目以降を呼ばない', async () => {
    const controller = new AbortController();
    const spy = recording((id) => {
      if (id === 'MOCK:C3') {
        setTimeout(() => controller.abort(), 10);
        return never();
      }
      return null;
    });
    await expect(
      estimateCrs(teiresiasE2eGcps, idsOf(5), { transformer: spy.transformer, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy.calls.map((call) => call.id)).toEqual(['MOCK:C1', 'MOCK:C2', 'MOCK:C3']);
  });

  it('abort の理由を渡したらその値で reject する', async () => {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    const transformer: CandidateTransformer = () => {
      controller.abort(reason);
      return never();
    };
    await expect(
      estimateCrs(teiresiasE2eGcps, idsOf(2), { transformer, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it('同期の transformer の中で abort されたら、次の候補へ進まずに reject する', async () => {
    const controller = new AbortController();
    const spy = recording((id) => {
      if (id === 'MOCK:C1') controller.abort();
      return null;
    });
    await expect(
      estimateCrs(teiresiasE2eGcps, idsOf(3), { transformer: spy.transformer, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy.calls.map((call) => call.id)).toEqual(['MOCK:C1']);
  });

  it('(e) 開始前に abort 済みなら transformer を 1 回も呼ばずに reject する', async () => {
    const spy = recording(mockTransformer);
    const controller = new AbortController();
    controller.abort();
    await expect(
      estimateCrs(teiresiasE2eGcps, [planeA], { transformer: spy.transformer, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy.calls).toHaveLength(0);
  });

  it('打ち切られた呼び出しが後から reject しても、結果にも未処理の reject にも影響しない', async () => {
    let rejectLate: ((error: Error) => void) | undefined;
    const transformer: CandidateTransformer = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const result = await estimateCrs(teiresiasE2eGcps, idsOf(1), { transformer, timeoutMs: 10 });
    expect(result.failure?.reason).toBe('timeout');
    rejectLate?.(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.failure?.candidates).toHaveLength(1);
  });

  it('正の数でない timeoutMs・非数は既定 120000 ms へ正規化する', async () => {
    vi.useFakeTimers();
    for (const timeoutMs of [0, -1, Number.NaN, -Infinity]) {
      let settled: EstimationResult | undefined;
      const pending = estimateCrs(teiresiasE2eGcps, idsOf(1), { transformer: () => never(), timeoutMs }).then(
        (result) => {
          settled = result;
        },
      );
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled?.failure?.reason).toBe('timeout');
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setTimeout の上限（2147483647 ms）を越える timeoutMs は打ち切りなし（Infinity）として扱う', async () => {
    // 上限を越える遅延は setTimeout が 1 ms へ置き換えるため、そのまま渡すと即座に打ち切りになる
    const answerLater: CandidateTransformer = (id, points, geoBasis) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(mockTransformer(id, points, geoBasis)), 30);
      });
    for (const timeoutMs of [2 ** 31, 30 * 24 * 60 * 60 * 1000, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
      const result = await estimateCrs(teiresiasE2eGcps, [planeA], { transformer: answerLater, timeoutMs });
      expect(result.failure).toBeNull();
      expect(result.status).not.toBe('failed');
      expect(result.selected?.identity.code).toBe('PLANE-A');
    }
  });

  it('上限ちょうど（2147483647 ms）はそのまま上限として効く', async () => {
    vi.useFakeTimers();
    let settled: EstimationResult | undefined;
    const pending = estimateCrs(teiresiasE2eGcps, idsOf(1), {
      transformer: () => never(),
      timeoutMs: 2_147_483_647,
    }).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled?.failure?.reason).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transformer の中で同期に abort され、後で reject する promise を返しても未処理の reject を出さない', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      const transformer: CandidateTransformer = () => {
        controller.abort();
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('rejected after abort')), 5);
        });
      };
      await expect(
        estimateCrs(teiresiasE2eGcps, idsOf(2), { transformer, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// 失敗経路の計算量（候補数に対して線形）
// ---------------------------------------------------------------------------

/** 全候補が業務的 null の推定の所要時間（ms）。 */
async function timeAllNull(count: number): Promise<number> {
  const candidates = idsOf(count);
  const started = performance.now();
  const result = await estimateCrs(teiresiasE2eGcps, candidates, { transformer: () => null });
  const elapsed = performance.now() - started;
  expect(result.untransformableIds).toHaveLength(count);
  return elapsed;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('失敗経路は候補数に対して線形', () => {
  it('候補 20,000 件と 80,000 件の所要時間の中央値の比が 8 未満（線形なら約 4、二次なら約 16）', async () => {
    await timeAllNull(2_000); // JIT の暖機
    const small: number[] = [];
    const large: number[] = [];
    for (let round = 0; round < 3; round++) {
      small.push(await timeAllNull(20_000));
      large.push(await timeAllNull(80_000));
    }
    const ratio = median(large) / median(small);
    console.info(
      `[linear-failure-path] 20000: ${small.map((v) => v.toFixed(1)).join(', ')} ms / ` +
        `80000: ${large.map((v) => v.toFixed(1)).join(', ')} ms / ratio ${ratio.toFixed(2)}`,
    );
    expect(ratio).toBeLessThan(8);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 診断の粒度
// ---------------------------------------------------------------------------

describe('診断の粒度', () => {
  it('(a) 空入力に [] を返す transformer は adapter-contract-failure で failed', async () => {
    const result = await estimateCrs([], [planeA], { transformer: () => [] });
    expect(result.status).toBe('failed');
    expect(result.failure).toEqual({
      reason: 'implementation-failure',
      candidates: [{ id: 'MOCK:PLANE-A', kind: 'adapter-contract-failure', message: 'empty input must give null' }],
    });
  });

  it('(b) 非有限の点は message に点の番号', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA], { transformer: nonFiniteOutputMockTransformer });
    expect(result.failure?.candidates).toEqual([
      { id: 'MOCK:PLANE-A', kind: 'adapter-contract-failure', message: 'point 0 is not a pair of finite numbers' },
    ]);
  });

  it('配列でない出力は message が not an array', async () => {
    const transformer = (() => ({ length: 5 })) as unknown as CandidateTransformer;
    const result = await estimateCrs(teiresiasE2eGcps, [planeA], { transformer });
    expect(result.failure?.candidates[0]).toEqual({
      id: 'MOCK:PLANE-A',
      kind: 'adapter-contract-failure',
      message: 'not an array',
    });
  });

  it('(c) 長い message は 500 文字で切れる・Error でない throw は文字列にする', async () => {
    const long = await estimateCrs(teiresiasE2eGcps, [planeA], {
      transformer: () => {
        throw new Error('x'.repeat(2_000));
      },
    });
    expect(long.failure?.candidates[0].message).toBe('x'.repeat(500));

    const nonError = await estimateCrs(teiresiasE2eGcps, [planeA], {
      transformer: () => {
        throw 42;
      },
    });
    expect(nonError.failure?.candidates[0].message).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// holdout（Daedalus の holdout 検証へ渡す）
// ---------------------------------------------------------------------------

/** pixel → lon/lat に shear を含む写像（相似では表せない）。 */
const shearedGeoOf = (u: number, v: number): [number, number] => [
  135 + u * 0.0078125 + v * 0.001953125,
  35 + v * 0.0078125,
];
/** GCP 5 点。pixel に小さな誤差を入れる（誤差 0 の affine は F 検定が成り立たない）。 */
const shearedGcps: GcpPair[] = (
  [
    [0, 0, 0.01, 0],
    [10, 0, 0, -0.01],
    [0, 10, -0.01, 0.01],
    [10, 10, 0.01, 0.01],
    [4, 6, 0, 0],
  ] as const
).map(([u, v, du, dv]) => ({ pixel: [u + du, v + dv], geo: shearedGeoOf(u, v) }));
const shearedHoldout: GcpPair[] = (
  [
    [7, 3],
    [2, 8],
  ] as const
).map(([u, v]) => ({ pixel: [u, v], geo: shearedGeoOf(u, v) }));
const reflect = (pairs: readonly GcpPair[]): GcpPair[] =>
  pairs.map((pair) => ({ pixel: [pair.pixel[0], -pair.pixel[1]], geo: pair.geo }));

describe('holdout', () => {
  it('(a) shear 入りの 5 点と holdout 2 点で affine が採用され、status ok・warnings なし', async () => {
    const result = await estimateCrs(shearedGcps, [planeA, planeB], {
      transformer: mockTransformer,
      holdout: shearedHoldout,
    });
    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual([]);
    expect(result.failure).toBeNull();
    expect(result.selected?.identity.code).toBe('PLANE-A');
    expect(result.selected?.worldFile.xSkew).not.toBe(0);
    assertInvariants(result, [planeA, planeB]);
  });

  it('holdout が無ければ同じ入力は validationSkipped つき（ok_with_warnings）', async () => {
    const result = await estimateCrs(shearedGcps, [planeA, planeB], { transformer: mockTransformer });
    expect(result.status).toBe('ok_with_warnings');
    expect(result.warnings).toEqual([{ code: 'validationSkipped' }]);
  });

  it('(b) transformer の呼び出しは候補数と同じで、各呼び出しの点数は GCP と holdout の和', async () => {
    const spy = recording(mockTransformer);
    await estimateCrs(shearedGcps, [planeA, planeB], { transformer: spy.transformer, holdout: shearedHoldout });
    expect(spy.calls).toHaveLength(2);
    for (const call of spy.calls) {
      expect(call.points).toEqual([...shearedGcps, ...shearedHoldout].map((pair) => pair.geo));
    }
  });

  it('(c) 反射ありの同じ入力（GCP と holdout の pixel の y を反転）は identity と RMS が同じで、xSkew と yScale の符号だけが反転', async () => {
    const forward = await estimateCrs(shearedGcps, [planeA, planeB], {
      transformer: mockTransformer,
      holdout: shearedHoldout,
    });
    const reflected = await estimateCrs(reflect(shearedGcps), [planeA, planeB], {
      transformer: mockTransformer,
      holdout: reflect(shearedHoldout),
    });
    expect(reflected.status).toBe('ok');
    expect(reflected.selected?.identity).toEqual(forward.selected?.identity);
    expect(reflected.selected?.rmsMeters).toBe(forward.selected?.rmsMeters);
    const f = forward.selected?.worldFile;
    const r = reflected.selected?.worldFile;
    expect(r).toEqual({
      xScale: f?.xScale,
      xSkew: -(f?.xSkew as number),
      xOrigin: f?.xOrigin,
      ySkew: f?.ySkew,
      yScale: -(f?.yScale as number),
      yOrigin: f?.yOrigin,
    });
  });

  it('(d) holdout: [] は未指定と同じ結果', async () => {
    const without = await estimateCrs(shearedGcps, [planeA, planeB], { transformer: mockTransformer });
    const empty = await estimateCrs(shearedGcps, [planeA, planeB], { transformer: mockTransformer, holdout: [] });
    expect(empty).toEqual(without);
  });

  it('GCP と holdout をつないだ点列の長さが合わなければ adapter-contract-failure', async () => {
    const result = await estimateCrs(shearedGcps, [planeA], {
      transformer: brokenLengthMockTransformer,
      holdout: shearedHoldout,
    });
    expect(result.failure?.candidates[0]).toEqual({
      id: 'MOCK:PLANE-A',
      kind: 'adapter-contract-failure',
      message: 'expected 7 points, got 6',
    });
  });
});
