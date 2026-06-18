# Change: Bootstrap Teiresias CRS Estimation

## Why
CRS estimation orchestration is being separated from `MaplatTin` so ranking and selection logic can evolve independently of TIN handling and candidate lookup storage.

## What Changes
- Define explicit estimator entry points.
- Define ranking over supplied candidate CRS sets.
- Define outputs for selected CRS and final world-file parameters.

## Impact
- Affected specs: `crs-estimation`
- Affected code: future estimator orchestration and browser/node packaging
