# REVEX finalization checkpoint — 2026-08-18

This file is the durable resume point for the current REVEX finalization session. A later chat should **read this file first**, then fetch the latest head of `agent/revex-energy-maintainer-20260818` and PR #125 before changing anything.

## Repository / candidate

- Repository: `nvberegovykh/LIBER-Creative`
- Branch: `agent/revex-energy-maintainer-20260818`
- Draft PR: #125 — `WALLT active Energy repair controller`
- Base: `main`
- Base SHA at this checkpoint: `00817045c4fdade8f80e0afa34c081189997cb9b`
- Checkpoint-parent head before this update was committed: `5cec4845e80ab06d91a149335205b929dd93566d`
- This checkpoint commit advances the branch head; always fetch the branch/PR again rather than assuming the parent SHA is still current.

## Non-negotiable architecture

1. **Integrate; do not reconstruct REVEX.** The repository contains many historical generations. Preserve versioned/shadow implementations as evidence and rollback, but do not reactivate multiple owners for one concern.
2. **One concern = one current runtime owner.** WALLT never becomes a second BIM, Docs, Chat, Render, Energy, Family, database, GeometryCo, EnergyPlus, COMcheck or EN-1 implementation.
3. **Immutable Revit / Engineering evidence is read-only.** Derived repairs may be explicit and auditable; project/filing facts are never fabricated.
4. **No real Engineering Sync acceptance attempt until the production-image gate is clean.** The user has only one intended real acceptance attempt.
5. **Render architecture is frozen during core finalization.** Self-hosted Qwen is preserved for later optimization; do not switch Render owner while Energy/Docs/Families/Chat/core connections are being converged.

## WALLT architecture now established

### 1. Helper channel

`docs/liber-apps/apps/revex/wallt-control-plane.js`

The Helper operates the **existing current UI/runtime** on explicit user requests. Current built-in actions include:

- navigate to BIM / Design / Spec / Docs / Energy / Chat / History;
- focus + smooth-scroll/highlight the exact panel/control;
- BIM search and selection;
- Docs search;
- current BIM controls such as Fit / Walk / Section / Show Hidden;
- open Render / refresh History / export affected plan;
- open and prefill the existing BIM or Design issue form, and submit only when the user explicitly asked to add/save/create the issue;
- open Project Chat and pass project-scoped context.

This is deliberately an operator over the current owners, not another application layer.

### 2. Fixer channel

The Fixer receives a current runtime snapshot: project, revision, active view, selected BIM/Design object, viewer mode, native-Revit availability, loaded runtime owners and recent browser diagnostics.

A fix may execute only through a **registered local fixer adapter**. Domain agents (Energy, Docs, Families/Blocks, Chat, BIM/viewer, Render, etc.) expose bounded helper/fixer actions to this control plane. If no safe adapter exists, WALLT diagnoses the likely owner and requests a source-candidate repair; it does not arbitrarily rewrite the DOM or production source.

### 3. 24-hour cycle ledger — durable now

The control plane records request → snapshot → plan → action outcome → completion/failure into a rolling 24-hour local ledger and exposes `cycleReport()`.

`docs/liber-apps/apps/revex/wallt-cycle-history.js` now mirrors meaningful phases (`REQUEST`, `PLAN`, `COMPLETE`, `FAILED`, `ACTION_FAILED`) through the **existing** `RevexStore.appendHistory` boundary using `kind: wallt-cycle`. It does not call Firestore directly and creates no new database owner. LocalStorage remains the immediate/offline cache. The adapter also exposes an async durable 24-hour report sourced from existing project History.

Relevant commits after the first checkpoint:

- `ae1e7d64ecd93206fbf38f812711e54ad3dc1e45` — add project-history persistence adapter;
- `ac866365c2540b9b71cd93af41d6a5cfe2efe673` — load it through current UI integrity;
- `dbc7f8d10c6e9fbaea848933eabd4535df458f2e` — verify existing History ownership / no direct DB mutation;
- `5cec4845e80ab06d91a149335205b929dd93566d` — gate the adapter in the WALLT control-plane workflow.

### WALLT control-plane QA

The first Helper/Fixer workflow run `32149213885` passed syntax and isolated channel contracts. A fresh run for the durable History mirror is queued from the current candidate and must pass before promotion.

## Energy — current state

The active Energy controller is already implemented around the proven pipeline:

- `revex_energy_agent.py` — active WALLT controller;
- `revex_energy_agent_evidence.py` — current-project evidence repair;
- `revex_energy_agent_filing.py` — filing boundary / VT / orientation protection;
- `revex_energy_agent_context.py` — current-project context;
- `revex_energy_maintainer.py` — bounded legacy PDF/Vertex tool library only;
- current runner/facade and Companion review/Revit-return path are wired.

Current verification proves:

- all 26 unique codes from the real prior thermal-match failure resolve from native schedule evidence in the synthetic failure matrix;
- actual VT wins; genuinely missing VT is exactly `0.45`;
- glazed openings receive filing VT while opaque doors do not;
- orientation can be derived from signed surface normal evidence;
- revision-scoped clarification works;
- unresolved filing facts enter `WAITING_USER` before expensive modeling and emit one resumable Revit repair request;
- the Companion can request fresh Revit evidence and review/approve rotatable Geometry/Baseline/Proposed OSMs.

## Exact Energy production-image stop / fix

A prior exact production-image acceptance built successfully and the WALLT verifier passed **inside the Dockerfile build**, but the workflow's later `docker run` verifier failed with:

`ModuleNotFoundError: No module named 'revex_energy_agent_evidence'`

Cause: the post-build verifier process did not inherit `/opt/revex/energy` and `/opt/revex/server` on `PYTHONPATH`. The application entrypoint itself already resolves the packaged Energy module root; this was a verifier/container invocation mismatch, not an Energy modeling failure.

Fix:

- `.github/workflows/revex-wallt-energy-production-image.yml` now runs **all post-build container acceptance checks** with `PYTHONPATH=/opt/revex/energy:/opt/revex/server`.
- Import-path correction commit: `58bf9a3d372b36dbf6eaa096852a669789cfe35c`.
- Run `32150201938` from that correction had reached the exact Docker image build and was still in progress at the latest direct check.
- Because later WALLT History/UI commits also touch `ui-integrity.js`, the current head has a newer production-image run; at this checkpoint the current-head run is `32150630530` and is queued. Always use the latest run attached to the latest head for final acceptance.

### EN-1 print contract that must survive

User-confirmed current output contract:

- **17 selected filing sheets**;
- **63% print scale**;
- first selected sheet: `Color legend`;
- last selected sheet: `HVAC Air-side`;
- no generic Fit-to-One-Page behavior;
- instruction/helper/unused tabs excluded from the filing PDF, while the full workbook remains intact.

`verify_en1_print_contract.py` explicitly asserts 17 pages, 63%, `fitToPage == False`, sheet order and page markers. The production-image workflow must reach and pass this step after the import-path correction. Older r89 verifier output mentioning a 16-page Fit-to-One-Page contract is historical/shadow behavior and must **not** overwrite this current user-confirmed contract.

## Read-only current-owner audit already started

### Docs

Current intended final renderer is `docs-pages-r115.js`:

- one latest Full Set per printing set;
- sheet order follows authoritative Full Set page number;
- each visible sheet is a derived one-page PDF linked through the parent printing-set `sheetIndex`, not a detached top-level document;
- derived page storage sits under a printing-set/revision lane;
- Full Set and page links remain in one printing-set group.

`docs-convergence-r126.js` currently declares `docs-pages-r115` as owner and reasserts it only when a legacy renderer rewrites the Docs tree. No Docs mutation has been made during this audit yet.

### Families / Blocks

The current path exists end-to-end and is being inspected, not rewritten:

`blocks-palette-r126.js` → WebView2 provider bridge → opaque family token → `RevexFamilyPlacementExternalHandler` → `FamilyPlacementService` → Revit transaction.

Current safeguards observed:

- only available in Revit host and Walk mode;
- intended placement ~3 ft ahead of the Walk camera;
- `.rfa` / `.zip` family handoff through the native bridge;
- unsupported curve/adaptive/view-based/detail families fail visibly;
- hosted placement is bounded to nearby physical Revit hosts;
- Revit ExternalEvent owns mutation;
- next BIM Sync becomes authoritative after placement.

No Families fix has been applied yet; exact provider-download/placement connection still needs final contract QA before promotion.

## Known unrelated / historical red CI

Do not chase these as Energy regressions unless new evidence says otherwise:

- current WebView/UI cache generation mismatch (`index` build around `20260818r128-full-convergence1` vs `ui-integrity.js` `20260818r132-priority-fixes2`);
- historical self-hosted Render guards that demand Qwen ownership while the present canonical release intentionally keeps Google as Render owner;
- other old version-specific convergence tests that encode superseded owners.

They can be repaired/consolidated later during the single-source cleanup, but must not force a rollback of proven current Energy logic.

## Render — intentionally frozen

There is a substantial preserved self-hosted renderer:

- `Qwen/Qwen-Image-Edit-2511`, pinned immutable revision;
- private REVEX broker;
- private Cloud Run GPU worker;
- persistent model cache;
- deployment intended for one NVIDIA RTX PRO 6000, 80 GiB RAM, concurrency 1, warm instance;
- no browser inference and no Hugging Face login required.

Later convergence work demoted it and made Gemini/Nano Banana the canonical client. The user prefers controlled self-hosted Qwen to recurring image-API cost, but explicitly asked to revisit this **after greater platform problems are solved**. Do not perform a Banana→Qwen second raster pass; if Qwen returns later, it should be the direct render path from the authoritative REVEX viewport.

## Remaining finalization order

1. **Energy production image:** get the latest current-head run to completion; if red, inspect only its exact failing step. Do not use real Revit Sync for container/debug packaging.
2. **Confirm 17-sheet / 63% EN-1 acceptance inside the exact image.**
3. **Confirm durable WALLT Helper/Fixer History mirror workflow is green.**
4. **Connection/owner audit:** current Revit bridge ↔ Companion ↔ Store/Firestore/Storage and each module owner.
5. **Docs:** validate one Full Set owner and linked per-page group behavior in the current runtime; add a regression probe before changing code.
6. **Families / Blocks:** validate provider-download → opaque token → ExternalEvent → FamilyPlacementService end-to-end and add a regression probe; repair only the broken boundary if found.
7. **Chat:** exact current project connection; cross-project reset/isolation; Helper can navigate/pass context without becoming chat storage owner.
8. **Render:** verify current path only; do not redesign yet.
9. Add local domain Helper/Fixer adapters as each owner is proven.
10. Run cross-platform/current-owner regression and consolidate only verified fixes into the propagated candidate.
11. Only after the candidate is internally clean: one real `SYNC ENGINEERING` acceptance and package review.

## RESUME HERE — exact next action

When resuming this work:

1. Fetch PR #125 and latest branch head.
2. Read this checkpoint.
3. Fetch the **latest** `REVEX WALLT Energy production image acceptance` run attached to that head (checkpoint current-head run: `32150630530`).
4. Require all three post-build acceptance steps to pass:
   - WALLT verifier inside exact image;
   - **17-sheet / 63% EN-1 PDF export verification inside exact image**;
   - active current runner / print-policy import binding.
5. Fetch the latest `REVEX WALLT helper + fixer control plane` run (checkpoint current-head run: `32150630648`) and require the durable existing-History ownership checks to pass.
6. If both gates are green, continue the current-owner audit at **Docs runtime verification**, then **Families/Blocks provider/ExternalEvent contract**, then Chat.
7. If either gate is red, inspect that exact job/step and repair only that boundary; do not roll back the established architecture.

Do not spend the real Engineering Sync merely to discover a packaging/import mistake.
