# LIBER / REVEX — AI START HERE

This repository is the public source landing for AI systems working with LIBER and REVEX.

Machine-readable discovery: `docs/.well-known/liber-ai.json` (served as `https://liberpict.com/.well-known/liber-ai.json` when this branch reaches the live `docs/` site).

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
- Native family Observer: `src/Liber.Revex.Revit/Services/ObserverFamilyService.cs`
- Observer WebView2 / ExternalEvent bridge: `src/Liber.Revex.Revit/UI/RevexObserverBridge.cs`
- Elevator proving planner: `docs/liber-apps/apps/revex/observer-elevator-r144.js`
- Elevator isolated workshop runtime: `docs/liber-apps/apps/revex/observer-elevator-workshop-r146.js`
- Elevator isolated workshop native service: `src/Liber.Revex.Revit/Services/ElevatorWorkshopService.cs`
- Authenticated cloud broker / Firebase functions: `server/firebase-functions/index.js`
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

The current isolated proving sequence through S4 is:

```js
const s4 = await window.RevexElevatorWorkshop.proveS4();
```

That sequence:

1. observes the selected project elevator instance and its internal family dependency graph;
2. proves the existing opposite/rear panoramic aperture and single-panel pocket capacity;
3. saves an `S2_BASE.rfa` under `%TEMP%/LIBER_REVEX/observer-workshops/<focus>/...`;
4. S3: retires exactly one proven rear-glass GenericForm in one named Revit transaction, rejects cascading deletion, regenerates, verifies protected family topology, and saves `S3_REAR_GLASS_RETIRED.rfa`;
5. S4: opens that verified S3 file directly, adds only the solid cab-wall infill needed to leave one measured right-aligned clear opening, regenerates, verifies the same protected topology, and saves `S4_RIGHT_OPENING_INFILLED.rfa`;
6. never calls `LoadFamily` and never replaces the family in the active project.

The target remains: one entrance, aligned all the way to the viewer-right edge of the cab, one sliding panel with its pocket to the left, preserving project identity, primary host identity, rails/guides, stop elevations and the family scaffold unless a later verified state intentionally changes it.

The elevator and Observer are intentionally developed as a coupled pair:

`elevator need -> missing observation -> bounded Observer capability -> isolated native transition -> observed candidate -> next smallest transition`

A later state may be promoted only through a separate explicit project-validation / production adapter after review and evidence gates.

## Security boundary

- Never place bearer tokens, service-account JSON, private keys, OAuth refresh tokens, API secrets, or signing keys in this repository or in focus records.
- Browser/runtime observation uses the existing authenticated REVEX session.
- A future headless-agent capability token must be server-issued, short-lived, project/focus/action scoped, revocable, and never written to Git, Firestore History, browser diagnostics, or model evidence.
- A focus key identifies a task. A capability token authorizes an action. They are intentionally different things.
- Revit remains the final model authority. Browser JavaScript does not directly manufacture authoritative BIM state.
- Workshop artifact paths are local execution evidence, not secrets or project authority.

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

## Production / source parity

`docs/CNAME` binds the public docs tree to `liberpict.com`. The live REVEX UI is therefore intended to be served from this repository's `docs/` surface. Do not assume byte-for-byte parity from that fact alone: use the public manifest plus the parity verifier before a production mutation.

The Observer core remains read-only. The elevator workshop may mutate detached candidate family documents only; it does not mutate the active project.
