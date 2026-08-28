/**
 * 公開 API の compile-time smoke（m1-t1 設計 §3.1 / §8 AC-SCAFFOLD）。
 *
 * 本ファイルは `pnpm --ignore-workspace run test:types` が tsc CLI の**明示対象**にしている。
 * Vitest の transform は型を検査しないため、公開型の drift はこの経路でだけ検出できる。
 * ∴ 公開型の構造を**値の形**で束縛し、局所変異が TS エラーとして発火するようにしてある
 * （発火実証は m1-t1 設計 §15.2 T1 の義務。task-state に実測を記録する）。
 *
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedCrsInfo } from '@c4h/atlas';

import { estimateCrs } from '../src/index.js';
import type {
  CandidateCrs,
  CandidateTransformer,
  EstimateOptions,
  EstimationResult,
  FitStatus,
  FitWarning,
  GcpPair,
  GeoBasis,
  MaybePromise,
  QualityGate,
  WorldFile,
} from '../src/index.js';

// --- CandidateCrs: 3 フィールドの型を値で束縛する -----------------------------
const candidate: CandidateCrs = { authority: 'MOCK', code: 'PLANE-A', datumFamily: 'MOCKDATUM' };
const candidateWithoutDatumFamily: CandidateCrs = { authority: 'MOCK', code: 'PLANE-B' };

// --- CandidateTransformer: 引数 3 個・戻り値 MaybePromise<Array|null> ---------
const syncTransformer: CandidateTransformer = (
  id: string,
  points: ReadonlyArray<readonly [number, number]>,
  geoBasis: GeoBasis,
): MaybePromise<Array<[number, number]> | null> => {
  if (points.length === 0 || id === '' || geoBasis.kind !== 'lonlat_deg') return null;
  return points.map(([lon, lat]): [number, number] => [lon, lat]);
};

const asyncTransformer: CandidateTransformer = async (_id, points) =>
  points.map(([lon, lat]): [number, number] => [lon, lat]);

// --- EstimateOptions: 全フィールドの型を束縛する -------------------------------
const fullOptions: EstimateOptions = {
  transformer: syncTransformer,
  geoBasis: { kind: 'lonlat_deg', axisOrder: 'lon-lat' },
  minCandidates: 1,
  topK: 2,
  normalizeEpsilonMeters: 100,
  datumFamilyPrior: ['MOCKDATUM'],
};

const minimalOptions: EstimateOptions = { transformer: asyncTransformer };

// --- GcpPair / WorldFile / QualityGate / FitStatus / FitWarning ---------------
const gcps: readonly GcpPair[] = [
  { pixel: [0, 0], geo: [135, 35] },
  { pixel: [10, 10], geo: [135.078125, 35.078125] },
];

const worldFile: WorldFile = {
  xScale: 1,
  xSkew: 0,
  xOrigin: 0,
  ySkew: 0,
  yScale: 1,
  yOrigin: 0,
};

const gate: QualityGate = 'adoptable';
const status: FitStatus = 'ok_with_warnings';
const warning: FitWarning = { code: 'validationSkipped' };

// --- EstimationResult: 5 フィールドと selected の内訳を型で束縛する -------------
const emptyResult: EstimationResult = {
  status,
  selected: null,
  ranked: [],
  warnings: [warning],
  untransformableIds: [],
};

const selectedResult: EstimationResult = {
  status: 'ok',
  selected: {
    identity: { authority: candidate.authority, code: candidate.code },
    worldFile,
    score: 0.5,
    rmsMeters: 12.5,
    qualityGate: gate,
  },
  ranked: [{ authority: candidate.authority, code: candidate.code, score: 0.5, rmsMeters: 12.5 }],
  warnings: [],
  untransformableIds: ['MOCK:PLANE-B'],
};

// --- m2a-t1/AC-1(a): ProjectedCrsInfo → CandidateCrs の assignability ----------
// Atlas の `ProjectedCrsInfo` が Teiresias の `CandidateCrs` へ **型レベルで** assignable で
// あることを固定する（仕様 v0.3 AC-m2a-1(a)）。値の生成は不要で、型だけで完結させる。
// 本 assert が発火するのは tsc CLI 経路だけである — vitest は型を検査しない。
//
// ⚠️ **発火するのは `test:types:atlas`（moduleResolution Bundler）だけである。**
// `test:types`（moduleResolution NodeNext）では `ProjectedCrsInfo` が **`any` へ縮退する**ため
// 本行は常に通ってしまう（＝ vacuous になる）。原因は Atlas の `dist/*.d.ts` が相対 import を
// 拡張子なしで出力していること（NodeNext では TS2834。`--skipLibCheck` がそのエラーを黙らせ、
// 再 export された名前がすべて `any` になる）。実装時の実測:
//   `const probe: number = projectedCrsInfo;` を一時的に足すと
//     NodeNext → exit 0（縮退している ∴ 検査が効いていない）
//     Bundler  → `error TS2322: Type 'ProjectedCrsInfo' is not assignable to type 'number'`
// ∴ 本 AC の検査経路として `test:types:atlas` を追加した（設計 §5.2 からの逸脱。理由は
// 設計が「`test:types` の明示対象は api-smoke.test.ts だけ」という前提のみで置き場所を決めており、
// **その経路で型が実際に解決するか**を測っていなかったことにある）。
// Atlas 側の d.ts 出力そのものの是正は本タスクの触り先外である ∴ findings として m2b へ渡す。
// 束縛は**純粋に型レベル**で行う（`declare const` + 代入だと、型は消えても代入文が残り
// vitest 実行時に ReferenceError になる）。
type AssertAssignableTo<Target, Source extends Target> = Source;
export type ProjectedCrsInfoIsAssignableToCandidateCrs = AssertAssignableTo<
  CandidateCrs,
  ProjectedCrsInfo
>;

// --- estimateCrs の signature -------------------------------------------------
const invoke = (): Promise<EstimationResult> => estimateCrs(gcps, [candidate], fullOptions);

describe('api smoke（公開型と estimateCrs signature の compile-time 束縛）', () => {
  it('estimateCrs は Promise<EstimationResult> を返し、5 フィールドが型どおりである', async () => {
    const result: EstimationResult = await invoke();
    const resultStatus: FitStatus = result.status;
    const selected: EstimationResult['selected'] = result.selected;
    const ranked: EstimationResult['ranked'] = result.ranked;
    const warnings: readonly FitWarning[] = result.warnings;
    const untransformableIds: string[] = result.untransformableIds;

    expect(typeof resultStatus).toBe('string');
    expect(Array.isArray(ranked)).toBe(true);
    expect(Array.isArray(warnings)).toBe(true);
    expect(Array.isArray(untransformableIds)).toBe(true);

    if (selected !== null) {
      const selectedGate: Exclude<QualityGate, 'unusable'> = selected.qualityGate;
      const selectedWorldFile: WorldFile = selected.worldFile;
      const selectedScore: number | null = selected.score;
      const selectedRms: number = selected.rmsMeters;
      expect(typeof selectedGate).toBe('string');
      expect(Object.keys(selectedWorldFile)).toHaveLength(6);
      expect(selectedScore === null || Number.isFinite(selectedScore)).toBe(true);
      expect(Number.isFinite(selectedRms)).toBe(true);
    }
  });

  it('型束縛に使った定数がそのまま実体を持つ', () => {
    expect(candidate.datumFamily).toBe('MOCKDATUM');
    expect(candidateWithoutDatumFamily.datumFamily).toBeUndefined();
    expect(fullOptions.datumFamilyPrior).toEqual(['MOCKDATUM']);
    expect(minimalOptions.geoBasis).toBeUndefined();
    expect(gcps).toHaveLength(2);
    expect(Object.keys(worldFile)).toEqual([
      'xScale',
      'xSkew',
      'xOrigin',
      'ySkew',
      'yScale',
      'yOrigin',
    ]);
    expect(gate).toBe('adoptable');
    expect(status).toBe('ok_with_warnings');
    expect(warning.code).toBe('validationSkipped');
  });

  it('transformer は同期・非同期のどちらも CandidateTransformer に適合する', async () => {
    const lonlat: GeoBasis = { kind: 'lonlat_deg', axisOrder: 'lon-lat' };
    expect(syncTransformer('MOCK:PLANE-A', [], lonlat)).toBeNull();
    expect(syncTransformer('MOCK:PLANE-A', [[135, 35]], lonlat)).toEqual([[135, 35]]);
    await expect(asyncTransformer('MOCK:PLANE-A', [[135, 35]], lonlat)).resolves.toEqual([
      [135, 35],
    ]);
  });

  it('EstimationResult の 2 形（selected あり / なし）が型に適合する', () => {
    expect(emptyResult.selected).toBeNull();
    expect(selectedResult.selected?.identity.code).toBe('PLANE-A');
    expect(selectedResult.ranked[0]?.rmsMeters).toBe(12.5);
    expect(selectedResult.untransformableIds).toEqual(['MOCK:PLANE-B']);
  });
});
