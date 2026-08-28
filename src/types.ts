/**
 * Teiresias 公開型（m1-t1 設計 §3.1）。
 *
 * `WorldFile` / `GcpPair` / `GeoBasis` / `FitStatus` / `QualityGate` / `FitWarning` /
 * `MaybePromise` は Teiresias で再定義せず、`@c4h/daedalus` の公開型を type import /
 * re-export する（設計 K17。Daedalus `src/types.ts` に構造も意味も同じ型が実在するため、
 * 二重所有による将来 drift を避ける）。
 */
import type { GeoBasis, MaybePromise, QualityGate, WorldFile, FitStatus, FitWarning } from '@c4h/daedalus';

export type {
  FitStatus,
  FitWarning,
  GcpPair,
  GeoBasis,
  MaybePromise,
  QualityGate,
  WorldFile,
} from '@c4h/daedalus';

/**
 * 候補 CRS の最小構造型。
 *
 * Atlas の record 全体へ結合せず、`authority` / `code` / 任意の `datumFamily` だけを要求する
 * （設計 K6）。呼出側から独立した `id` は受け取らない。`id` は Teiresias が
 * `${authority}:${code}` として 1 箇所で組み立てる（設計 §3.2）。
 */
export interface CandidateCrs {
  authority: string;
  code: string;
  datumFamily?: string;
}

/**
 * 候補 CRS への変換 adapter。契約 8 項目の正本は
 * `docs/superpowers/specs/2026-08-28-mock-transformer-contract.md`（親リポジトリ）。
 *
 * - 入力 `points` は `geoBasis` が示す順序の geo 点列（同順）。
 * - 出力は入力と同順同数の projected `[easting, northing]` 点列、または `null`。
 * - 空入力・業務的変換不能はすべて `null`。throw は adapter bug のときのみ。
 * - 同期返却（`MaybePromise` の T 側）と Promise 返却の双方が適合する。
 */
export type CandidateTransformer = (
  id: string,
  points: ReadonlyArray<readonly [number, number]>,
  geoBasis: GeoBasis,
) => MaybePromise<Array<[number, number]> | null>;

/**
 * `estimateCrs` の option。
 *
 * `minCandidates` 既定 1 / `topK` 既定 usable 全件 / `normalizeEpsilonMeters` 既定 100 m。
 * 正の整数でない値・非有限値は既定へ正規化する（設計 K8）。
 * `datumFamilyPrior` は caller 指定順の**弱い prior** であり、score の機械精度同着内でのみ働く
 * （設計 K4）。
 */
export interface EstimateOptions {
  transformer: CandidateTransformer;
  geoBasis?: GeoBasis;
  minCandidates?: number;
  topK?: number;
  normalizeEpsilonMeters?: number;
  datumFamilyPrior?: readonly string[];
}

/**
 * 推定結果。
 *
 * `ranked[].rmsMeters` と `selected.rmsMeters` は **ranking に用いた shear 前 basic RMS**、
 * `selected.worldFile` と `selected.qualityGate` は**同じ候補に対する Daedalus の最終返却**
 * （affine 採用を含み得る）である（設計 K10 / §5.2）。
 *
 * 保存境界: Editor が明示採用した後に永続化してよいのは `selected.identity` と採用 worldFile
 * だけである。`ranked` / `score` / basic RMS / `qualityGate` / `warnings` /
 * `untransformableIds` / `selected` object 全体は診断返却であり保存しない（設計 §6-8）。
 */
export interface EstimationResult {
  status: FitStatus;
  selected: {
    identity: { authority: string; code: string };
    worldFile: WorldFile;
    score: number | null;
    rmsMeters: number;
    qualityGate: Exclude<QualityGate, 'unusable'>;
  } | null;
  ranked: Array<{
    authority: string;
    code: string;
    score: number | null;
    rmsMeters: number;
  }>;
  warnings: readonly FitWarning[];
  untransformableIds: string[];
}
