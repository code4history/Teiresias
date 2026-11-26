/**
 * 適合スコアの分子（候補の CRS の残差）と分母（地上の距離）の尺度をそろえる（Issue #26）。
 *
 * 紙と地上がちょうど相似な地図なら、どの CRS で測っても当てはまりは同じはずで、スコアの比は 1 に近い。
 * 直す前は、縮尺係数が 1 から離れた CRS（3857 は緯度 φ で 1/cos φ 倍）ほどスコアが大きく出た。
 */
import { describe, expect, it, vi } from 'vitest';

import { estimateCrs } from '../src/index.js';
import type { CandidateTransformer, EstimationResult, GeoBasis } from '../src/index.js';

import {
  PLANE_IX,
  UTM_54N,
  WEB_MERCATOR,
  atlasTransformer,
  groundOf,
  lonLatGrid,
  realMapCases,
  similarityMap,
  webMercatorOf,
} from './fixtures/scoreGroundScaleCases.js';
import { REAL_ENGINE_TEST_TIMEOUT_MS } from './fixtures/timeouts.js';

vi.setConfig({ testTimeout: REAL_ENGINE_TEST_TIMEOUT_MS });

/** 3857 からの乗り換えを勧める規則の境（平面直角座標系のスコア ÷ 3857 のスコア がこれ以下で成立）。 */
const SWITCH_MAX_RATIO = 0.95;

function scoreOf(result: EstimationResult, id: string): number {
  const entry = result.ranked.find((r) => `${r.authority}:${r.code}` === id);
  if (entry === undefined || entry.score === null) throw new Error(`${id} の score が無い`);
  return entry.score;
}

function rmsOf(result: EstimationResult, id: string): number {
  const entry = result.ranked.find((r) => `${r.authority}:${r.code}` === id);
  if (entry === undefined) throw new Error(`${id} が ranked に無い`);
  return entry.rmsMeters;
}

const MOCK_MERC = { authority: 'MOCK', code: 'MERC' } as const;
const MOCK_GROUND = { authority: 'MOCK', code: 'GROUND' } as const;

describe('スコアは地上の距離で比べる（投影の式だけの mock）', () => {
  for (const centre of [
    [139.7, 35.7],
    [141.35, 43.06],
  ] as const) {
    it(`相似の地図では 3857 と地上の写像のスコアの比が 1 に近い（緯度 ${centre[1]}°）`, async () => {
      const ground = groundOf(centre);
      const gcps = similarityMap(lonLatGrid(centre, 5, 0.012), ground, { metresPerPixel: 2, noiseMetres: 12 });
      const transformer: CandidateTransformer = (id, points) =>
        points.map((p) => (id === 'MOCK:MERC' ? webMercatorOf(p) : ground(p)));

      const result = await estimateCrs(gcps, [MOCK_MERC, MOCK_GROUND], { transformer });

      const ratio = scoreOf(result, 'MOCK:MERC') / scoreOf(result, 'MOCK:GROUND');
      expect(ratio).toBeGreaterThan(0.98);
      expect(ratio).toBeLessThan(1.02);
    });
  }

  it('rmsMeters は候補の座標での残差のまま（地上に直すのは score だけ）', async () => {
    const centre = [139.7, 35.7] as const;
    const ground = groundOf(centre);
    const gcps = similarityMap(lonLatGrid(centre, 5, 0.012), ground, { metresPerPixel: 2, noiseMetres: 12 });
    const transformer: CandidateTransformer = (id, points) =>
      points.map((p) => (id === 'MOCK:MERC' ? webMercatorOf(p) : ground(p)));

    const result = await estimateCrs(gcps, [MOCK_MERC, MOCK_GROUND], { transformer });

    // 3857 の座標の残差は、地上の 1/cos φ 倍（≈ 1.23）。score の分子はこれを地上に直した値
    const rmsRatio = rmsOf(result, 'MOCK:MERC') / rmsOf(result, 'MOCK:GROUND');
    expect(rmsRatio).toBeGreaterThan(1 / Math.cos((35.7 * Math.PI) / 180) - 0.03);
    expect(rmsRatio).toBeLessThan(1 / Math.cos((35.7 * Math.PI) / 180) + 0.03);
    // 地上の距離（分母）は候補に依らない: score ÷ rmsMeters の比は候補の縮尺係数の逆数
    const [merc, flat] = ['MOCK:MERC', 'MOCK:GROUND'].map((id) => scoreOf(result, id) / rmsOf(result, id));
    expect(merc / flat).toBeGreaterThan(Math.cos((35.7 * Math.PI) / 180) - 0.03);
    expect(merc / flat).toBeLessThan(Math.cos((35.7 * Math.PI) / 180) + 0.03);
  });
});

describe('ft・縮尺係数が 1 でない候補（入力が平面の座標）', () => {
  const FT = 0.3048;
  const planar: GeoBasis = { kind: 'planar_xy', axisOrder: 'xy', unit: 'ft' };

  it('候補の単位が ft でも、縮尺が 1.3 倍の候補でも、地上の m に直して比べる', async () => {
    // 入力の地上の座標は ft（格子 5×5・間隔 800 ft）
    const grid: Array<[number, number]> = [];
    for (let row = 0; row < 5; row += 1) for (let col = 0; col < 5; col += 1) grid.push([1_000_000 + col * 800, 500_000 + row * 800]);
    const gcps = similarityMap(grid, ([x, y]) => [x * FT, y * FT], { metresPerPixel: 0.5, noiseMetres: 6 });

    const transformer: CandidateTransformer = (id, points) => {
      if (id === 'MOCK:METRE') return points.map(([x, y]) => [x * FT, y * FT]);
      if (id === 'MOCK:FOOT') {
        return { points: points.map(([x, y]) => [x, y] as [number, number]), unit: { name: 'ft', metresPerUnit: FT } };
      }
      if (id === 'MOCK:STRETCH') return points.map(([x, y]) => [x * FT * 1.3, y * FT * 1.3]);
      return null;
    };
    const candidates = [
      { authority: 'MOCK', code: 'METRE' },
      { authority: 'MOCK', code: 'FOOT' },
      { authority: 'MOCK', code: 'STRETCH' },
    ];

    const result = await estimateCrs(gcps, candidates, { transformer, geoBasis: planar });

    const metre = scoreOf(result, 'MOCK:METRE');
    expect(scoreOf(result, 'MOCK:FOOT') / metre).toBeGreaterThan(0.98);
    expect(scoreOf(result, 'MOCK:FOOT') / metre).toBeLessThan(1.02);
    expect(scoreOf(result, 'MOCK:STRETCH') / metre).toBeGreaterThan(0.98);
    expect(scoreOf(result, 'MOCK:STRETCH') / metre).toBeLessThan(1.02);
  });
});

describe('実 engine: 平面直角座標系・UTM（縮尺係数が 1 に近い）と 3857', () => {
  it('相似の地図で、3857 のスコアが平面直角座標系 IX 系・UTM 54N の 0.98〜1.02 倍に収まる', async () => {
    const centre = [139.7, 35.7] as const;
    const transformer = atlasTransformer([PLANE_IX]);
    const lonLats = lonLatGrid(centre, 5, 0.012);
    const ix = await transformer('EPSG:6677', lonLats, { kind: 'lonlat_deg', axisOrder: 'lon-lat' });
    if (ix === null || !Array.isArray(ix)) throw new Error('IX 系への変換に失敗');
    // 紙は IX 系の座標（縮尺係数 0.9999 の地上）を 1/5 に縮め、地上 60 m 相当のゆらぎを足したもの。
    // ゆらぎを古地図なみに大きくするのは、3857 が GRS80 の経緯度を球と見なして東西と南北の縮尺が約 0.45% ずれ、
    // 5 km 四方の格子では 6 m ほどの偏りが出るため（それより小さいゆらぎだと、その偏りが比に現れる）
    const gcps = similarityMap(
      lonLats,
      (point) => ix[lonLats.findIndex((p) => p[0] === point[0] && p[1] === point[1])],
      { metresPerPixel: 5, noiseMetres: 60 },
    );

    const result = await estimateCrs(gcps, [WEB_MERCATOR, PLANE_IX, UTM_54N], {
      transformer: atlasTransformer([WEB_MERCATOR, PLANE_IX, UTM_54N]),
    });

    expect(result.status === 'ok' || result.status === 'ok_with_warnings').toBe(true);
    const base = scoreOf(result, 'EPSG:6677');
    for (const id of ['EPSG:3857', 'EPSG:6691']) {
      const ratio = scoreOf(result, id) / base;
      expect(ratio, id).toBeGreaterThan(0.98);
      expect(ratio, id).toBeLessThan(1.02);
    }
  });

  for (const map of realMapCases()) {
    it(`実地図 ${map.id}（${map.label}）: 3857 からの乗り換えの規則が成立しない`, async () => {
      const result = await estimateCrs(map.gcps, [WEB_MERCATOR, map.plane], {
        transformer: atlasTransformer([WEB_MERCATOR, map.plane]),
      });

      const ratio = scoreOf(result, map.plane.id) / scoreOf(result, 'EPSG:3857');
      // 古地図の GCP の誤差は地図の歪みが主で、CRS の縮尺では変わらない。当てはまりはほぼ同じ
      expect(ratio).toBeGreaterThan(SWITCH_MAX_RATIO);
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThan(1.03);
    });
  }
});
