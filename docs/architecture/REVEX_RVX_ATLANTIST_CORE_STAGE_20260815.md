# REVEX / RVX architecture snapshot — Atlantist core-stage candidate

Snapshot date: 2026-08-15

This document freezes the architectural state that emerged in REVEX 0.8.19 r49 and is considered a strong reusable core-stage candidate for the Atlantist BIM engine. It is a recovery and extraction reference, not a declaration that Atlantist already imports these modules.

## Snapshot identity

- Source repository: `nvberegovykh/LIBER-Creative`
- Exact source candidate: `8007dc24b9c1b8cfb947470341cf19d6c866af77`
- Clean code-only backup branch: `backup/revex-rvx-atlantist-core-stage-20260815`
- Architecture-document branch: `backup/revex-rvx-atlantist-core-stage-docs-20260815`
- REVEX build identity: `20260813r49`
- Canonical release archive: `REVEX_R49_SOURCE_8007dc24b9c1b8cfb947470341cf19d6c866af77.zip`
- Canonical archive SHA-256: `605d985e2b2d2a91ba83849d31b33e07698c0859cf57cd71257690a9d874d796`
- Canonical archive size: `52888407` bytes
- Dedicated Drive recovery copy: `REVEX_RVX_ATLANTIST_CORE_STAGE_BACKUP_20260815_8007dc24b9c1b8cfb947470341cf19d6c866af77.zip`
- Drive recovery file ID: `1LNTW_5-00EaMAo7utkf9fysmHOxuvpOy`

The clean backup branch must remain unchanged. Documentation is kept on the derived docs branch so the code snapshot stays byte-for-byte identical to the candidate.

---

## 1. Core architectural idea

REVEX is not treating the browser model as the authoritative BIM database. It separates four concerns:

1. **Authoritative authoring model** — the active Revit RVT is the source of current project geometry and Revit-owned data.
2. **Immutable revision package** — one sync creates one append-only revision containing geometry, metadata, books, documents and integrity evidence.
3. **Browser-native scene representation** — RVX paged tessellation is the exact Revit-derived display stream; IFC is retained as the immutable exchange/authority model and FBX as a compatibility fallback.
4. **Editable review/application overlays** — hide/show, delete/restore, design decisions, images, comments, issues, approvals, history and mappings are stored separately from source geometry so a later Revit sync cannot destroy user-authored work.

This separation is the main part worth preserving for Atlantist. It allows a modeling host, a web renderer and collaborative application state to evolve independently while remaining revision-synchronized.

---

## 2. End-to-end data flow

```text
ACTIVE REVIT DOCUMENT
    |
    | read-only REVEX sync
    v
temporary Fine-detail REVEX 3D view
    |
    +--> IFC authority export
    +--> RVX exact tessellation pages
    +--> viewer-model.json metadata/index
    +--> Design Book source
    +--> native Spec schedule snapshots
    +--> printing-set PDFs
    +--> affected native plan PDFs
    +--> project.json active-document binding
    +--> integrity.json SHA-256 manifest
    |
    v
staging revision
    |
    | atomic commit
    v
rev_YYYYMMDDTHHMMSSfffZ
    |
    | WebView2 native bridge: one file-input transaction
    v
REVEX Companion
    |
    +--> Firebase Storage: immutable revision assets
    +--> Firestore: revision pointers + editable overlays/history
    +--> Three.js viewer: RVX pages streamed progressively
```

A failed stage aborts the revision instead of publishing a partial primitive-only model. The browser pointer advances only after the package passes integrity and geometry checks.

---

## 3. RVX geometry transport

### Purpose

RVX is REVEX's browser-native geometry transport/cache format. It is not a Revit authoring format and does not replace RVT or IFC.

### Page manifest

File: `geometry/model.rvxpages.json`

Schema and format at this snapshot:

- schema: `liber.revex.geometry-pages.v1`
- format: `rvxmesh-gzip-pages`
- binary format: `RVXSCN2`
- page target: ~24 MiB raw per page
- each page has element/triangle/vertex/raw/compressed counts and SHA-256
- tessellation detail used by the exporter: `0.35`
- curtain-wall policy: host container excluded; physical panels and mullions exported individually

### Binary page

Typical file name:

`model-page-0001.rvxmesh.gz`

After gzip decompression the page starts with:

- magic bytes: `RVXSCN2\0`
- 32-bit version: `2`

Each element record is:

```text
uint8   recordType = 1
float64 Revit elementId
int32   materialPartCount
repeat materialPartCount:
    float64 materialElementId
    int32   vertexCount
    repeat vertexCount:
        float32 x
        float32 y
        float32 z
        float32 nx
        float32 ny
        float32 nz
uint8   recordType = 0   // end of page
```

Positions and normals are emitted in viewer coordinates using the current Revit-to-browser axis mapping:

```text
Revit (X, Y, Z) -> viewer (X, Z, -Y)
```

Revit internal feet are retained through the metadata/scene contract.

### Geometry grouping

Geometry is grouped by Revit element and then by material element id. The page therefore retains enough identity to:

- select a real Revit element,
- attach metadata and review state,
- preserve material separation,
- hide/restore by stable element identity,
- stream large projects without loading one monolithic mesh.

### Curtain walls

Curtain-wall host `Wall` elements are treated as containers only. The host-sized substitute geometry is deliberately omitted. Panels and mullions are exported as their actual physical elements. This avoids stale or misleading curtain-wall boxes in the browser.

---

## 4. Physical-model filtering

The physical viewer intentionally excludes non-physical Revit objects.

Excluded categories/classes include or cover:

- `SpatialElement` (Rooms, Spaces, Areas),
- cameras/views/viewports/sheets,
- levels/grids/reference planes/scope boxes,
- project/survey/base points,
- sections/elevations/callouts,
- model/detail/sketch lines,
- imported CAD/DWG/DXF instances,
- analytical objects,
- room/space separation and area boundaries,
- lighting/electrical/energy analysis areas or zones,
- other reference-only/non-model objects.

**Invariant:** Rooms / Spaces / Areas may exist as source/analysis metadata elsewhere, but they do not become rendered boxes, meshes or review-tree geometry.

---

## 5. Viewer metadata contract

`viewer-model.json` uses schema `liber.revex.viewer.v2` and binds browser geometry to Revit data.

Per physical element it preserves:

- Revit element id,
- Revit `UniqueId`,
- IFC GUID,
- category + normalized category key,
- instance name,
- type name and type `UniqueId`,
- family identity,
- level,
- geometry role (`physical` or curtain host `container`),
- proxy eligibility,
- material ids/names/colors/transparency/shininess/smoothness,
- Revit bounding box in internal feet.

Project-level metadata preserves:

- document title/path/unique id,
- source view name/unique id,
- export time,
- project north angle,
- coordinate-system declaration,
- levels/elevations,
- category counts,
- high-detail geometry coverage and triangle/vertex/byte counts.

Bounding boxes are retained as an **instant loading/index proxy**, not as the final physical model.

---

## 6. Browser rendering architecture

The r49 viewer uses Three.js with:

- `WebGLRenderer`,
- `OrbitControls`,
- `FBXLoader` compatibility path,
- `THREE.Cache`,
- ACES filmic tone mapping,
- sRGB output,
- local clipping,
- hemisphere + directional lighting,
- demand-driven render frames instead of an always-running animation loop when not needed.

The viewer adapts renderer settings when hosted inside Revit WebView2 to reduce embedded-host load.

### Model loading strategy

The intended order is:

1. metadata is available immediately;
2. bounded metadata proxies can support initial indexing/UX;
3. exact RVX pages stream progressively;
4. FBX remains a compatibility fallback only;
5. IFC remains the immutable exchange model, not the primary live web-render stream.

The browser maintains maps/indexes for element id and `UniqueId`, plus spatial indexing to associate imported/fallback nodes with source elements.

---

## 7. Navigation and review controls

Preserved interaction set:

- orbit / pan / wheel zoom,
- fit whole model,
- exact-model retry/detail load,
- element picking,
- project tree + element search,
- first-person walk mode,
- WASD movement,
- Q/E vertical movement,
- pointer-drag look,
- selectable walk floor,
- eye-height control,
- FOV control,
- six-face section box.

### Six-face section box

The review integrity layer exposes:

- left,
- right,
- front,
- back,
- bottom,
- top,
- width,
- length,
- height,
- reset,
- enable/disable.

A real `THREE.Box3Helper` named `REVEX_SECTION_BOX` makes the active box visible. Clipping uses six local clipping planes.

Current intentional limitation: material-layer/cut-cap geometry is not synthesized; the section box is geometric clipping.

---

## 8. Selection, overlays and reversible review state

Source geometry is read-only. User review actions are overlays.

Stable overlay identity is based on:

1. Revit `UniqueId` when available,
2. Revit element id only as a fallback/reference.

This is essential because numeric element ids alone can be unsafe across model evolution.

Current reversible BIM review state includes:

- hide,
- show,
- delete-as-review-overlay,
- restore,
- hidden/deleted registry,
- history records,
- source revision association,
- camera state/snapshot hooks,
- affected element/UniqueId/level/view context.

A review delete **never deletes Revit geometry**.

Hidden/deleted records can remain visible in the review registry even if the original source element disappears in a later Revit revision. A stale overlay is not allowed to silently migrate to a different current element.

---

## 9. Revision integrity model

Every sync creates an append-only revision id such as:

`rev_20260814T232513223Z`

The revision is built in staging and committed atomically only after required stages succeed.

Core files include:

- `project.json`
- `design-book.json`
- `spec-revit-push.json`
- IFC authority model
- `viewer-model.json`
- `geometry/model.rvxpages.json`
- `geometry/model-page-####.rvxmesh.gz`
- optional FBX fallback
- `printing-sets.json` + PDFs
- `affected-plan-views.json` + PDFs
- `integrity.json`

`integrity.json` records file byte counts and SHA-256 hashes for controlled revision assets.

Browser publication rechecks those hashes and sizes before advancing the BIM pointer.

---

## 10. Active-document binding

The project binding contract records:

- document title,
- Revit document unique id,
- document fingerprint,
- central path,
- worksharing state,
- REVEX project id,
- Spec project id,
- binding version/source,
- identity evidence digest,
- identity display name/evidence sheets,
- export timestamp.

The r49 binding contract requires evidence-verified active-Revit-document identity (`active-revit-evidence-v1`) for controlled publication/Engineering handoff.

Mixed-project and mixed-Spec publication are explicitly rejected.

Settings persistence merges durable document bindings by recency so a stale long-lived UI settings object cannot erase a binding created by a sync event.

---

## 11. Native host -> browser bridge

The Revit add-in attaches one revision to Companion through WebView2.

Important details worth preserving:

- waits for an explicit browser sync-readiness barrier,
- attaches project/design/spec/metadata/integrity/IFC/RVX manifest/all RVX pages/FBX/docs in one file-input transaction,
- refuses publication if IFC authority is missing,
- refuses publication if neither complete paged exact geometry nor legacy exact geometry exists,
- uses DevTools `DOM.setFileInputFiles`,
- arms a one-shot `change` probe first,
- dispatches a synthetic event only if Chromium did not already emit one,
- therefore keeps **one native sync -> one cloud publish**.

This host-adapter boundary is especially reusable for Atlantist: the browser engine does not need to know whether its source came from Revit, another CAD/BIM host, or a native Atlantist modeling session as long as the revision contract is satisfied.

---

## 12. Cloud state separation

Current cloud rule:

- immutable BIM/revision files live in Firebase Storage,
- revision pointers and collaborative/editable records live in Firestore.

This avoids storing huge binary geometry as database documents and keeps source revisions separate from user-authored state.

Project access is project-scoped and the r49 release gate verifies owner/member/admin functional access while denying anonymous, outsider and cross-project access.

A local-storage mode exists as a degraded/offline application fallback for project/history/overlay state.

---

## 13. Design Book architecture

The Design Book is formed read-only from Revit plus a preserved editable Companion layer.

Formation strategy at this snapshot:

- approved `87 WINTHROP ST - DESIGN` reference structure,
- Design-classified Revit schedules,
- synced physical model/type groups,
- Revit-derived source positions,
- user-owned decisions/images/approval state stored separately.

Design position versions are immutable **per position**, not one chapter-wide version bucket.

A later Revit sync may update source-owned geometry/schedule/type data but must not overwrite user decisions, images, comments, approvals or mappings.

---

## 14. Spec Book architecture

Every non-Design project schedule is exported independently.

The native presentation snapshot preserves per schedule:

- schedule identity,
- field order,
- field name and column heading,
- hidden state,
- sheet column width,
- alignment/field type where available,
- header cells,
- body cells,
- merged-cell extents,
- sort/group order and display flags,
- itemization,
- title/header/grand-total settings,
- exact Revit row order.

The simple `{headers, rows}` representation exists only as a compatibility projection.

Cloud Spec sources can index the immutable stored `spec-revit-push.json`; the compatibility layer hydrates the individual schedule payload before the Specifications app consumes it.

---

## 15. Documents and affected-view synchronization

The revision also carries project-document evidence:

- immutable printing-set PDFs per REVEX revision,
- affected native Revit plan-view PDFs regenerated from the same revision when observed model changes touch them.

Manual project documents are separate and are never pruned/replaced by a Revit source sync.

This is part of the same-revision integrity rule: BIM, Design/Spec source state and affected exported plan views should not become detached snapshots from different model revisions.

---

## 16. Energy boundary

Energy is integrated with the same project/revision/evidence discipline but remains a separable downstream subsystem.

The viewer core should preserve only the boundary contracts:

- active-document identity,
- exact project id,
- immutable Engineering revision id,
- source evidence/artifact identity,
- explicit downstream consent where required,
- result attachment to the exact source revision.

GeometryCo, Baseline/Proposed OSM generation, the two EnergyPlus runs, COMcheck/CXL and EN-1 packaging are not part of RVX rendering and should remain independently replaceable.

This separation is intentional and is useful for Atlantist: scene/revision infrastructure should not depend on one simulation implementation.

---

## 17. Current feature inventory worth preserving

### Scene / geometry

- exact Revit tessellation
- progressive gzip page loading
- material-part grouping
- element identity retention
- metadata-first loading
- bounded proxy fallback
- IFC authority copy
- FBX compatibility fallback
- physical-only scene filtering
- curtain panel/mullion fidelity

### Navigation

- orbit
- pan
- zoom
- fit
- picking
- walk mode
- floor/eye/FOV controls
- six-face clipping box
- visible section helper

### Review

- element inspector
- search/tree
- stable overlays
- reversible hide/show
- reversible delete/restore
- hidden/deleted registry
- history records
- issue/camera hooks
- non-destructive source model

### Revision/data integrity

- append-only revisions
- atomic staging/commit
- SHA-256 manifest
- current-pointer gating
- active-document evidence binding
- mixed-project rejection
- separate source and editable state
- stable identity across revisions

### Application projections

- Design Book from Revit + editable overlays
- per-position Design versions
- native per-schedule Spec presentation
- printing sets
- synchronized affected plan exports
- project docs/chat/spec integration
- managed Energy boundary

### Runtime/deployment

- browser app
- Revit WebView2 host
- local/offline compatibility path
- Firebase Storage + Firestore cloud state
- cache/build identity diagnostics
- release-level recorded-Revit and live-service QA

---

## 18. Atlantist reuse boundary

The public Atlantist repository already describes a browser BIM platform using Three.js, synchronized modeling views, issue tracking and Energy/analysis systems. The REVEX/RVX snapshot should therefore be treated as a **reference implementation / extraction candidate** for scene delivery and revision/review integrity, not copied wholesale as one monolith.

Recommended extraction seams (architectural targets, not current module names):

```text
AtlantistSceneCore
  SceneRevision
  GeometryPageManifest
  RVXSceneCodec / RVXPageDecoder
  GeometryStreamLoader
  MetadataIndex
  MaterialRegistry
  ElementIdentity
  SelectionService
  SpatialIndex
  NavigationController
  WalkController
  SectionBoxController
  ReviewOverlayStore
  IssueAnchor / CameraState
  HostAdapter
  RevisionStore
  IntegrityVerifier
```

Host-specific Revit export belongs outside that core:

```text
RevitAdapter
  RevitPhysicalElementFilter
  RevitTessellationExporter
  RevitMetadataExporter
  RevitScheduleExporter
  RevitRevisionBuilder
  WebView2CompanionBridge
```

Design Book, Spec Book and Energy should consume the core contracts rather than being required by the renderer.

---

## 19. Important invariants / do-not-regress list

1. RVT remains authoritative when REVEX is operating as a Revit companion.
2. RVX is a transport/display representation, never the master authoring model.
3. IFC and RVX roles must not be conflated.
4. Rooms/Spaces/Areas/analysis objects remain invisible in the physical viewer.
5. Curtain host boxes must not replace actual panels/mullions.
6. A partial exact-geometry revision must not advance the BIM pointer.
7. Source sync never destroys Companion-owned overlays/history/design/spec-authored data.
8. Review delete is reversible and never mutates RVT.
9. Stable Revit `UniqueId` is the preferred cross-revision overlay identity.
10. One host sync event must create at most one cloud publication.
11. Build/cache identity must match the actual deployed source.
12. Spec schedules retain their individual native Revit presentation.
13. Design versions belong to individual positions.
14. Affected plan exports share the same authoritative source revision.
15. Engineering/Energy may only consume the exact evidence-bound project/revision.
16. The renderer must remain usable independently of Energy, Spec and Design subsystems.

---

## 20. Primary source files at this snapshot

Core renderer / revision files:

- `docs/liber-apps/apps/revex/viewer-r26.js` — blob `e180fb1356278ee169d3f1132878dc3c6d92c6c2`
- `docs/liber-apps/apps/revex/store.js` — blob `4627376535bbf10cfcfa91777f5cfff76bb9089e`
- `docs/liber-apps/apps/revex/integrity.js` — blob `80cf64aa09365629884a37af1f21c84b24e6403c`
- `docs/liber-apps/apps/revex/review-integrity-r50.js` — blob `5435a805357404b9a89da067137d18825304ecfd`
- `docs/liber-apps/apps/revex/app.js` — blob `032330c75f7e623dd444c713038c1279950fe836`
- `src/Liber.Revex.Revit/Services/RevexMeshExportService.cs` — blob `8b2638c0e99a79da240214e6e5c1f67822d6cb48`
- `src/Liber.Revex.Revit/Services/ViewerExportService.cs` — blob `7a7da7acc97f8290fa208b4bb29d252105b587ef`
- `src/Liber.Revex.Revit/Services/CompanionWebBridge.cs` — blob `7991da654de3d3a1bfcc9c193e4c162d1dff846e`
- `src/Liber.Revex.Revit/Models/RevexSyncModels.cs` — blob `49b003b2e68eb34dfb93584d66eb8aedf5f9d7af`
- `src/Liber.Revex.Revit/Services/RevexSyncService.cs` — blob `bcb75c473f6e78b8c1f551afdff0698dff7d7b07`
- `src/Liber.Revex.Revit/Services/DesignBookScheduleService.cs` — blob `5c8f7ccdd4155d87fced9cc4695ddb018c080541`

The full backup branch/archive, not this shortlist, is the actual recovery source.

---

## 21. Restore procedure

### Exact code restoration

Use:

`backup/revex-rvx-atlantist-core-stage-20260815`

That branch points directly to the `8007dc...` source candidate and should stay unmodified.

### Full source-bundle restoration

Use Drive file id:

`1LNTW_5-00EaMAo7utkf9fysmHOxuvpOy`

File:

`REVEX_RVX_ATLANTIST_CORE_STAGE_BACKUP_20260815_8007dc24b9c1b8cfb947470341cf19d6c866af77.zip`

Verify the source bundle against canonical SHA-256:

`605d985e2b2d2a91ba83849d31b33e07698c0859cf57cd71257690a9d874d796`

### Architecture reconstruction

Use this document together with the exact branch. Do not rebuild RVX from this prose alone when source code remains available; the document records intent/contracts, while the branch is the executable authority.

---

## 22. Snapshot judgment

At this stage REVEX contains a coherent reusable kernel for a browser BIM engine: exact progressive geometry transport, physical-object filtering, stable source identity, revision integrity, navigation/sectioning, reversible review state and host/cloud separation are all present in one working architecture.

What remains for an Atlantist-native engine is mainly **extraction and generalization**: remove Revit-specific assumptions from the scene core, make native parametric Atlantist geometry another host/source adapter, and unify this renderer/revision layer with Atlantist's DAG/model-authoring system. The RVX/REVEX snapshot should be kept as the reference behavior while that extraction happens.
