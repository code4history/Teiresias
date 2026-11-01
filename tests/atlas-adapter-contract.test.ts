/**
 * Atlas の公開 adapter `createCandidateTransformer` と Teiresias の `CandidateTransformer` の
 * 型の接続（compile-time）。
 *
 * 本ファイルは `test:types:atlas`（`moduleResolution Bundler`）の明示対象である。Vitest の
 * transform は型を検査しないため、Atlas 側の adapter の型が Teiresias の `CandidateTransformer`
 * から外れたことは tsc の経路でだけ検出できる。
 *
 * Atlas は Teiresias に依存せず、型は構造で合わせている ∴ 代入が通ることそのものが契約である。
 */
import { describe, expect, it } from 'vitest';

import { createCandidateTransformer, type ProjectedCrsInfo } from '@c4h/atlas';

import type { CandidateTransformer } from '../src/index.js';

const rows: ReadonlyArray<Pick<ProjectedCrsInfo, 'id' | 'proj4'>> = [
  { id: 'EPSG:6674', proj4: '+proj=tmerc +lat_0=36 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs' },
];

// 型の接続: Atlas の adapter の戻り値を、そのまま Teiresias の `CandidateTransformer` として受ける。
const transformer: CandidateTransformer = createCandidateTransformer(rows);

describe('Atlas adapter contract', () => {
  it('Atlas の adapter が Teiresias の CandidateTransformer として代入できる', () => {
    expect(transformer).toBeTypeOf('function');
  });

  it('lon-lat 以外の geoBasis と知らない id は null（engine を起こさずに決まる分）', async () => {
    expect(await transformer('EPSG:6674', [[135.75, 35.0]], { kind: 'planar_xy', axisOrder: 'xy', unit: 'm' })).toBeNull();
    expect(await transformer('EPSG:9999', [[135.75, 35.0]], { kind: 'lonlat_deg', axisOrder: 'lon-lat' })).toBeNull();
  });
});
