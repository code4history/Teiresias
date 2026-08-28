## 1. Specification
- [x] 1.1 Define explicit CRS estimation entry points.
- [x] 1.2 Define candidate ranking workflow.
- [x] 1.3 Define estimator outputs and debug diagnostics.

> m1-t1（Cycle 1 `maplat-v4-crs-libs`）で実装済み。
> - 1.1: public root export `estimateCrs(gcps, candidates, options)`（`src/index.ts` / `src/estimate-crs.ts`）。
>   候補は `CandidateCrs {authority, code, datumFamily?}`、変換は `CandidateTransformer` 経由。
> - 1.2: shear 前 basic RMS による score（`score = basicRmsMeters / L_geo`）を正本とし、
>   strict 全順序 -> 隣接 epsilon group -> group 内 `datumFamilyPrior` / identity の 3 段で順位を作る。
>   `world_file_basic` を順位に使う本 OpenSpec の記述を仮仕様判断として採用した。
> - 1.3: `EstimationResult {status, selected, ranked, warnings, untransformableIds}`。
>   `warnings` は Daedalus の凍結 `FitWarning` のみ、`untransformableIds` は transformer /
>   candidate 入力層の失敗のみを収容する。値の意味と保存境界は `README.md` を参照。
>
> 未対応（Cycle 1 の非目標）: 実 CRS engine の注入、browser runtime、foot / native unit 出力、
> inverse geodesic RMS、robust / weight / LOO / bootstrap、進捗 callback、並列化、キャンセル。
