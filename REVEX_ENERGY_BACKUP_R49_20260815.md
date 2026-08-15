# REVEX r49 Energy chain backup — 2026-08-15

This branch is an intentional recovery point for the REVEX 0.8.19 r49 managed Energy chain before the BIM/review hotfix release is published.

## Git snapshot

- Preserved Energy-code baseline: `21a34ae19c100fa70ce520c9693083e3fa3f25f1`
- Branch: `backup/revex-energy-r49-known-good-20260815`
- Purpose: preserve the repository-side Energy pipeline, worker, broker, Revit Engineering bridge, verification scripts and release workflow that existed immediately after the r49 managed-chain work.

## Current immutable release bundle

The active Windows publisher is now pinned to the review-integrity candidate whose Energy-core paths are unchanged from the baseline above:

- Canonical source candidate: `8007dc24b9c1b8cfb947470341cf19d6c866af77`
- Canonical source ref: `agent/revex-r49-review-integrity-20260814`
- Canonical archive: `REVEX_R49_SOURCE_8007dc24b9c1b8cfb947470341cf19d6c866af77.zip`
- Canonical archive SHA-256: `605d985e2b2d2a91ba83849d31b33e07698c0859cf57cd71257690a9d874d796`
- Canonical archive size: `52888407` bytes
- Explicit Drive recovery copy: `REVEX_R49_ENERGY_CHAIN_BACKUP_20260815_8007dc24b9c1b8cfb947470341cf19d6c866af77.zip`
- Drive recovery file ID: `1V1oqnnVvzpgCLrD5EeAlA_g6ZZRa_vuy`

The `8007dc` candidate changes BIM review, schedule hydration and binding persistence only. A Git comparison from `21a34ae...` to `8007dc...` contains no changes under the Energy pipeline, gbXML engine, managed Energy bridge, worker, or Firebase broker paths.

## Earlier r49 canonical identity

For forensic history, the earlier publisher closure identified:

- Canonical source identity: `7c450801e1515af649c7f4ad4bfc4b45f32c59c8`
- Canonical source ref: `local/revex-r49-cloud-worker-runtime-closure`
- Archive name: `REVEX_R49_SOURCE_7c450801e1515af649c7f4ad4bfc4b45f32c59c8.zip`
- Archive SHA-256: `7c450801e1515af649c7f4ad4bfc4b45f32c59c867446dae61037e159709fa50`
- Archive size: `52810258` bytes

This section records the prior identity only; recovery should prefer the Git baseline plus the explicit `8007dc` Drive backup above.

## Recovery-critical repository paths

- `src/Liber.Revex.Revit/Engineering/Energy/`
- `src/Liber.Revex.Revit/Engineering/Gbxml/`
- `src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js`
- `src/Liber.Revex.Revit/Services/EngineeringSyncService.cs`
- `server/revex-energy-worker/`
- `server/firebase-functions/`
- r49 release verification scripts and workflow
- `PUBLISH_REVEX_R49.ps1`

## Restore rule

If a future REVEX change regresses GeometryCo, Baseline/Proposed OSM generation, either EnergyPlus run, COMcheck/CXL translation, EN-1 packaging, revision binding, or worker/broker invocation, compare/restore the Energy-specific paths from this branch first. Do not roll back unrelated BIM/Design/Spec UI code unless necessary.
