# REVEX BIM Edit + History Contract

Status: implemented in REVEX Companion 0.8.4 / build 20260810r24. Revit remains the source model; Companion BIM edits are non-destructive overlays until explicitly reconciled back to Revit.

## Stable identity
Every editable BIM asset is addressed by Revit `UniqueId` first, with numeric `ElementId` as a secondary key. Every overlay is attached to the REVEX source revision that supplied the element.

## Companion BIM operations
Where an asset type safely permits exact mapping, Companion creates overlay operations for move/translate, rotate, limited exposed dimensions/properties, material/finish override, visibility/hide, Companion-delete, and safe explicit duplication. Unsupported operations stay disabled instead of being approximated. No Companion operation silently mutates the RVT.

## Change journal
Every committed operation creates an append-only history event with event/project/source revision, user, UTC time, operation, affected Revit IDs, before/after state, transform/property/material patch, affected levels/views, viewport camera state, viewport snapshot, optional note/reference, previous event, and resulting overlay version. Undo/restore creates a new event; history is never rewritten.

## History tab
One project-level History tab must expose the complete chronology for Revit source revisions, BIM overlays, Design Book edits, Spec Book authored changes, Docs/manual uploads and Printing Set revisions, comments/issues, render outputs, derived plan exports, and restore/revert operations. It must filter by user/date/revision/floor/view/BIM element/Design position/Spec item/document and support before/after inspection and snapshot compare where feasible.

## Derived plan views
When BIM overlays affect plan-visible assets, REVEX marks the corresponding levels/views dirty and can generate a Companion-derived plan issue from source revision + overlay state. It is previewable/exportable, versioned in Docs/History, linked to the exact history events, and never claims the RVT itself changed. Later changes create new plan versions instead of overwriting old ones.

## Sync integrity
A later Revit sync replaces source-owned geometry/metadata/schedules only. Compatible overlays replay by stable identity. Exact match -> replay; changed-but-compatible -> replay + `source_changed`; ambiguous -> `needs_review` with no guessing; removed source -> retain history/snapshot as `orphaned/removed_from_revit`. Manual/user-authored values are never deleted merely because source changed.

## Reconciliation to Revit
Any future write-back remains explicit and conflict-checked against the current source revision. Automatic background write-back is prohibited.
