# Teiresias

[![CI](https://github.com/code4history/Teiresias/actions/workflows/test.yml/badge.svg)](https://github.com/code4history/Teiresias/actions/workflows/test.yml)

`@c4h/teiresias` estimates the best CRS and world-file parameters from GCPs and a supplied candidate CRS set.

- Input: GCPs plus candidate CRSs
- Output: selected CRS plus world-file 6 parameters
- Runtime: Node.js and browser (bundler = verified / real browser = observed once / continuous, automated browser execution is unverified. See "Known limitations" below)
- Scope: orchestration over fitting; it does not perform catalog lookup (the caller supplies the candidates)

日本語のREADMEは[こちら](./README.ja.md)。

## Installation

Requires Node.js >= 22 (or a browser through a bundler). The candidates usually come from
[`@c4h/atlas`](https://github.com/code4history/Atlas) (see "Using with Atlas" below).

<!-- release-pinned:start -->
```sh
pnpm add @c4h/teiresias @c4h/atlas
```
<!-- release-pinned:end -->

## Public API

The `exports` of `package.json` only exposes the public root `"."`. Only `estimateCrs` and the public
types are exposed; the internal helpers (ranking / status derivation) are not.

```ts
import { estimateCrs } from '@c4h/teiresias';
import type {
  CandidateCrs,
  CandidateFailure,
  CandidateFailureKind,
  CandidatePoints,
  EstimateOptions,
  EstimationFailure,
  EstimationResult,
  LinearUnit,
} from '@c4h/teiresias';

const result: EstimationResult = await estimateCrs(gcps, candidates, {
  transformer,                 // required. The adapter that transforms into a candidate CRS
  geoBasis,                    // defaults to { kind: 'lonlat_deg', axisOrder: 'lon-lat' }
  minCandidates,               // defaults to 1
  topK,                        // defaults to all usable candidates
  normalizeEpsilonMeters,      // defaults to 100 (m)
  datumFamilyPrior,            // defaults to neutral (no prior)
  chirality,                   // defaults to 'normalize'. 'direct-only' does not absorb a reflection
  holdout,                     // defaults to none. GCPs used only to validate the affine adoption
  timeoutMs,                   // defaults to 120000 (ms) per transformer call. Infinity disables it
  signal,                      // defaults to none. An AbortSignal that cancels the whole estimate
});
```

- `holdout` (`readonly GcpPair[]`, `geo` in the order of `geoBasis`) is passed to the holdout
  validation of Daedalus. It is not used for fitting. The transformer is still called once per
  candidate: the geo points of the GCPs and of the holdout are transformed together in one call. An
  empty array is the same as leaving it out.
- `timeoutMs` is the upper limit of **one transformer call** for one candidate. When a call does not
  answer within it, the estimate stops there and returns `status: 'failed'` with
  `failure.reason: 'timeout'`; the remaining candidates are not called. A value that is not a positive
  number falls back to the default. A value larger than 2147483647 (the largest delay `setTimeout`
  accepts) is treated as `Infinity`, that is, no limit. It bounds a transformer that returns a Promise
  and keeps it pending; a transformer that blocks the thread synchronously cannot be interrupted.
- `signal`: when it is aborted, `estimateCrs` rejects with `signal.reason` (or an `AbortError`
  `DOMException` when there is no reason), following the convention of Web APIs that take an
  `AbortSignal`. No further candidate is called. Cancellation is the only case in which
  `estimateCrs` rejects.
- `failure` (`EstimationFailure | null`) on the result tells why the status is `failed`:
  `reason` is `'implementation-failure'` or `'timeout'`, and `candidates` lists each failed candidate
  (`CandidateFailure`: `id`, `kind`, `message`) in candidate input order. `CandidateFailureKind` is
  `'adapter-bug'` (the transformer threw or rejected), `'adapter-contract-failure'` (the output breaks
  the contract: a wrong length, a non-finite point, an array for empty input, and so on),
  `'dependency-contract-failure'` (the Daedalus result breaks its public contract) or
  `'adapter-timeout'`. `message` is cut at 500 characters. `failure` is `null` for any other status.

`WorldFile` / `GcpPair` / `GeoBasis` / `FitStatus` / `QualityGate` / `FitWarning` / `MaybePromise`
are re-exports of the public types of `@c4h/daedalus`; Teiresias does not redefine them.

### `CandidateCrs` and identity

Candidates are passed as the minimal structural type `{ authority, code, datumFamily? }`. The candidate
id is assembled by Teiresias in a single place as `` `${authority}:${code}` ``, so the caller never
passes an independent id. An empty `authority` / `code` makes the candidate fail, and when identities
are duplicated only the first occurrence is evaluated.

### The contract of `CandidateTransformer`

The transformer injected by the caller must satisfy the following contract.

| # | contract |
|---|---|
| (1) | the id is `` `${authority}:${code}` `` |
| (2) | the input is a sequence of geo points in the order indicated by `geoBasis` (same order) |
| (3) | the output is a sequence of projected `[easting, northing]` points of the same order and the same length, or `{ points, unit }` (see "Units") |
| (4) | an empty input gives `null` (it does not return `[]`) |
| (5) | if even one point is non-finite / untransformable, the whole result is `null` (no partial success is returned) |
| (6) | a length mismatch between input and output is an adapter contract failure |
| (7) | an event that is untransformable in the domain sense gives `null`; a throw only happens for an adapter bug |
| (8) | it is deterministic for the same id, point sequence and basis |

Both synchronous returns and `Promise` returns conform. Teiresias processes the candidates
**sequentially in input order** and normalizes the returns with `await` (so that the order of
failures / warnings and the order of adapter calls are deterministic).

### Units

A candidate CRS may count its coordinates in something other than the metre (the yard of a historical
grid, the US survey foot, and so on). A transformer can return such a candidate in two shapes:

| shape | meaning |
|---|---|
| `Array<[number, number]>` | projected `[E, N]` **in metres** (the plain shape) |
| `CandidatePoints` = `{ points, unit }` | projected `[E, N]` **in `unit`** (`points` in the same order and the same length) |

`LinearUnit` is `{ name, metresPerUnit }`: the name of the unit and how many metres one unit is
(`metresPerUnit` must be a positive finite number, `name` a non-empty string). The metre is
`{ name: 'metre', metresPerUnit: 1 }`, so a plain point list is the same as a `CandidatePoints` with
that unit.

Teiresias multiplies the returned points by `metresPerUnit` and fits in metres: the holdout points are
converted with the same factor, and the `[E, N]` handed to Daedalus is always metric. Therefore:

- `rmsMeters` (on `ranked` and on `selected`) stays in metres, so every candidate of one call is
  comparable on the same scale.
- `selected.unit` and `ranked[].unit` carry the unit of that candidate's coordinates. They are
  `{ name: 'metre', metresPerUnit: 1 }` for a transformer that returns a plain point list.
- `selected.worldFile` is the pixel → **that unit** mapping: all six values are divided by
  `metresPerUnit` (the mapping is linear, so the six values share one factor). For a metre candidate
  the values are the same as before.

An invalid unit (an empty `name`, or a `metresPerUnit` that is not a positive finite number) is an
adapter contract failure: the candidate is recorded like any other contract violation and the estimate
turns `failed` (see "Status and diagnostics").

### Using with Atlas

[`@c4h/atlas`](https://github.com/code4history/Atlas) finds the candidates and builds the transformer
with three functions. Teiresias itself does not depend on Atlas (the engine is injected by the
caller); `createCandidateTransformer` returns a function of the same shape as `CandidateTransformer`,
and the rows of `listProjectedCrsFromProjWasm` already carry `authority` / `code`, so they can be
passed as the candidates as they are.

```ts
import {
  createCandidateTransformer,
  initializeProjWasmRuntime,
  listProjectedCrsFromProjWasm,
} from '@c4h/atlas';
import { estimateCrs } from '@c4h/teiresias';

await initializeProjWasmRuntime(); // in a browser, pass { projWasmAssetBaseUrl } as well

const rows = await listProjectedCrsFromProjWasm({
  extent: { west: 135.6, south: 34.9, east: 135.9, north: 35.1 },
  area: 'Japan',
  onshoreOnly: true,
});

const result = await estimateCrs(gcps, rows, {
  transformer: createCandidateTransformer(rows),
});
```

A row whose coordinates are not in metres (for example the yard of a historical grid) makes
`createCandidateTransformer` return `{ points, unit }` instead of a plain point list; Teiresias converts
it as described in "Units". To convert a single row yourself, `transformLonLatToCandidate` returns the
points together with the unit of that row, while `transformLonLatArrayToProjected` keeps the plain shape
and gives `null` for a row whose unit is not the metre.

The transformer gives `null` for a `geoBasis` other than `{ kind: 'lonlat_deg', axisOrder: 'lon-lat' }`
and for an id that is not among the rows, which is contract (7) "untransformable in the domain sense".
A failure on the Atlas side is thrown, not turned into `null`. Teiresias catches a throw or a reject
per candidate: it records that candidate as an adapter bug, puts its id in `untransformableIds` and
goes on with the remaining candidates, so `estimateCrs` itself does not reject. If even one candidate
failed this way, the status is `failed` and `selected` is `null`, even when other candidates are usable,
and `failure` names the failed candidates (see "Status and diagnostics" below). The real-engine E2E (`tests/estimate-crs.real-engine.e2e.test.ts`)
and the demo (`demo/atlas-engine.js`) are wired this way.

## Ranking and score

- The order is decided by the **basic (similarity) RMS before shear**. Since Daedalus may finally adopt
  affine, using the final RMS for the order would make "affine rescues a wrong candidate and inverts the
  order" happen.
- `score = basicRmsMeters / L_geo`. `L_geo` is the observation-area scale (m) common to all the input
  GCPs, so within the same estimation call the score is equivalent to ascending basic RMS. The score is
  a relative error with respect to the observation area; it is not a probability or a confidence.
- The order given in `datumFamilyPrior` only takes effect on ties (within machine precision). The prior
  never inverts a clear difference in fit. Finally the ordering closes deterministically by the code-unit
  order of the identity.

### Reflection of the pixel y axis (`chirality`)

Scanned images usually have their pixel y axis pointing down while the projected northing points up, so
the pixel-to-ground mapping contains a reflection. A similarity transform (rotation, isotropic scale and
translation) cannot represent a reflection, so without any countermeasure every candidate fits equally
badly and the ranking loses its power to tell the candidates apart.

With `chirality: 'normalize'` (the default), Teiresias keeps the similarity model unchanged and, for each
candidate, also fits the same points with the pixel v coordinate negated, then keeps the side with the
smaller basic sum of squared residuals (the non-flipped side wins a tie within machine precision). When
the flipped side is kept, the signs of `xSkew` and `yScale` of the returned `worldFile` are inverted so
that it maps the original pixel coordinates; `rmsMeters`, `qualityGate`, `warnings` and `status` are
those of the kept side, and warnings of the other side are not reported. The transformer is called once
per candidate either way. Whether a reflection was absorbed can be read from the sign of the determinant
of `selected.worldFile` (`xScale * yScale - xSkew * ySkew < 0`).

`chirality: 'direct-only'` skips the flipped fit and gives the behaviour without normalization.

### The difference in the meaning of `rmsMeters` (important)

| value | meaning |
|---|---|
| `ranked[].rmsMeters` / `selected.rmsMeters` | **the pre-shear basic RMS used for the ranking**, in metres |
| `selected.worldFile` / `selected.qualityGate` | **the final return of Daedalus for the same candidate** (which may include an adopted affine) |
| `selected.unit` / `ranked[].unit` | **the linear unit of that candidate's coordinates**; `selected.worldFile` is in it, `rmsMeters` is not |

Therefore, when `selected.worldFile` is affine, `selected.rmsMeters` is not the residual of that
worldFile. There is no API that exposes the final RMS under a different name.

## Status and diagnostics

The conditions are evaluated from the top, and the first matching row decides the result.

| condition | `status` | `selected` | `failure` |
|---|---|---|---|
| a transformer call timed out (`adapter-timeout`) | `failed` | `null` | `{ reason: 'timeout', candidates }` (the timed-out candidate comes last) |
| 1 or more adapter bugs / adapter contract failures / dependency contract failures | `failed` | `null` | `{ reason: 'implementation-failure', candidates }` (all of them) |
| usable count >= `minCandidates`, and the selected candidate has 0 warnings | `ok` | the leading candidate | `null` |
| usable count >= `minCandidates`, and the selected candidate has 1 or more warnings | `ok_with_warnings` | the leading candidate | `null` |
| otherwise (usable count < `minCandidates`) | `insufficient` | `null` | `null` |

An implementation-side failure makes the estimate `failed` even when other candidates are usable:
Teiresias cannot tell whether the failed candidate was the true CRS, so selecting among the rest could
silently pick a wrong one. The evaluation still goes on to the last candidate (except after a timeout),
so `failure.candidates` lists every candidate to fix at once.

- With `status: 'failed'`, `ranked` holds only the candidates that could be evaluated. It is an
  incomplete ranking for diagnosis and must not be used to select a candidate.
- `status: 'ok'` happens only when `holdout` is given and Daedalus adopts the affine model; any other
  successful fit carries at least one warning (for example `validationSkipped`), so it is
  `ok_with_warnings`.

- On success, `warnings` returns **only the Daedalus `FitWarning`s of the selected candidate**, in the
  same order and the same shape. The warnings of losing candidates are not mixed in without an identity.
  `WarningCode` stays at the 7 frozen values of Daedalus, and transformer failures are not diverted into
  the existing codes.
- `untransformableIds` collects **only the failures of the transformer / candidate input layer**, in
  candidate input order and without duplicates. It is not mixed with the shortages of the Daedalus
  fitting layer (`insufficient` / `unusable`). It does not intersect with the identities of `ranked` /
  `selected`.

## The persistence boundary

`EstimationResult` is a **diagnostic return**. What may be persisted after the Editor has explicitly
adopted it is **only the selected identity and the adopted worldFile**.

`ranked` / `score` / the basic RMS / `qualityGate` / `warnings` / `untransformableIds` / `failure` and
the whole `selected` object are not persisted. The same applies to a return with `qualityGate: 'preview'`: the
decision to persist or adopt is the responsibility of the Editor, not of the library.

## Known limitations

- **Browser support, in three levels** (evidence for one level is not reused for another):
  - **bundler = verified**: `pnpm run verify:demo-bundle` (`scripts/verify-demo-browser-bundle.mjs`)
    scans the output chunks of the demo build and mechanically verifies that no Node-specific specifier
    remains and that Daedalus-derived code is actually present. It runs continuously from CI
    (`.github/workflows/{test,deploy}.yml`).
  - **browser runtime = checked manually once**: on 2026-08-29, `demo/crs-estimate-ranking.html` was
    opened in a real browser and the initialization of proj-wasm, the candidate ranking, the loss of
    discriminating power caused by flipping the y axis, and the reordering caused by dragging a GCP were
    observed. That check predates the reflection handling (`chirality`); with the current default the
    y-axis flip no longer collapses the ranking unless normalization is switched off in the demo. **It is a single manual check and not an automated test, so it does not guard against
    regressions.**
  - **Continuous, automated browser execution on CI and automated canvas drag operation = not available yet.**
- **The real-engine E2E is connected**: `tests/estimate-crs.real-engine.e2e.test.ts` injects the real CRS
  engine (Atlas / proj-wasm). The mock E2E (`estimate-crs.e2e.test.ts`) coexists with it as a
  deterministic verification of the contract.
- **`timeoutMs` only bounds asynchronous waiting**: a transformer that blocks the JavaScript thread
  synchronously cannot be interrupted, because the timer cannot fire. The transformer of Atlas
  (`createCandidateTransformer`) returns a Promise, so the limit applies to its asynchronous waits (such
  as the initialization of the engine), but not to the synchronous transformation work inside it.
- **Equivalent candidates**: a catalog can contain CRSs whose identifiers differ but whose projection
  definition (PROJ string) is the same (for example `EPSG:2448`, `EPSG:6674` and `ESRI:112206`). They give
  exactly the same estimate, so their order in `ranked` is decided by the identity order. There is no API
  that returns such groups of equivalent candidates; compare the candidates' `proj4` to recognize them
  (tracked in [#4](https://github.com/code4history/Teiresias/issues/4)).
- **Not supported**: geodesic RMS through the inverse transformation, the antimeridian, polar regions,
  epoch / grid provenance, robust / weight / LOO / bootstrap, progress callbacks, and parallel candidate
  processing. They are tracked in [#5](https://github.com/code4history/Teiresias/issues/5).
- **CRSs that differ only in their linear unit cannot be told apart by GCP fitting**: when two
  CRSs share the same projection and differ only in unit (metre and US survey foot, for example), the
  scale of the similarity transform absorbs the unit difference. Whichever one is selected, only the
  numbers in the world file change. The difference between a historical grid and a nearby modern CRS
  is a few centimetres even with exact GCPs (on a real map the GCP error is larger).
- **No CLI**: Teiresias is a library only. There is no command-line interface.
- **Distribution**: this package is not published to npm yet (`private: true`). `@c4h/daedalus` is
  resolved through the local sibling `link:../Daedalus`.

## Development

Check out [Atlas](https://github.com/code4history/Atlas) and
[Daedalus](https://github.com/code4history/Daedalus) next to this repository (`../Atlas`, `../Daedalus`).
Until they are on npm, `ci/pnpm-workspace.ci.yaml` resolves `@c4h/atlas` and `@c4h/daedalus` to those
checkouts. Copy it before installing, in this repository and in each sibling (do not commit the copies):

```bash
(cd ../Daedalus && cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile && pnpm run build)
(cd ../Atlas && cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile && pnpm run build)
cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:types
pnpm run test
pnpm run build
pnpm run smoke:consumer
pnpm run coverage
```

Because `@c4h/daedalus` resolves `dist` through its exports, build Daedalus first.
`pnpm run smoke:consumer` packs the three packages, installs the tarballs into an empty directory and
runs the estimate through the public imports only.

`pnpm publish` is guarded by `prepublishOnly` (test, typecheck, test:types, test:types:atlas, build,
verify:demo and verify:demo-bundle). Releases are published from GitHub Actions
(`.github/workflows/publish.yml`). Changes are listed in [CHANGELOG.md](./CHANGELOG.md).

### Demo

`demo/crs-estimate-ranking.html` is a demo that lets you touch the estimation pipeline
`Atlas` (projection) → `Daedalus` (fitting) → `Teiresias` (ranking) in a browser. Because it resolves
the `dist` of `@c4h/atlas`, **build Atlas first as well**.

```bash
# development server
pnpm run dev

# build and verify the Pages artifact (GITHUB_PAGES=true makes the base /Teiresias/)
pnpm run verify:demo
pnpm run verify:demo-bundle

# check it in a local browser (use it together with a build whose base is "/")
pnpm run build:demo
pnpm run preview
```

The page has a **row of preset buttons** at the top — one pair per contrast. Pressing one fills in the
whole input (place, how candidates are collected, y direction, normalization) and runs the estimate
once. The pressed button stays highlighted and the line underneath it says what the output should look
like. Touching a control or dragging a GCP by hand clears the highlight and the line (the presets are an
entry point; they do not lock the controls). The labels on screen are shown in Japanese.

| preset | A | B |
|---|---|---|
| `place` | 京都の GCP | 東京の GCP |
| `y-direction` | y 上向き | y 下向き（走査した地図） |
| `normalization` | 正規化あり | 正規化なし |
| `historical-grid` | 現代の地図（VI 系で描いた） | 戦前の市街図（歴史グリッド B 帯で描いた） |

The two `historical-grid` buttons collect candidates with `catalog-custom`: the whole default catalog
with the onshore-only filter removed, so it also includes modern CRSs that cover the sea (such as
UTM), plus the historical grids. That is why the ranking table shows more than just historical grids.

Above the ranking the page shows a one-line flow (`Atlas` → `Daedalus` → `Teiresias` with the live
counts and the winning CRS), the discrimination badge next to the candidate it was compared with, and
the selected world file with the sign of `yScale` spelled out as y up / y down. The ranking table has
a column for the unit of each candidate, and the selected world file names its unit next to the six
values (a historical grid draws them in yards). The first-place `rmsMeters` and the `rmsMeters` of
the candidate it was compared with for discrimination (the first candidate with a different
definition from the first place) are shown side by side. The world-file panel itself lives in the
Daedalus demo, so the selection links to it.

Because proj-wasm loads a Worker and a WASM binary, **it does not work over `file://`** (serve it over HTTP).

## License

MIT License. See [LICENSE](./LICENSE).
