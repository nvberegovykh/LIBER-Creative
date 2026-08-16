# REVEX Development Contract

This file records the architectural rules learned while stabilizing REVEX / REVEX Companion. New work must preserve these rules unless a replacement is demonstrably simpler, faster, and fully tested end to end.

## 1. One concern = one runtime owner

Do not stack repair runtimes that independently hydrate or mutate the same state.

Current ownership:

- canonical BIM visibility: pre-app Store wrapper in `ui-integrity.js`
- BIM appearance persistence/live state: `appearance-state-r75.js`
- BIM rendering and appearance projection: `viewer-runtime-r75.js`
- BIM Properties, Family → Type → Instance filter, Restore All: `companion-runtime-r75.js` plus the narrow proven r79 interface repair
- base scene / picking / walk / section primitives: `viewer-r26.js`
- Energy downstream execution: authenticated managed broker + private worker
- immutable Revit evidence creation: Revit add-in only

A successor runtime must replace the old owner in `ui-integrity.js`; do not load two independent owners for the same state.

## 2. Viewer performance contract

The BIM viewer must remain interactive even when exact geometry is unavailable, downloading, decoding, or defective.

- show the best valid lightweight representation immediately when exact geometry is not yet ready
- target 30 FPS for normal orbit/pan/walk in the hosted Revit WebView
- exact geometry builds off-scene and may replace an initial fallback only when the complete candidate is valid
- when exact geometry is already loaded, keep it during interaction unless repeated measured frame intervals miss the FPS budget; only then use the proxy temporarily
- active user interaction preempts background geometry work
- cooperative CPU slices should stay around 5 ms before yielding to `requestAnimationFrame`
- immutable geometry pages use browser/local cache; do not force `no-store`
- never traverse/rebuild the entire model for one visibility or appearance edit
- hidden meshes remain indexed so Restore can always find them
- project re-entry must render a usable fallback before exact-detail promotion

## 3. BIM state lanes are separate

Never merge these concerns again:

1. **Geometry transform** — move/rotate only
2. **Visibility** — canonical `visible | hidden | deleted`
3. **Appearance** — texture, design-color fallback, opacity

Appearance priority:

`committed texture → committed design color → Revit/model appearance`

A same-Revit-type appearance is one type record, never N per-instance geometry overlays.

## 4. Visibility edits must be instant

- Hide/Show/Delete/Restore updates the current viewer optimistically before cloud round-trip.
- Restore All is one logical operation and persists with bounded concurrency through Store-supported writes. Do **not** assume `writeBatch` exists in the shared Firebase wrapper.
- Compatibility booleans (`hidden`, `deleted`) are derived from canonical visibility.
- A Show/Restore operation always clears both hidden and deleted compatibility flags.

## 5. No polling as application architecture

Do not use repeated 100–200 ms `setInterval` loops to discover state, DOM, selection, filters, or project changes.

Use:

- explicit application events
- project subscriptions
- one bounded readiness probe only where an external browser boundary genuinely requires it
- MutationObserver only for the exact DOM subtree that is replaced

Polling multiplies work and turns small model operations into WebView freezes.

## 6. Docs must not block the Companion UI

Never download and split a full printing-set PDF on the main browser thread merely to show one sheet.

Preferred order:

1. already-created immutable single-page asset
2. source PDF with native `#page=N` positioning
3. pre-split pages created during sync/export/background preparation

Do not run `pdf-lib` full-set splitting during a normal sheet click in the shared Companion WebView.

## 7. Integrations belong inside the relevant workspace

Provider integrations should be an easy modal/docked endpoint in the current task context, not a block of external-site buttons.

For BIM materials:

- Architextures is surfaced inside BIM Properties
- user browses/edits the provider normally
- REVEX does not script provider searches/clicks or scrape/bulk-download the site
- a user-triggered supported texture download may be intercepted by the native host and applied automatically
- texture asset is copied into the project-owned private material lane
- provider source identity is retained

A separate browser window is a fallback of last resort, not the primary UX.

## 8. Immutable Energy handoff is local data, not browser networking

Revit creates a committed Engineering Sync revision folder containing at minimum:

- `engineering-sync.json`
- `revit-energy.xml`
- `weather.epw`
- declared evidence/report artifacts

Production handoff uses a **private, native-managed hidden file input** created only for the transfer. CDP binds the exact files from the committed local revision folder, then REVEX directly calls `__revexManagedEnergyBridge.processInput(FileList)`. No `change` event is dispatched, so legacy hosted handlers cannot observe or race the transfer.

Do not use a normal/public Energy file input for production handoff. Do not use browser `fetch()` of a local WebView virtual host for the committed folder; CSP/CORS/browser policy can turn a valid local revision into `Failed to fetch`.

The managed bridge re-verifies manifest + XML + EPW before cloud publication. If the add-in or Companion restarts after Revit has already committed a revision, resume the newest matching local revision rather than rerunning Revit geometry.

## 9. Current-project identity is evidence normalization, not a template value

Project identity comes only from the bound active Revit document and immutable T/Z evidence. Approved PRM/EN-1 references contribute structure, schedules, constructions, systems and form topology only.

- accept Revit Project Information and titleblock parameters as the same current-document evidence graph
- accept combined/multiline address values such as `250 MIDWOOD STREET,\nBROOKLYN, NY 11225`; split city/state/ZIP deterministically before declaring evidence missing
- page facts may fill gaps from visible T/Z text; never infer identity from browser state, file paths, prior revisions or reference projects
- a missing normalized field is not proof that the evidence is absent; inspect the raw captured Revit fields before blocking the run
- compiled OSM/IDF/reports must be stamped with current-project identity and retain anti-reference-identity leak guards
- applicant/modeler/signature/seal remain blank unless explicitly supplied by the authorized filing workflow

## 10. Revit spatial-topology failures use evidence-preserving fallback

If Revit throws the narrow ambiguous Room/Space analytical-boundary exception before the Python evidence gate can handle it:

- retry once with automatic Space topology mutation disabled
- use existing Rooms/Spaces and established EADM/direct-Revit fallbacks
- do not guess a thermal boundary closure
- dependency/phase/auth/programming errors remain hard failures

## 11. Every add-in source change must compile the real DLL in CI

Source-text assertions are not a build.

For any `src/Liber.Revex.Revit/**` change, CI must:

1. restore .NET dependencies
2. compile the complete Revit 2026 add-in assembly
3. run current Companion / Energy contracts

Production/local builds bind to the installed Autodesk Revit 2026 API. CI may use a compile-only matching Revit API reference pack.

Do not ask a user to run an updater until the exact source candidate has passed the complete DLL compile gate.

## 12. Windows deployment rules

- native process exit code is authoritative
- normal stderr/progress output from `gcloud` or similar tools is not a failure by itself
- PowerShell `ErrorActionPreference=Stop` must not convert successful native stderr into a false failure
- publisher/updater must identify exact source SHA
- add-in replacement is atomic and rollback-safe
- deployment/update launchers belong in the REVEX project root and must be source-controlled/wired before a user is asked to run them
- do not mix a current add-in refresh with Firebase/Cloud Run/renderer deployment unless that scope is explicitly required

## 13. Diagnostics are evidence, not workload

- deduplicate identical browser diagnostics over a short interval and count repeats
- do not create multiple workflow/log records for the same high-frequency browser symptom
- preserve the first useful stack/context
- performance must not collapse because the diagnostic system is reporting the collapse
- **Energy failures are revision-scoped:** never show a FAILED Energy result from revision A as the status of current Engineering revision B
- when current Engineering advances, hide old failure UI and keep its evidence accessible only as history

## 14. Release discipline

Before merging a viewer/add-in change:

- browser syntax checks green
- current-generation regression guard green
- viewer state/performance contract green
- Energy evidence/managed-handoff contract green when touched
- full Revit DLL compile green when C# is touched
- no deprecated runtime is still loaded by `ui-integrity.js`
- no release gate requires behavior intentionally retired by the successor architecture

The objective is not to accumulate fixes. The objective is a small number of authoritative, observable, replaceable primitives with deterministic fallbacks.
