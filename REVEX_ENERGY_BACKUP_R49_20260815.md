# REVEX r49 Energy chain backup — 2026-08-15

This branch is an intentional immutable recovery point for the REVEX 0.8.19 r49 managed Energy chain before the BIM/review hotfix release is merged.

## Git snapshot

- Backup branch base: `21a34ae19c100fa70ce520c9693083e3fa3f25f1`
- Branch: `backup/revex-energy-r49-known-good-20260815`
- Purpose: preserve the repository-side Energy pipeline, worker, broker, Revit Engineering bridge, verification scripts and publisher state that existed immediately after the r49 managed-chain publication work.

## Canonical release archive preserved by the publisher

The production publisher separately pins the full local canonical source archive, which contains release-only source not represented one-for-one in this Git repository:

- Canonical source commit identity: `7c450801e1515af649c7f4ad4bfc4b45f32c59c8`
- Canonical source ref: `local/revex-r49-cloud-worker-runtime-closure`
- Archive: `REVEX_R49_SOURCE_7c450801e1515af649c7f4ad4bfc4b45f32c59c8.zip`
- Archive SHA-256: `7c450801e1515af649c7f4ad4bfc4b45f32c59c867446dae61037e159709fa50`
- Archive size: `52810258` bytes

Do not replace or delete that local archive when applying viewer, schedule, binding or publication hotfixes. The Energy core should remain recoverable independently of those fixes.

## Recovery-critical repository paths

- `src/Liber.Revex.Revit/Engineering/Energy/`
- `src/Liber.Revex.Revit/Engineering/Gbxml/`
- `src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js`
- `src/Liber.Revex.Revit/Services/EngineeringSyncService.cs`
- `server/revex-energy-worker/`
- `server/firebase-functions/`
- `.github/scripts/verify-revex-r49-energy*` and the r49 release verification scripts
- `.github/workflows/revex-r27-0819-engineering-release.yml`
- `PUBLISH_REVEX_R49.ps1`

## Restore rule

If a future REVEX change regresses GeometryCo, Baseline/Proposed OSM generation, either EnergyPlus run, COMcheck/CXL translation, EN-1 packaging, revision binding, or worker/broker invocation, compare/restore the Energy-specific paths from this branch first. Do not roll back unrelated BIM/Design/Spec UI code unless necessary.
