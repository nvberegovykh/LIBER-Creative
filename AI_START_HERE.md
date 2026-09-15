# LIBER / REVEX — AI START HERE

This repository is the public source landing for AI systems working with LIBER and REVEX.

Machine-readable discovery: `docs/.well-known/liber-ai.json` (served as `https://liberpict.com/.well-known/liber-ai.json` when this branch reaches the live `docs/` site).

## Operating rule

Use the current runtime owner. Do not create a second BIM viewer, geometry parser, database owner, chat owner, render owner, Energy engine, or Revit mutation engine.

The current REVEX contract is:

`Revit authority -> immutable REVEX revision -> exact RVX scene -> Observer focus -> bounded adapter -> one native Revit transition -> observe again`

## Current source owners

- REVEX Companion shell / BIM orchestration: `docs/liber-apps/apps/revex/app.js`
- REVEX project/store boundary: `docs/liber-apps/apps/revex/store.js`
- Exact RVX model export: `src/Liber.Revex.Revit/Services/RevexMeshExportService.cs`
- Revit request / ExternalEvent owner: `src/Liber.Revex.Revit/Revit/RevitRequestHandler.cs`
- Native web bridge: `src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs`
- WALLT helper/fixer control plane: `docs/liber-apps/apps/revex/wallt-control-plane.js`
- WALLT bounded fixer adapters: `docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js`
- Observer / hidden-focus candidate: `docs/liber-apps/apps/revex/observer-focus-api-r143.js`
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
  scope: { elementIds: ['3436315'], stableFaceRefs: [] },
  protected: ['host identity', 'rails', 'cab extents', 'stop elevations']
});

focus.focusId;
```

Use `focusId` for later `getFocus`, `recordStep`, `preview`, and bounded adapter calls.

## Security boundary

- Never place bearer tokens, service-account JSON, private keys, OAuth refresh tokens, API secrets, or signing keys in this repository or in focus records.
- Browser/runtime observation uses the existing authenticated REVEX session.
- A future headless-agent capability token must be server-issued, short-lived, project/focus/action scoped, revocable, and never written to Git, Firestore History, browser diagnostics, or model evidence.
- A focus key identifies a task. A capability token authorizes an action. They are intentionally different things.
- Revit remains the final model authority. Browser JavaScript does not directly manufacture authoritative BIM state.

## Observer's Method for agents

For every consequential step:

1. Snapshot the current project, revision, selected object, runtime owners, and focus state.
2. Identify protected invariants and the smallest useful change.
3. Preview against the expected revision.
4. Execute only through the registered bounded owner/adapter.
5. Regenerate/reload the authoritative representation.
6. Compare expected delta with observed delta.
7. Record the state transition in the focus journal.
8. Continue from the last verified state or reverse only the failed transition.

Do not collapse a long repair into one opaque transaction when the system can preserve useful intermediate states.

## Production / source parity

`docs/CNAME` binds the public docs tree to `liberpict.com`. The live REVEX UI is therefore intended to be served from this repository's `docs/` surface. Do not assume byte-for-byte parity from that fact alone: use the public manifest plus the parity verifier before a production mutation.

The Observer candidate is read-only until an explicit bounded mutation adapter is proven and authorized.
