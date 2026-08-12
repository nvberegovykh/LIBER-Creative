LIBER REVEX LIVE COMPANION 0.8.19
Hosted Companion build: 20260811r27

MODEL CONTRACT
- Revit Fine-detail geometry is the primary BIM representation through `model.rvxmesh.gz`.
- Categorized metadata boxes are an instant loading/index proxy only.
- Exact geometry loads automatically while BIM is active; Model is a retry/status control.
- FBX is a compatibility fallback.
- RVX records retain Revit ElementId + material identity and stream incrementally to avoid a monolithic WebView2 parse.
- Rooms, Spaces, Areas, CAD/import/analytical/reference and analysis-area objects are excluded from the default physical model.
- Selection, properties, overlays, issue pins, section and walk operate on the same exact geometry scene after load.

STABILITY CONTRACT
- Design Book source is fetched concurrently with the BIM index and rendered independently of detailed 3D.
- If authored Design Book data is temporarily unavailable, REVEX forms a deterministic read-only fallback from current BIM metadata.
- BIM rendering/Walk pauses while BIM is hidden; repeated WebView2 renderer failures still trigger controlled same-project recovery.
- Revit remains source authority; Companion edits remain explicit overlays until reconciled.

SPEC / ENERGY CONTRACT
- Energy is a section inside the REVEX Companion Spec tab; it is not a separate top-level Engineering app/tab.
- Revit Engineering currently exposes one full workflow only: ENERGY SYNC TO COMPANION.
- Energy evidence and results are bound to the active REVEX Project ID; a mismatched project is rejected.
- Applicant/modeler identity and professional seal are not collected by REVEX and remain blank in prepared filing forms.
- Downstream Energy processing has no Revit writeback; only the Revit-side Energy Sync may create/fix Spaces, EADM, and EN/ENERGY tags before evidence publication.
