LIBER REVEX LIVE COMPANION 0.8.19
Hosted Companion build: 20260813r44

r44 preserves the r43 project access boundary and completes element-level BIM
visibility, inverse Show hidden filtering, managed Energy retry diagnostics, and
current-project Z/EN filing identity. Authenticated project owners, members, and
LIBER admins can use project content; outsiders remain denied.

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
- If hardware-accelerated WebGL cannot initialize, BIM-only controls disable and REVEX records a correlated `VIEWER_INIT` warning while Design Book, Spec Book, Docs, Energy, Chat, and History remain usable.
- Revit remains source authority; Companion edits remain explicit overlays until reconciled.

SPEC / ENERGY CONTRACT
- Spec Book and Energy are separate top-level REVEX Companion workspaces under the same active REVEX Project ID; there is no separate LIBER Specifications app in the project workflow.
- Revit Engineering exposes the controlled ENERGY SYNC TO COMPANION workflow; downstream processing continues in the top-level Energy workspace.
- Energy evidence and results are bound to the active REVEX Project ID; a mismatched project is rejected.
- Private Engineering/Energy metadata uses the existing project-library authorization boundary; immutable evidence files remain in their revision-scoped Storage prefix and the broker rejects paths outside it.
- Current project identity is populated only from immutable Revit Z pages; current model facts come from EN pages. Applicant/modeler fields remain blank and professional execution is never fabricated.
- Downstream Energy processing has no Revit writeback; only the Revit-side Energy Sync may create/fix Spaces, EADM, and EN/ENERGY tags before evidence publication.

FIRESTORE COMPATIBILITY
- Every BIM, Design Book, Spec Book, Docs, History, Render and Energy write is converted into the Firebase SDK Window realm before validation.
- REVEX library records remain hidden implementation records and do not replace the user-visible project document library.
