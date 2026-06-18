## Context
Teiresias is the orchestration layer for Maplat V3.1 CRS estimation. It assumes candidate CRS records are already available and coordinates fitting and ranking to select the best CRS and final world-file parameters.

## Decisions
- Node/browser compatible.
- No DuckDB dependency in the runtime package itself.
- Candidate ranking uses `world_file_basic` scores before shear.
- Final selected CRS may then receive post-selection shear refinement.
