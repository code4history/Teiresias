/**
 * m1-t1 の unit test。
 *
 * - AC-T1 (a): Teiresias 所有 mock が `contractPoints` に対して `expectedPlaneA` /
 *   `expectedPlaneB` と各座標 `1e-9` 以内で一致すること（m0-t3 からの委任 AC の前半）。
 * - `CandidateTransformer` 8 項目契約と違反シミュレータの全入力域挙動。
 * - AC-m1-3 / AC-INV は T3（estimateCrs 実装 commit）で本ファイルへ追加する。
 */
import { describe, expect, it } from 'vitest';

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
  unknownId,
} from './fixtures/mockContractFixture.js';
import {
  asyncMockTransformer,
  brokenLengthMockTransformer,
  conformingTransformers,
  mockTransformer,
  nonFiniteOutputMockTransformer,
  rejectingMockTransformer,
  throwingMockTransformer,
} from './fixtures/mockTransformer.js';

import type { GeoBasis } from '../src/index.js';

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
  it('fixture の版が契約文書の 1.0.0 である', () => {
    expect(fixtureVersion).toBe('1.0.0');
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
