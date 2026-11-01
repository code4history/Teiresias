/**
 * `@c4h/daedalus` の返却が公開契約と食い違う場合（`dependency-contract-failure`）を、公開 API
 * （`estimateCrs`）から到達させて確かめる。
 *
 * `vi.mock` はファイル全体に効くので、他のテストと分けてこのファイルに置く。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { estimateCrs } from '../src/index.js';
import { mockTransformer, teiresiasE2eGcps } from './fixtures/mockTransformer.js';

import type { CandidateCrs } from '../src/index.js';

const brokenRms = vi.hoisted(() => ({ active: false }));

vi.mock('@c4h/daedalus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@c4h/daedalus')>();
  return {
    ...actual,
    fitWorldFile: (...args: Parameters<typeof actual.fitWorldFile>) => {
      const fit = actual.fitWorldFile(...args);
      // 成功した fit の rmsMeters だけを非有限にする（公開契約では成功時は有限値）
      return brokenRms.active ? { ...fit, rmsMeters: Number.NaN } : fit;
    },
  };
});

const planeA: CandidateCrs = { authority: 'MOCK', code: 'PLANE-A' };
const planeB: CandidateCrs = { authority: 'MOCK', code: 'PLANE-B' };

describe('依存先の契約違反（dependency-contract-failure）', () => {
  afterEach(() => {
    brokenRms.active = false;
  });

  it('fit の rmsMeters が非有限なら failed（理由 implementation-failure）にし、候補を untransformableIds へは入れない', async () => {
    brokenRms.active = true;
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer: mockTransformer });

    expect(result.status).toBe('failed');
    expect(result.selected).toBeNull();
    expect(result.failure?.reason).toBe('implementation-failure');
    expect(result.failure?.candidates.map((c) => [c.id, c.kind])).toEqual([
      ['MOCK:PLANE-A', 'dependency-contract-failure'],
      ['MOCK:PLANE-B', 'dependency-contract-failure'],
    ]);
    expect(result.untransformableIds).toEqual([]);
  });

  it('契約違反が無ければ同じ入力で failure は null（mock が既定では素通しであることの確認）', async () => {
    const result = await estimateCrs(teiresiasE2eGcps, [planeA, planeB], { transformer: mockTransformer });
    expect(result.failure).toBeNull();
    expect(result.selected).not.toBeNull();
  });
});
