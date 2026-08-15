# REVEX r49 COMcheck roof regression gate

Real-project failure reproduced on 2026-08-15 after both EnergyPlus runs and EN-1 succeeded.

Required behavior for the current r49 candidate:

- EN thermal-boundary roof geometry regions such as R1/R2/R3 are geometry fragments, not automatically independent COMcheck constructions.
- When current EN evidence proves one roof thermal signature, COMcheck receives exactly one roof component whose gross area is the sum of all unique roof geometry regions.
- If current evidence proves multiple distinct roof thermal signatures, aggregation is refused rather than averaged or guessed.
- Opaque U-factor-only scan artifacts are not accepted as R-value wall/roof/floor constructions.
- EN-008 building-use semantics must tolerate PDF extraction that drops dash/colon punctuation, preserving the current Multifamily / Residential Floor Area evidence.
- RVX geometry, GeometryCo, Baseline/Proposed OSM generation and both EnergyPlus runs are outside this normalization and must not be changed by it.

Regression coverage lives in `verify_revex_r49_energy.py`, `verify_revex_r49_worker.py`, and `verify-revex-r49-live-comcheck.py`.
