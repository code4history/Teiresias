# Teiresias

[![CI](https://github.com/code4history/Teiresias/actions/workflows/test.yml/badge.svg)](https://github.com/code4history/Teiresias/actions/workflows/test.yml)

`@c4h/teiresias` estimates the best CRS and world-file parameters from GCPs and a supplied candidate CRS set.

- Input: GCPs plus candidate CRSs
- Output: selected CRS plus world-file 6 parameters
- Runtime: Node.js and browser (bundler = verified / real browser = observed once / continuous, automated browser execution is unverified. See "Known limitations" below)
- Scope: orchestration over fitting, not DuckDB catalog lookup

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

The authoritative source of the contract is
[`docs/superpowers/specs/2026-08-28-mock-transformer-contract.md`](../docs/superpowers/specs/2026-08-28-mock-transformer-contract.md)
in the parent repository. Its key points are as follows.

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

In Cycle 1, a successful transformer output is interpreted as projected `[E, N]` **in metres**.
Teiresias always passes `{ kind: 'planar_xy', axisOrder: 'xy', unit: 'm' }` to Daedalus and does not
forward the input-side `geoBasis` as-is. Handling of candidates whose native unit is not the metre does
not exist in the Cycle 1 API.

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
worldFile. An API extension that exposes the final RMS under a different name has not been done in
Cycle 1.

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

- **The three tiers of browser verification** (m3-t1 split the former "node-only" item. **Evidence is not
  carried across the tiers** — not painting the runtime tier with the evidence of the bundler tier is a
  discipline imposed by §11 of the provisional specification):
  - **bundler = verified**: `pnpm run verify:demo-bundle` (`scripts/verify-demo-browser-bundle.mjs`)
    scans the output chunks of the demo build and mechanically verifies that no Node-specific specifier
    remains and that Daedalus-derived code is actually present. It runs continuously from CI
    (`.github/workflows/{test,deploy}.yml`).
  - **browser runtime = observed (not "verified")**: on 2026-08-29, `demo/crs-estimate-ranking.html` was
    opened in a real browser and the initialization of proj-wasm, the candidate ranking, the loss of
    discriminating power caused by flipping the y axis, and the reordering caused by dragging a GCP were
    observed (m3-t1/AC-16). **It is a single observation and not an automated check, so it does not guard
    against regressions.**
  - **Continuous, automated browser execution on CI and automated canvas drag operation = unverified**
    (a known gap of Cycle 1; an automated end-to-end test was handed over to post-cycle).
- **The real-engine E2E is connected**: `tests/estimate-crs.real-engine.e2e.test.ts` holds an E2E that
  injects the real CRS engine (Atlas / proj-wasm) (m2a-t1). The mock E2E (`estimate-crs.e2e.test.ts`)
  coexists with it as a deterministic verification of the contract. The former description
  "**the real engine is not connected**: injecting the real CRS engine is a follow-up task" was a stale
  description left behind after the m2a-t1 merge, and it was corrected in m3-t1.
- **`status: 'ok'` is unreachable from the current public API**: since `EstimateOptions` does not expose
  the `holdout` of Daedalus, a successful fit of the real Daedalus always has at least one warning. The
  branch is kept for `FitStatus` compatibility and for future holdout support, and it is covered by unit
  verification of the internal helper.
- **Units**: the transformer output of a successful candidate is fixed to metres. Handling of feet /
  native units is not supported.
- **Not supported**: geodesic RMS through the inverse transformation, the antimeridian, polar regions,
  epoch / grid provenance, robust / weight / LOO / bootstrap, progress callbacks, parallel candidate
  processing, and cancellation.
- **Distribution**: this package remains `private: true`. The decision **not to publish in Cycle 1** is
  recorded (for the reason and the handover to post-cycle, see the license / publish section of the
  provisional specification). `@c4h/daedalus` is resolved through the local sibling `link:../Daedalus`.
  Whether to switch to a semver dependency at publish time is undecided.

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

### Demo (m3-t1)

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

## Related documents

- [Provisional specification of the CRS estimation libraries](../docs/superpowers/specs/2026-08-27-c1-crs-libs-provisional-spec.md) —
  the observation contract, the ranking, the persistence boundary and the verification scope of this
  package are collected there (it is a **provisional specification**, not a finalized specification
  approved by a human).
- [Mock transformer contract](../docs/superpowers/specs/2026-08-28-mock-transformer-contract.md) —
  the authoritative source of the `CandidateTransformer` contract.

The links above **resolve only when the parent repository (the monorepo) is checked out**.
When this repository is cloned on its own, `../docs/` does not exist.

## License

MIT License. See [LICENSE](./LICENSE).
