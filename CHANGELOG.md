# Changelog

このプロジェクトの主な変更を記録します。版数は [Semantic Versioning](https://semver.org/) に従います。
Notable changes to this project are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- 初版。npm に `@c4h/teiresias` として公開します。主な API は `estimateCrs`（対応点と候補の CRS から、もっともよく当たる CRS とワールドファイルを推定する）と、その入出力の型（`CandidateCrs`・`CandidateTransformer`・`EstimateOptions`・`EstimationResult`・`EstimationFailure` ほか）です。全 export は README の公開 API の節にあります。候補と変換関数は `@c4h/atlas` の `listProjectedCrsFromProjWasm` と `createCandidateTransformer` で作れます。
- First release, published to npm as `@c4h/teiresias`. The main API is `estimateCrs` (estimates the CRS and world file that best fit the ground control points among the candidate CRSs) and the types of its input and output (`CandidateCrs`, `CandidateTransformer`, `EstimateOptions`, `EstimationResult`, `EstimationFailure` and others). Every export is listed in the Public API section of the README. The candidates and the transformer can be made with `listProjectedCrsFromProjWasm` and `createCandidateTransformer` of `@c4h/atlas`.
- 既知の制約は README の「[既知の制限](./README.ja.md#既知の制限)」にあります。
- Known limitations are described in "[Known limitations](./README.md#known-limitations)" in the README.
