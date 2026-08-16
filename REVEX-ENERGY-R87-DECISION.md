# REVEX Energy r87 — generalized action boundary

This change is intentionally generalized before wiring.

## Failure localized
The managed worker completed the published Engineering revision, then result acceptance failed because project locality normalization did not produce city/state/ZIP from the already-verified active-Revit evidence.

## General primitives
1. **Active-Revit identity normalizer** — normalize any verified active-document Project Information/titleblock/PDF evidence into the pipeline identity contract. No project-specific mappings or reference-project identity are permitted.
2. **Immutable revision replay** — the existing managed-server primitive is keyed by `{projectId, sourceRevision}`. A server-side repair may replay the currently published failed revision without a Revit export/re-sync.

## Invariants
- active Revit evidence remains authority;
- source artifacts remain immutable;
- consultant/engineer addresses cannot become project identity;
- Census is last-resort derivation from an already-authoritative project street only;
- no Revit work occurs during server retry;
- no worker/broker/renderer architecture rewrite;
- failed results remain failed until a new managed run actually completes.

## Verification density
- unrelated synthetic addresses in NY, CA, TX, MA, CO;
- multiline and one-line titleblock forms;
- distracting consultant/engineer addresses;
- missing identity remains missing rather than fabricated;
- live Midwood shape retained only as a regression fixture;
- runtime normalizer/resolver reject Midwood/Winthrop literal branches;
- Docker image executes generalized identity QA during build;
- worker-only deploy refuses incomplete/project-shaped identity source;
- existing r69 identity, r83 single-shot, renderer and current-generation regressions remain required.
