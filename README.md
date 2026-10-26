# Teiresias

[![CI](https://github.com/code4history/Teiresias/actions/workflows/test.yml/badge.svg)](https://github.com/code4history/Teiresias/actions/workflows/test.yml)

`@c4h/teiresias` estimates the best CRS and world-file parameters from GCPs and a supplied candidate CRS set.

- Input: GCPs plus candidate CRSs
- Output: selected CRS plus world-file 6 parameters
- Runtime: Node.js and browser (bundler = verified / real browser = observed once / continuous, automated browser execution is unverified. See "Known limitations" below)
- Scope: orchestration over fitting; it does not perform catalog lookup (the caller supplies the candidates)

日本語のREADMEは[こちら](./README.ja.md)。

## Public API

The `exports` of `package.json` only exposes the public root `"."`. Only `estimateCrs` and the public
types are exposed; the internal helpers (ranking / status derivation) are not.

```ts
import { estimateCrs } from '@c4h/teiresias';
import type { CandidateCrs, EstimateOptions, EstimationResult } from '@c4h/teiresias';

const result: EstimationResult = await estimateCrs(gcps, candidates, {
  transformer,                 // required. The adapter that transforms into a candidate CRS
  geoBasis,                    // defaults to { kind: 'lonlat_deg', axisOrder: 'lon-lat' }
  minCandidates,               // defaults to 1
  topK,                        // defaults to all usable candidates
  normalizeEpsilonMeters,      // defaults to 100 (m)
  datumFamilyPrior,            // defaults to neutral (no prior)
});
```

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
| (3) | the output is a sequence of projected `[easting, northing]` points of the same order and the same length |
| (4) | an empty input gives `null` (it does not return `[]`) |
| (5) | if even one point is non-finite / untransformable, the whole result is `null` (no partial success is returned) |
| (6) | a length mismatch between input and output is an adapter contract failure |
| (7) | an event that is untransformable in the domain sense gives `null`; a throw only happens for an adapter bug |
| (8) | it is deterministic for the same id, point sequence and basis |

Both synchronous returns and `Promise` returns conform. Teiresias processes the candidates
**sequentially in input order** and normalizes the returns with `await` (so that the order of
failures / warnings and the order of adapter calls are deterministic).

A successful transformer output is interpreted as projected `[E, N]` **in metres**.
Teiresias always passes `{ kind: 'planar_xy', axisOrder: 'xy', unit: 'm' }` to Daedalus and does not
forward the input-side `geoBasis` as-is. Handling of candidates whose native unit is not the metre does
not exist in the current API.

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

### The difference in the meaning of `rmsMeters` (important)

| value | meaning |
|---|---|
| `ranked[].rmsMeters` / `selected.rmsMeters` | **the pre-shear basic RMS used for the ranking** |
| `selected.worldFile` / `selected.qualityGate` | **the final return of Daedalus for the same candidate** (which may include an adopted affine) |

Therefore, when `selected.worldFile` is affine, `selected.rmsMeters` is not the residual of that
worldFile. There is no API that exposes the final RMS under a different name.

## Status and diagnostics

| condition | `status` | `selected` |
|---|---|---|
| usable count >= `minCandidates`, and the selected candidate has 0 warnings | `ok` | the leading candidate |
| usable count >= `minCandidates`, and the selected candidate has 1 or more warnings | `ok_with_warnings` | the leading candidate |
| usable count < `minCandidates` | `insufficient` | `null` |
| 0 usable candidates and 1 or more adapter contract failures / adapter bugs / dependency contract failures | `failed` | `null` |

When the last two conditions overlap, `failed` takes precedence so that an implementation failure is not
buried under a shortage of candidates.

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

`ranked` / `score` / the basic RMS / `qualityGate` / `warnings` / `untransformableIds` and the whole
`selected` object are not persisted. The same applies to a return with `qualityGate: 'preview'`: the
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
    observed. **It is a single manual check and not an automated test, so it does not guard against
    regressions.**
  - **Continuous, automated browser execution on CI and automated canvas drag operation = not available yet.**
- **The real-engine E2E is connected**: `tests/estimate-crs.real-engine.e2e.test.ts` injects the real CRS
  engine (Atlas / proj-wasm). The mock E2E (`estimate-crs.e2e.test.ts`) coexists with it as a
  deterministic verification of the contract.
- **`status: 'ok'` is unreachable from the current public API**: since `EstimateOptions` does not expose
  the `holdout` of Daedalus, a successful fit of the real Daedalus always has at least one warning. The
  branch is kept for `FitStatus` compatibility and for future holdout support, and it is covered by unit
  verification of the internal helper.
- **Units**: the transformer output of a successful candidate is fixed to metres. Handling of feet /
  native units is not supported.
- **Equivalent candidates**: a catalog can contain CRSs whose identifiers differ but whose projection
  definition (PROJ string) is the same (for example `EPSG:2448`, `EPSG:6674` and `ESRI:112206`). They give
  exactly the same estimate, so their order in `ranked` is decided by the identity order. There is no API
  that returns such groups of equivalent candidates; compare the candidates' `proj4` to recognize them
  (tracked in the [issue tracker](https://github.com/code4history/Teiresias/issues)).
- **Not supported**: geodesic RMS through the inverse transformation, the antimeridian, polar regions,
  epoch / grid provenance, robust / weight / LOO / bootstrap, progress callbacks, parallel candidate
  processing, and cancellation. Cancellation is planned for the first npm release; the others are
  tracked in the [issue tracker](https://github.com/code4history/Teiresias/issues).
- **No CLI**: Teiresias is a library only. There is no command-line interface.
- **Distribution**: this package is not published to npm yet (`private: true`). `@c4h/daedalus` is
  resolved through the local sibling `link:../Daedalus`.

## Development

```bash
pnpm --ignore-workspace install --ignore-scripts
pnpm --ignore-workspace run typecheck
pnpm --ignore-workspace run test:types
pnpm --ignore-workspace run test
pnpm --ignore-workspace run build
pnpm --ignore-workspace run coverage
```

Because `@c4h/daedalus` resolves `dist` through its exports, build Daedalus first. In a worktree of the
parent repository, a bare `pnpm run <script>` regenerates the parent `pnpm-lock.yaml` in a degenerate
form, so **always add `--ignore-workspace`**.

### Demo

`demo/crs-estimate-ranking.html` is a demo that lets you touch the estimation pipeline
`Atlas` (projection) → `Daedalus` (fitting) → `Teiresias` (ranking) in a browser. Because it resolves
the `dist` of `@c4h/atlas`, **build Atlas first as well**.

```bash
# development server
pnpm --ignore-workspace run dev

# build and verify the Pages artifact (GITHUB_PAGES=true makes the base /Teiresias/)
pnpm --ignore-workspace run verify:demo
pnpm --ignore-workspace run verify:demo-bundle

# check it in a local browser (use it together with a build whose base is "/")
pnpm --ignore-workspace run build:demo
pnpm --ignore-workspace run preview
```

Because proj-wasm loads a Worker and a WASM binary, **it does not work over `file://`** (serve it over HTTP).

## License

MIT License. See [LICENSE](./LICENSE).
