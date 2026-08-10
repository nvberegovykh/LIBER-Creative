# REVEX BIM Edit + History Contract

Status: implementation contract for the Companion. Revit remains the source model; Companion BIM edits are non-destructive overlays until explicitly reconciled back to Revit.

## 1. Stable identity

Every editable BIM asset is addressed by Revit `UniqueId` first, with numeric `ElementId` as a secondary convenience key. An overlay is always attached to the source REVEX revision that supplied that element.

## 2. Supported Companion BIM operations

Where the asset type permits it, Companion may create overlay operations for:

- move / translate;
- rotate;
- limited editable dimensions or properties exposed by the Companion schema;
- material / finish override;
- visibility / hide;
- delete from the Companion-derived model;
- duplicate only where the object class has a safe explicit implementation.

Unsupported operations must remain disabled rather than silently approximated.

No Companion operation silently mutates the RVT.

## 3. Change journal

Each committed operation creates an append-only history event containing at minimum:

- event id;
- project id;
- source REVEX revision;
- user id / display name;
- UTC timestamp;
- operation kind;
- affected Revit `UniqueId` / `ElementId` values;
- before state;
- after state;
- transform/property/material patch;
- affected levels / plan views;
- viewport camera state;
- viewport snapshot;
- optional user note / issue / chat reference;
- previous event id and resulting overlay version.

Undo/restore creates a new event. History itself is never rewritten.

## 4. History tab

REVEX has one dedicated project-level **History** tab. It is the complete chronological record for:

- Revit source revisions;
- BIM overlay edits;
- Design Book edits;
- Spec Book authored changes;
- Docs uploads and synced Printing Set revisions;
- comments/issues;
- render outputs;
- derived plan exports;
- restore/revert operations.

History supports filtering by user, date, source revision, floor/view, BIM element, Design Book position, Spec item and document.

Selecting an event can show before/after metadata and its captured viewport snapshot. Where feasible, Compare replays the before and after overlay states against the same source revision.

## 5. Derived plan views

When BIM overlays change an asset that affects one or more plan views, REVEX records those plan views as dirty/affected.

REVEX can generate a **Companion-derived plan issue** from the source revision plus overlay state. The derived view:

- does not claim the RVT was modified;
- records source REVEX revision + overlay version;
- records affected level/view ids;
- can be previewed and exported;
- is stored as a versioned Docs/History artifact;
- links back to the exact history events that produced it.

A later overlay change generates a new derived issue/version rather than overwriting the previous export.

## 6. Sync integrity

A later Revit sync replaces only source-owned geometry/metadata/schedule state. REVEX replays compatible overlays by stable identity onto the new source revision.

For each overlay after sync:

- exact stable match -> replay;
- source changed but still compatible -> replay and mark `source_changed`;
- ambiguous match -> do not guess; mark `needs_review`;
- source element removed -> retain history and overlay snapshot as `orphaned/removed_from_revit`;
- manual user-owned data is not deleted by synchronization.

A sync must never overwrite shared/user-authored values merely because a new source revision arrived.

## 7. Reconciliation back to Revit

Future write-back is a separate explicit operation. It consumes selected approved history events, validates them against the current RVT/source revision and reports conflicts before modifying Revit. Automatic background write-back is prohibited by this contract.
