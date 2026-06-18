# crs-estimation Specification

## ADDED Requirements
### Requirement: Teiresias SHALL Estimate CRS From Supplied Candidate Sets
Teiresias SHALL estimate the best CRS from GCPs and a supplied candidate CRS set rather than discovering candidates by itself.

#### Scenario: Candidate set is provided
- **GIVEN** GCPs and a candidate CRS set
- **WHEN** Teiresias runs estimation
- **THEN** it SHALL rank the supplied candidates and SHALL NOT require direct access to the candidate catalog storage layer

### Requirement: Teiresias SHALL Expose An Explicit Estimation Entry Point
Teiresias SHALL expose estimation through an explicit top-level method.

#### Scenario: Full estimator is invoked
- **GIVEN** the caller wants the best CRS and world-file parameters
- **WHEN** the caller invokes the estimator entry point
- **THEN** Teiresias SHALL run the explicit ranking workflow without relying on implicit side effects

### Requirement: Teiresias SHALL Return Selected CRS And Final World-File Parameters
Teiresias SHALL return the chosen CRS together with final world-file parameters suitable for downstream consumers such as MaplatTin and MaplatTransform.

#### Scenario: Estimation completes
- **GIVEN** the candidate ranking and fitting workflow has completed
- **WHEN** Teiresias returns the result
- **THEN** the result SHALL include the selected CRS and the final six world-file parameters
