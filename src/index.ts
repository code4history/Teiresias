/**
 * Teiresias の public root export（m1-t1 設計 §2 / §3.1）。
 *
 * `package.json` の `exports` は `"."` のみであり、本ファイルが公開 surface の全数である。
 * ranking / status 導出の内部 helper は**ここから公開しない**（設計 §5.4 / K14）。
 * テストは `../src/estimate-crs.js` を直接 import して内部 helper を検証する。
 */
export { estimateCrs } from './estimate-crs.js';

export type {
  CandidateCrs,
  CandidateFailure,
  CandidateFailureKind,
  CandidatePoints,
  CandidateTransformer,
  EstimateOptions,
  EstimationFailure,
  EstimationResult,
  FitStatus,
  FitWarning,
  GcpPair,
  GeoBasis,
  LinearUnit,
  MaybePromise,
  QualityGate,
  WorldFile,
} from './types.js';
