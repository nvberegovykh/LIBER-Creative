# REVEX Companion recovery — September 27, 2026

The September 16 Hosting release `06703618b79ceb65` replaced the September 14 repaired site (`5046e39d2826abdf`) with a 344-file snapshot. Subsequent Observer-only releases retained that snapshot. Before recovery, `fc56a83772d38ae0` contained 364 files: 228 September 14 assets were missing, and 46 app paths exactly matched their September 7 Hosting hashes.

The recovery candidate `15fe2d9498594569` contains 592 paths. It restores the 228 missing files and 48 app assets, including six previously tested but unreleased render/family-handoff files. All 364 current paths remain; the 316 untouched paths retain their hashes, including the later public AI and Observer work. Hosting configuration retains the current rewrite and restores JavaScript module MIME and app cache headers. No production project records or backend services are changed by the release.

Recovered behavior includes organized Design Book divisions, separate source records, draft and publication ownership, stale-editor conflict recovery, source-preserving Spec Book refresh, responsive source controls, PDF viewing and calibrated measurements, mobile controls, project history and assistant UI. The pending render fix retains same-account authorization and restores the prompt/camera after a redirect. Family downloads wait for explicit placement and failed native placements request a fresh download rather than reusing an expired token.

The supplied designer review also exposed a Walk defect reproduced on the full native building fixture: BASEPLANE and 1ST FLOOR share a raw elevation. Selecting a dropdown value picked BASEPLANE, so world-height resolution placed the camera near the roof. The recovery selects the actual first-floor option, retains a user's chosen level across geometry refresh, and restores a camera's named level without confusing raw elevation with world-space height. A six-scenario source regression covers duplicate elevations, Level 1 versus Level 10, retained selection and camera restoration.

Source recovery includes already-live shared app dependencies that were absent or stale in Git. JavaScript and HTML use the repository's existing LF normalization; archived Hosting receipts retain their original transport hashes. Vendored PDF.js and streaming-parser licenses are included.

## Release verification

- Every restored/updated asset is checked against its preview response, MIME type and cache headers.
- GCP Chromium exercises actual Firebase login with guarded QA fixtures, Design Book editing/publication/conflicts, native-model book organization, Spec Book recovery, desktop and mobile controls, PDF measurement, history, chat and assistant flows.
- Google consent, image generation and the native Revit family bridge are simulated in the render/import checks. These tests do not prove real Google consent, paid generation, or physical Revit placement.
- Source tests cover account/project isolation and family download/placement ownership. The existing browser credential boundary verifier is updated for the already-live same-origin configuration endpoint.
- The new recovery workflow passes independently. Repository-wide historical contract checks are not all green: inspected failures include exact obsolete import/version-string assertions (r53, r85 and r114) and an old two-argument `fetchGeometry` signature assertion (r49). These checks are retained; the source PR remains draft rather than claiming all repository CI has passed.

## Deployment preservation

The Observer deploy controller now compares the complete paginated file inventory against the live baseline plus its explicit overlay. It rejects omitted files, unrelated stale replacements, incorrect overlay bytes and unreviewed paths, even when the aggregate file count is unchanged. It also checks the live version immediately before promotion and before an automatic rollback, so a detected concurrent deployment is not silently overwritten.

The retained pre-recovery version is the rollback anchor. Future releases must start from current live inventory and preserve unrelated application paths; deploying an older local whole-site snapshot can still bypass this controller's checks.
