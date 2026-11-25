import { describe, expect, it } from 'vitest';

import {
  CRS_SWITCH_MAX_RATIO,
  TRANSFORM_SETUP_THRESHOLDS,
  recommendTransformSetup,
  recommendTransformSetupFromScore,
  shouldRecommendCrsSwitch,
} from '../src/index.js';
import type { EstimationResult } from '../src/index.js';

// 境界方式の比較（2026-11-25）の 7 枚の score と、そのときの推奨
const MAPS: Array<[string, number, string[]]> = [
  ['伏見城図', 0.0017, ['worldFileOnly']],
  ['延岡市街地図', 0.0163, ['tinGlobal']],
  ['広島城所絵図', 0.02, ['tinGlobal']],
  ['館林城絵図', 0.0294, ['tinGlobal']],
  ['山形城下絵図', 0.0309, ['tinGlobal', 'tinFan']],
  ['奈良町絵図 v2', 0.0393, ['tinFan', 'tinGlobal']],
  ['奈良町絵図', 0.0513, ['tinFan']],
];

function result(overrides: Partial<NonNullable<EstimationResult['selected']>> = {}, status: EstimationResult['status'] = 'ok'): EstimationResult {
  return {
    status,
    selected: {
      identity: { authority: 'EPSG', code: '6674' },
      worldFile: { xScale: 1, xSkew: 0, xOrigin: 0, ySkew: 0, yScale: -1, yOrigin: 0 } as never,
      unit: { name: 'metre', metresPerUnit: 1 },
      score: 0.02,
      rmsMeters: 30,
      qualityGate: 'adoptable',
      ...overrides,
    },
    ranked: [],
    warnings: [],
    untransformableIds: [],
    failure: null,
  };
}

describe('recommendTransformSetupFromScore', () => {
  for (const [name, score, expected] of MAPS) {
    it(`${name}（score ${score}）は ${expected.join(' と ')}`, () => {
      expect(recommendTransformSetupFromScore(score).setups).toEqual(expected);
    });
  }

  it('境の近くは borderline、近い側を先に並べる', () => {
    const [lo, hi] = TRANSFORM_SETUP_THRESHOLDS.worldFileOnlyBand;
    expect(recommendTransformSetupFromScore(lo)).toEqual({ setups: ['worldFileOnly', 'tinGlobal'], reason: 'borderline', score: lo });
    expect(recommendTransformSetupFromScore(TRANSFORM_SETUP_THRESHOLDS.worldFileOnly).setups).toEqual(['tinGlobal', 'worldFileOnly']);
    expect(recommendTransformSetupFromScore(hi)).toEqual({ setups: ['tinGlobal'], reason: 'clear', score: hi });
    expect(recommendTransformSetupFromScore(TRANSFORM_SETUP_THRESHOLDS.fan).setups).toEqual(['tinFan', 'tinGlobal']);
    expect(recommendTransformSetupFromScore(TRANSFORM_SETUP_THRESHOLDS.fanBand[1])).toEqual({ setups: ['tinFan'], reason: 'clear', score: 0.04 });
  });

  it('境界値ちょうどの扱い（下端を含み上端を含まない）', () => {
    expect(recommendTransformSetupFromScore(0)).toEqual({ setups: ['worldFileOnly'], reason: 'clear', score: 0 });
    expect(recommendTransformSetupFromScore(0.005)).toEqual({ setups: ['tinGlobal', 'worldFileOnly'], reason: 'borderline', score: 0.005 });
    expect(recommendTransformSetupFromScore(0.03)).toEqual({ setups: ['tinGlobal', 'tinFan'], reason: 'borderline', score: 0.03 });
    expect(recommendTransformSetupFromScore(0.035)).toEqual({ setups: ['tinFan', 'tinGlobal'], reason: 'borderline', score: 0.035 });
  });

  it('鳥瞰図は境の近くより優先し、不正な score は鳥瞰図より優先する', () => {
    expect(recommendTransformSetupFromScore(0.035, { vertexMode: 'birdeye' })).toEqual({ setups: ['tinFan'], reason: 'birdeye', score: 0.035 });
    expect(recommendTransformSetupFromScore(Number.NaN, { vertexMode: 'birdeye' })).toEqual({ setups: [], reason: 'unavailable', score: null });
  });

  it('鳥瞰図は tinFan だけ', () => {
    expect(recommendTransformSetupFromScore(0.001, { vertexMode: 'birdeye' })).toEqual({ setups: ['tinFan'], reason: 'birdeye', score: 0.001 });
  });

  it('非有限・負の score は推奨しない', () => {
    for (const s of [Number.NaN, Infinity, -Infinity, -0.01]) {
      expect(recommendTransformSetupFromScore(s)).toEqual({ setups: [], reason: 'unavailable', score: null });
    }
  });
});

describe('recommendTransformSetup', () => {
  it('ok と ok_with_warnings は score から推奨する', () => {
    expect(recommendTransformSetup(result()).setups).toEqual(['tinGlobal']);
    expect(recommendTransformSetup(result({}, 'ok_with_warnings')).setups).toEqual(['tinGlobal']);
  });

  it('使えない推定結果では推奨しない', () => {
    const none = { setups: [], reason: 'unavailable', score: null };
    expect(recommendTransformSetup(result({}, 'insufficient'))).toEqual(none);
    expect(recommendTransformSetup(result({}, 'failed'))).toEqual(none);
    expect(recommendTransformSetup({ ...result(), selected: null })).toEqual(none);
    expect(recommendTransformSetup(result({ score: null }))).toEqual(none);
    expect(recommendTransformSetup(result({ qualityGate: 'preview' }))).toEqual(none);
    expect(recommendTransformSetup(result({ score: Number.NaN }))).toEqual(none);
    expect(recommendTransformSetup(result({ score: -0.01 }))).toEqual(none);
  });

  it('鳥瞰図の指定は渡り、使えない推定結果は鳥瞰図より優先する', () => {
    expect(recommendTransformSetup(result(), { vertexMode: 'birdeye' })).toEqual({ setups: ['tinFan'], reason: 'birdeye', score: 0.02 });
    const none = { setups: [], reason: 'unavailable', score: null };
    expect(recommendTransformSetup(result({ qualityGate: 'preview' }), { vertexMode: 'birdeye' })).toEqual(none);
    expect(recommendTransformSetup(result({}, 'failed'), { vertexMode: 'birdeye' })).toEqual(none);
  });
});

describe('shouldRecommendCrsSwitch', () => {
  it('3857 より CRS_SWITCH_MAX_RATIO 倍以下のときだけ乗り換えを推奨する', () => {
    expect(shouldRecommendCrsSwitch(0.02 * CRS_SWITCH_MAX_RATIO, 0.02)).toBe(true);
    expect(shouldRecommendCrsSwitch(0.0199, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0.03, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0.02 * CRS_SWITCH_MAX_RATIO + 1e-12, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0, 0.02)).toBe(true);
  });

  it('どちらかが無い・非有限・3857 が 0 なら推奨しない', () => {
    expect(shouldRecommendCrsSwitch(null, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0.01, null)).toBe(false);
    expect(shouldRecommendCrsSwitch(Number.NaN, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0, 0)).toBe(false);
    expect(shouldRecommendCrsSwitch(-0.01, 0.02)).toBe(false);
    expect(shouldRecommendCrsSwitch(0.01, -0.02)).toBe(false);
    for (const x of [Number.NaN, Infinity, -Infinity]) {
      expect(shouldRecommendCrsSwitch(x, 0.02)).toBe(false);
      expect(shouldRecommendCrsSwitch(0.01, x)).toBe(false);
    }
  });
});
