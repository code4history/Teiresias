/**
 * 識別力の比（`demo/estimate-scene.js` の `discriminationOf`）の単体テスト。
 *
 * 比べる相手は「1 位と**定義が違う**最初の候補」である。同じ定義の候補（真値の縮退クラス）が
 * 1 位から続いても、比が 1 に近づいて「潰れている」と誤って出ない。定義が分かるのは
 * `proj4ById`（`${authority}:${code}` → `proj4`）に両方の候補が在り、文字列として等しいときだけ
 * である。分からない候補は「違う定義」として扱う（第 2 引数を渡さない呼び出しでは、これまでと
 * 同じく 2 位との比になる）。
 */
import { describe, expect, it } from 'vitest';

import { COLLAPSE_THRESHOLD, discriminationOf } from '../demo/estimate-scene.js';

type Ranked = { id: string; rmsMeters: number };

function rankedOf(rows: ReadonlyArray<readonly [string, number]>): Ranked[] {
  return rows.map(([id, rmsMeters]) => ({ id, rmsMeters }));
}

describe('discriminationOf: 比べる相手（定義の違う最初の候補）', () => {
  it('(a) 1 位と 2 位が同じ定義なら、比は 3 位との比になり、against は 3 位になる', () => {
    const ranked = rankedOf([
      ['EPSG:6674', 2],
      ['EPSG:2448', 2], // 1 位と同じ定義
      ['EPSG:6673', 8],
      ['EPSG:3094', 40],
    ]);
    const proj4ById = new Map([
      ['EPSG:6674', '+proj=tmerc +zone=6'],
      ['EPSG:2448', '+proj=tmerc +zone=6'],
      ['EPSG:6673', '+proj=tmerc +zone=5'],
      ['EPSG:3094', '+proj=tmerc +zone=9'],
    ]);

    const report = discriminationOf(ranked, proj4ById);
    expect(report.against).toBe('EPSG:6673');
    expect(report.top2Rms).toBe(8);
    expect(report.ratio).toBe(4);
    expect(report.collapsed).toBe(false);
  });

  it('(b) 第 2 引数を渡さなければ、これまでどおり 2 位との比になる', () => {
    const ranked = rankedOf([
      ['EPSG:6674', 2],
      ['EPSG:2448', 3],
      ['EPSG:6673', 8],
    ]);

    const report = discriminationOf(ranked);
    expect(report.against).toBe('EPSG:2448');
    expect(report.top2Rms).toBe(3);
    expect(report.ratio).toBe(1.5);
    expect(report.ratio).toBe(discriminationOf(ranked).ratio);
  });

  it('(c) proj4 が分からない候補は違う定義として扱う', () => {
    const ranked = rankedOf([
      ['EPSG:6674', 2],
      ['EPSG:2448', 2],
      ['EPSG:6673', 8],
    ]);

    // 1 位だけ proj4 が分かる（2 位は分からない）∴ 2 位が「違う定義」になる
    const unknownSecond = new Map([['EPSG:6674', '+proj=tmerc +zone=6']]);
    expect(discriminationOf(ranked, unknownSecond)).toMatchObject({ against: 'EPSG:2448', ratio: 1 });

    // 1 位が分からない ∴ 2 位が「違う定義」になる
    const unknownFirst = new Map([
      ['EPSG:2448', '+proj=tmerc +zone=6'],
      ['EPSG:6673', '+proj=tmerc +zone=5'],
    ]);
    expect(discriminationOf(ranked, unknownFirst)).toMatchObject({ against: 'EPSG:2448', ratio: 1 });
  });

  it('(d) 全件が同じ定義なら、比べる相手が無い ∴ ratio と collapsed は null', () => {
    const ranked = rankedOf([
      ['EPSG:6674', 1],
      ['EPSG:2448', 1.0001],
      ['ESRI:112206', 1.0002],
    ]);
    const proj4ById = new Map([
      ['EPSG:6674', '+proj=tmerc +zone=6'],
      ['EPSG:2448', '+proj=tmerc +zone=6'],
      ['ESRI:112206', '+proj=tmerc +zone=6'],
    ]);

    const report = discriminationOf(ranked, proj4ById);
    expect(report.ratio).toBeNull();
    expect(report.collapsed).toBeNull();
    expect(report.against).toBeNull();
  });

  it('縮退クラスの分だけ 2 位以降を読み飛ばしても、潰れた比は潰れたまま出る', () => {
    const ranked = rankedOf([
      ['EPSG:6674', 1],
      ['EPSG:2448', 1.00005],
      ['ESRI:112206', 1.0001],
      ['EPSG:3094', 1.00025 * 1], // 比 = 1.00025（< 閾値）
    ]);
    const proj4ById = new Map([
      ['EPSG:6674', '+proj=tmerc +zone=6'],
      ['EPSG:2448', '+proj=tmerc +zone=6'],
      ['ESRI:112206', '+proj=tmerc +zone=6'],
      ['EPSG:3094', '+proj=tmerc +zone=9'],
    ]);

    const report = discriminationOf(ranked, proj4ById);
    expect(report.against).toBe('EPSG:3094');
    expect(report.ratio as number).toBeCloseTo(1.00025, 10);
    expect(report.ratio as number).toBeLessThan(COLLAPSE_THRESHOLD);
    expect(report.collapsed).toBe(true);
  });
});
