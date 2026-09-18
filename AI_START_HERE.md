# LIBER / REVEX — AI START HERE

This repository is the public source landing for AI systems working with LIBER and REVEX.

Machine-readable discovery: `docs/.well-known/liber-ai.json` (served as `https://liberpict.com/.well-known/liber-ai.json` when this branch reaches the live `docs/` site).

## AI counter — start here for a new AI session

For an external AI session, do **not** search the repository for credentials or invent a second integration path.

1. Fetch `https://liberpict.com/.well-known/liber-ai.json`.
2. Read `https://liberpict.com/ai/guide.json`.
3. Open `https://liberpict.com/ai/` and take **one AI session package**. The counter is public; no LIBER account or project selection is required there.
4. Give that package to exactly one AI session. The AI exchanges the claim key exactly once and calls `observer_bootstrap`.
5. At this point the AI session is deliberately **not attached to a private project**. It can only request pairing.
6. To attach a private project, an authorized REVEX collaborator opens that project and presses **Pair AI**. REVEX returns a short one-time pairing code.
7. Give that pairing code to the AI. The AI calls `observer_pair`, then `observer_bootstrap` again.
8. Only after successful pairing are `observer.read`, `observer.preview`, and `observer.focus` exposed for that project.
9. Keep the paired REVEX project open while live Observer calls are running. Call `observer_release` when finished.

The public counter and private project authorization are intentionally separate. The counter exposes no project data and receives no Firebase/REVEX credential.

## Operating rule

Use the current runtime owner. Do not create a second BIM viewer, geometry parser, database owner, chat owner, render owner, Energy engine, or Revit mutation engine.

The current REVEX contract is:

`Revit authority -> immutable REVEX revision -> exact RVX scene -> Observer focus -> bounded adapter/workshop -> one native Revit transition -> observe again`

## Current source owners

- REVEX Companion shell / BIM orchestration: `docs/liber-apps/apps/revex/app.js`
- REVEX project/store boundary: `docs/liber-apps/apps/revex/store.js`
- Exact RVX model export: `src/Liber.Revex.Revit/Services/RevexMeshExportService.cs`
- Revit request / ExternalEvent owner: `src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs`
- Native web bridge: `src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs`
- WALLT helper/fixer control plane: `docs/liber-apps/apps/revex/wallt-control-plane.js`
- WALLT bounded fixer adapters: `docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js`
- Observer / hidden-focus runtime: `docs/liber-apps/apps/revex/observer-focus-api-r143.js`
- Observer external-AI browser relay / Pair AI control: `docs/liber-apps/apps/revex/observer-agent-bridge-r151.js`
- Observer external-AI broker / public claim / pairing / MCP surface: `server/firebase-functions/observer-agent-broker.js`
- Native family Observer: `src/Liber.Revex.Revit/Services/ObserverFamilyService.cs`
- Observer WebView2 / ExternalEvent bridge: `src/Liber.Revex.Revit/UI/RevexObserverBridge.cs`
- Elevator proving planner: `docs/liber-apps/apps/revex/observer-elevator-r144.js`
- Elevator isolated workshop runtime: `docs/liber-apps/apps/revex/observer-elevator-workshop-r146.js`
- Elevator isolated workshop native service: `src/Liber.Revex.Revit/Services/ElevatorWorkshopService.cs`
- Cloud broker composition: `server/firebase-functions/main.js`
- Energy worker: `server/revex-energy-worker/app.py`

Historical/versioned files are preserved as evidence and rollback. They are not automatically current runtime owners.

## Observer focus key

A `focusId` returned by `window.RevexObserver.createFocus(...)` is the non-secret key for one bounded task. It is only a locator inside the current authorized REVEX project/session; it is **not** an authentication secret.

Example:

```js
const focus = window.RevexObserver.createFocus({
  name: 'elevator.single-right',
  target: 'single right-side elevator entrance',
  scope: { elementIds: [], stableFaceRefs: [] },
  protected: ['host identity', 'rails', 'cab extents', 'stop elevations']
});

focus.focusId;
```

Use `focusId` for later `getFocus`, `recordStep`, `preview`, and bounded adapter calls.

## Deep family observation

RVX is the authoritative project-scene geometry owner, but a project RVX FamilyInstance does not expose every internal Family Editor dependency. For that boundary, the Observer uses Revit itself as the instrument:

1. select a project FamilyInstance;
2. browser posts `liber:revex-observer-family-inspect-r144`;
3. `RevexObserverBridge` raises a read-only Revit `ExternalEvent`;
4. `ObserverFamilyService` calls `Document.EditFamily(family)`;
5. it reads family parameters, host/reference planes, dimensions/references, GenericForms, nested families, dependent elements, parameter associations, host identity and bounding boxes;
6. it closes the temporary family document with `Close(false)`;
7. no transaction is created and no document is saved.

This is a bounded observation workshop, not a second family engine.

## Elevator proving focus

Inside the REVEX Revit add-in, select the elevator family instance. Observation/planning is:

```js
const observed = await window.RevexObserverElevator.start();
```

The isolated workshop remains detached from the active project and never promotes a candidate back into project authority without a separate explicit validation/production adapter.

## Security boundary

- Never place bearer tokens, service-account JSON, private keys, OAuth refresh tokens, API secrets, or signing keys in this repository or in focus records.
- The public AI counter requires no LIBER account and exposes no project data.
- A public one-time claim creates an unpaired AI lease with only `observer.pair`.
- Private project authorization happens later through a one-time **Pair AI** code created inside an authorized REVEX project session.
- The raw claim, AI bearer, and pairing code are each returned once; only SHA-256 digests are stored server-side.
- The AI bearer never enters the authorized REVEX browser relay.
- The browser relay never gives its Firebase credential to the AI.
- A focus key identifies a task. A pairing code authorizes one project binding. They are intentionally different things.
- Revit remains the final model authority. Browser JavaScript does not directly manufacture authoritative BIM state.

## Observer's Method for agents

For every consequential step:

1. Snapshot the current project, revision, selected object, runtime owners, and focus state.
2. Identify protected invariants and the smallest useful change.
3. Preview against the expected revision.
4. Execute only through the registered bounded owner/adapter or isolated workshop.
5. Regenerate/reload the authoritative or candidate representation.
6. Compare expected delta with observed delta.
7. Record the state transition in the focus journal.
8. Continue from the last verified state or reverse only the failed transition.

Do not collapse a long repair into one opaque transaction when the system can preserve useful intermediate states.

## Projection and abstraction discipline

Dimensional reduction is an observation tool, not permission to replace the observed object.

- Preserve the richest available authoritative state. A render, elevation, plan, section, diagram, label, or language summary is a projection of that state unless it is explicitly the authority.
- When a higher-dimensional relation is hard to reason about, use an ordered stack of lower-dimensional slices and track the same identities across slices. **Slice; do not replace.**
- Keep **object state** separate from **observer state** (camera, viewpoint, projection, crop, coordinate frame, wording). Do not rotate, deform, or reinterpret the object merely to make one projection look right.
- Every lossy abstraction should state what it **preserves**, what it **discards**, and what it is **safe for**. An abstraction may constrain or validate properties it preserves; it must not reconstruct properties it discarded.
- Prefer two or more non-parallel views, slices, measurements, or independent constraints before promoting a spatial inference.
- When speaking to humans, distinguish source-backed observation, deterministic transformation, and inference. Fluent presentation must not erase unresolved state or uncertainty.
- These rules are model-agnostic. They are intended to remain useful for commercial, open-source, local, academic, experimental, and future AI systems.

A useful failure test is **"object demolished by correct abstraction"**: the simplified representation can be internally correct while still being insufficient to recreate the richer object.

## Paper before render

For spatial, visual, reconstruction, product-placement, and similar tasks, do not solve comprehension and rendering in one opaque step.

Use the public machine workflow at `docs/ai/workflows/projection-render-gate.json`.

The short contract is:

`authority freeze -> paper object -> coherence gate -> stop -> human launch -> render -> verify`

**Paper** means the object is established without image synthesis: identity/topology, one stable object coordinate frame, major dimensions and host relations, linked non-parallel projections, ordered depth slices where needed, feature correspondence across views, and an explicit unresolved list.

The paper stage is **ready enough** when all hard invariants and major-form relations agree simultaneously and any remaining uncertainty is non-gating. “Enough” is deliberately not maximal detail.

If the coherence gate fails, continue working on paper. **Do not render to escape an unresolved major-form contradiction.**

If the gate passes, stop and ask the human to launch the rendering stage. Rendering is downstream evidence; it does not become object authority.

### Object-paper runtime

For nontrivial projection problems, the paper stage is executable rather than purely verbal:

- Schema: `docs/ai/schemas/object-paper-v1.schema.json`
- Runtime: `docs/ai/runtime/object-paper-r1.js`
- Teaching example: `docs/ai/examples/four-candle-lantern.object-paper.json`

The runtime keeps one rigid object basis and moves the **observer/projection**, not the object's identity. It supports explicit parallel/orthographic and perspective projections, axonometric foreshortening classification, projected feature-coincidence groups, vector correction constraints, hard topology/count invariants, and a deterministic `evaluatePaperReady(...)` gate.

**Axonometry is the broader family. Isometry is the special case where the three object axes have equal projected foreshortening.** Do not mentally compose uncertain sequential rotations and then bake them into object geometry.

Human redlines or vector markup are evidence/constraints: `preserve`, `expected`, `forbid`, or `note`. They never directly mutate the 3D object. A front projection may legitimately collapse multiple physical features onto fewer visible axes; that is projection, not deletion.

## Production / source parity

`docs/CNAME` binds the public docs tree to `liberpict.com`. The live REVEX UI is therefore intended to be served from this repository's `docs/` surface. Do not assume byte-for-byte parity from that fact alone: use the public manifest plus the parity verifier before a production mutation.

The Observer core and external-AI lease remain read-only. The elevator workshop may mutate detached candidate family documents only; it does not mutate the active project.
