LIBER REVEX LIVE COMPANION 0.8.16
Hosted Companion build: 20260811r25

STABILITY CONTRACT
- Design Book source is fetched concurrently with the BIM index and rendered immediately. It no longer waits for browser idle or for detailed 3D parsing.
- If the authored Design Book source is temporarily unavailable, REVEX forms a visible read-only fallback from the current BIM index instead of showing an empty book.
- BIM opens in lightweight metadata-proxy mode. Detailed FBX is explicit/lazy through the Detail button; it never auto-parses on project activation.
- Embedded WebView2 uses conservative renderer settings and stops BIM rendering/Walk while the BIM view is hidden.
- Full FBX detail is rejected before scene adoption when mesh/vertex counts exceed the embedded renderer safety envelope; lightweight BIM remains usable.
- r25 removes the O(meshes × model-elements) node-name scan used by r24. Exact IDs/UniqueIds are tried first; spatial mapping is used only where needed.
- Model tree DOM is bounded; search reaches the rest without creating thousands of buttons on every refresh.
- Source JSON is fetched once by app.js and passed to the viewer; the viewer no longer duplicates project-state/index fetches.
- Repeated WebView2 RenderProcessUnresponsive events trigger a controlled same-project reload in the native REVEX shell.

PRODUCT
BIM, Design Book, Spec Book, Docs, Chat, Render/Rendair and append-only History remain one REVEX project workspace. Revit remains source authority; Companion edits remain explicit overlays until reconciled.
