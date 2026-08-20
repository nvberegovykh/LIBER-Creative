# REVEX r49 Release Coordination Contract

This file is release authority for future REVEX debugging and publication work. Read it before changing code, publisher logic, branches, archives, or cloud deployment.

## 1. Authority and preservation rule

- Product: REVEX 0.8.19 r49 + REVEX Companion.
- Runtime authority is the exact immutable local candidate archive named by `PUBLISH_REVEX_R49.ps1`, not an arbitrary GitHub branch and not the newest log.
- `PUBLISH_REVEX_R49.cmd` is only the stable launcher for `PUBLISH_REVEX_R49.ps1`; its timestamp is not release-state evidence.
- `PUBLISH_REVEX_R49.latest.log` is only the most recent execution log; never treat it as source authority.
- NEVER replace a last-known-working upstream chain to repair a downstream failure. Patch the failed stage and only its direct dependencies, then rerun the full acceptance gate.
- Before every fix, identify: authoritative candidate, last completed stage, first failed stage, changed files, and invariants that must remain byte-for-byte unchanged.

## 2. Last-known-working Energy boundary before the clean COMcheck fix

The 2026-08-14 real 79 Winthrop acceptance reached the COMcheck Backstop after successfully producing current Revit evidence, gbXML/OSM geometry, GeometryCo compiled models, two EnergyPlus simulations, current T/Z/EN facts, and the current-project COMcheck CXL. The first failing boundary was the live Legacy COMcheck DWR session/upload transport. Therefore GeometryCo, model mapping, EnergyPlus, PRM comparison, T/Z/EN extraction, and project identity are preservation scope and must not be rewritten to fix COMcheck.

## 3. COMcheck production intent

- Required compliance path: official PNNL/DOE COMcheck, `2020 NYCECC Appendix CA Modeling Envelope Backstop`.
- Current Revit T/Z/EN evidence remains authoritative for identity and envelope values.
- Production must NOT depend on the broken undocumented Legacy `ProjectService.uploadProject` file-upload transport.
- Production creates a fresh official COMcheck browser project, translates current generated CheckXML facts into COMcheck's current browser model, exports a clean CheckXML once, calculates compliance, and downloads the official PDF.
- The direct DWR upload client remains only for isolated deterministic local mock/contract tests.
- The clean project must preserve wall/window/door/roof/floor counts and current-project evidence tokens before the official result is accepted.

## 4. Energy-chain invariants

Preserve end-to-end:

`active Revit document -> immutable Engineering revision -> T/Z identity + EN facts -> gbXML -> GeometryCo -> approved Baseline + Proposed templates -> two EnergyPlus runs -> official COMcheck Backstop -> EN-1 -> 7 files + 1 Packager archive`

Do not weaken these invariants:

- source RVT remains unchanged during QA;
- active-document/project/revision identity stays exact and cross-project results are rejected;
- approved Baseline/Proposed schedules, loads, HVAC/system templates and energy intent remain preserved while geometry/spaces are updated;
- both EnergyPlus runs must complete;
- prior-project identity remains masked from user-visible Energy artifacts;
- only a `reviewEligible=true` Energy iteration is user-visible; matching cohorts require `PASSED` + `BEST_WORKING_ITERATION`, while a legitimately different cohort may be `NOT_APPLICABLE_DIFFERENT_COHORT` + `UNBENCHMARKED_DIFFERENT_COHORT` after all independent completion gates pass;
- COMcheck consent stays exact-revision scoped;
- EN-1 and review package come from the same immutable Engineering revision;
- no Revit/Companion interaction is required after publisher launch to extract QA evidence.

## 5. Publication structure

The Drive release folder contains:

- `PUBLISH_REVEX_R49.cmd` — stable launcher; normally unchanged.
- `PUBLISH_REVEX_R49.ps1` — actual release orchestration and hash locks.
- `REVEX_R49_SOURCE_<candidate>.zip` — immutable full source candidate used for build/QA/publication.
- `REVEX-R49-PREFLIGHT.latest.json` — latest structured release gate state.
- `PUBLISH_REVEX_R49.latest.log` — latest run log only.

Every candidate change must keep the `.ps1`, source ZIP candidate id/hash/size, `$Expected` file hashes, and this coordination contract synchronized.

## 6. Required release order

1. Close Revit only for the atomic staged/installed add-in swap.
2. Verify immutable source ZIP hash and all locked source hashes.
3. Run static source/dependency closure and recorded-Revit Companion/access tests.
4. Run local Energy/worker contract tests.
5. Run a fast synthetic live official COMcheck clean-project test BEFORE the expensive real 79 acceptance.
6. Reuse prior real-Revit evidence only when RVT hash, weather hash, producer bundle hash, artifact sizes and artifact hashes all match.
7. Run real 79 T/Z/EN -> GeometryCo -> two EnergyPlus -> official clean-project COMcheck -> EN-1 -> eight-item package.
8. Only after the real local gate passes: stage the exact candidate to GitHub, wait for the named final gate, merge, deploy private worker/broker/Companion, verify live access, then atomically install the add-in.
9. On any failure, preserve diagnostics and stop without partial production installation.

## 7. Debugging rule for future chats/agents

Start from this file and the newest preflight/log, not from chat recollection alone. Do not restart exploration of already-passed stages unless evidence shows they regressed. Record any new release boundary or architecture decision here before handing off or changing another subsystem.

## 8. 2026-08-14 clean-COMcheck acceptance boundary

The `36fb4e...` real 79 run proved the preserved chain through both EnergyPlus runs, Review Packager, EN-1 preparation, and official clean-project COMcheck. COMcheck returned an official five-page report and the pipeline completed. The next failure was only the release wrapper interpreting `NOT_APPLICABLE_DIFFERENT_COHORT` as a regression.

Approved-run comparison semantics are therefore fixed as follows:

- matching cohort + `PASSED` + `BEST_WORKING_ITERATION` + `reviewEligible=true` -> accepted benchmarked candidate;
- different cohort + `NOT_APPLICABLE_DIFFERENT_COHORT` + `UNBENCHMARKED_DIFFERENT_COHORT` + `reviewEligible=true` -> accepted unbenchmarked candidate;
- matching-cohort `REGRESSION` / `WITHHELD_REFERENCE_REGRESSION` or any `reviewEligible=false` -> blocked;
- never label a different cohort `BEST_WORKING_ITERATION`; absence of a comparable approved cohort is not evidence of regression.

This distinction is required for REVEX to work on projects whose current Revit geometry legitimately differs from the masked 79 Winthrop approved reference cohort.

## 9. 2026-08-14 GitHub security-gate boundary

The `edb52b3...` local release gate and real 79 acceptance passed before GitHub mutation, including the full Energy chain and official clean-project COMcheck. PR #30 then passed the named `REVEX r49 final gate` but GitHub CodeQL rejected three high-severity inefficient-regular-expression alerts, all in `comcheck_backstop.py` DWR diagnostic/callback parsing.

The security fix is intentionally limited to those parsers:

- replace ambiguous quoted-string regexes with bounded linear-time JavaScript quoted-string scanning;
- preserve DWR error extraction, escaped-string decoding, callback token selection, and official COMcheck behavior;
- do not change Revit evidence, GeometryCo, Baseline/Proposed templates, EnergyPlus, EN-1, COMcheck project translation, or acceptance semantics.

A CodeQL failure after the full local release gate is a downstream publication/security-gate failure, not evidence that the passed Energy chain should be rewritten.

## 10. 2026-08-14 Cloud worker Python/ONNX Runtime boundary

The `43370d3c...` candidate passed the full local real-project gate, CodeQL, and the named GitHub final gate, then merged. The first downstream deployment failure was Cloud Build image dependency resolution: Ubuntu 22.04 provides system Python 3.10, while `onnxruntime==1.24.4` has no compatible Linux CPython 3.10 distribution in the worker's package index. The cloud image therefore failed before worker QA or deployment.

The fix is dependency-marker-only and must not alter Energy behavior:

- Windows keeps `onnxruntime-directml==1.24.4`;
- non-Windows Python 3.11+ keeps `onnxruntime==1.24.4`;
- non-Windows Python <3.11 uses `onnxruntime==1.23.2`, which has a CPython 3.10 manylinux x86-64 wheel compatible with Ubuntu 22.04;
- GeometryCo model files, inference flow, thresholds, templates, Revit evidence, OSM compilation, EnergyPlus, COMcheck, EN-1, and acceptance semantics remain unchanged.

Future publisher preflight must verify this split before expensive real-project acceptance so a workstation-only dependency pin cannot again reach Cloud Build.

## 11. 2026-08-14 Cloud worker image runtime-closure boundary

The `63f6e47c...` candidate passed the dependency-resolution boundary and Cloud Build installed the Python 3.10-compatible ONNX Runtime. The next build-stage failure occurred only when the image executed `verify_revex_r49_worker.py`: that verifier intentionally imports `run_revex_r49_release_acceptance.py`, but the Dockerfile had copied only `app.py`, `verify_revex_r49_worker.py`, and `requirements-server.txt` into `/opt/revex/server`. The source file existed in the release tree but was absent from the image filesystem.

The fix is image-packaging-only and must not change the accepted Energy chain:

- copy `run_revex_r49_release_acceptance.py` into `/opt/revex/server` beside `app.py` and the worker verifier;
- run an early image-local `py_compile` over all three Python server modules before dependency installation/worker QA;
- publisher static closure must reject any candidate whose Dockerfile omits the acceptance module or the early server-module compile gate;
- keep Revit evidence, GeometryCo logic/model, Baseline/Proposed templates, EnergyPlus, COMcheck, EN-1, approved-run semantics, broker contract, and Companion behavior unchanged.

The Cloud Build Python 3.10 FutureWarning from `google.api_core` is non-fatal and is not the failure boundary. Do not upgrade the worker operating system/Python as part of this packaging fix.

## 12. Cloud Storage access merge readiness

`firebase/revex-secure-chat-storage.rules` is a merge fragment, not a deployable replacement. `.github/scripts/patch-live-storage-rules.js` must merge only the marked REVEX block inside the preserved live `/b/{bucket}/o` match. CI composes that fragment with a representative unrelated namespace and runs both deterministic merge checks and the Firebase Storage emulator access matrix.

`firebase/deploy-current-storage-access.ps1` is the only current Storage rules publisher. It resolves the existing Storage release, downloads its exact active ruleset, applies the idempotent marked-block patch, creates a validated immutable ruleset through the Firebase Rules API, switches only that release, verifies the exact source-candidate marker, and restores the prior ruleset if post-release verification fails. If more than one bucket release exists, the publisher fails closed until `-Bucket`/`-StorageBucket` is supplied. `FINALIZE_REVEX.ps1` deploys and re-verifies this Storage binding before Energy broker cutover or Revit installation. Never deploy the fragment or an unreviewed generated wrapper directly.
