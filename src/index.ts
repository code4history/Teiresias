/**
 * Teiresias の public root export。
 *
 * `package.json` の `exports` は `"."` のみであり、本ファイルが公開 surface の全数である。
 * ranking / status 導出の内部 helper は**ここから公開しない**。
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
