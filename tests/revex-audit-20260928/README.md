# REVEX audit acceptance

The browser checks exercise an exact Firebase Hosting preview using ordinary Firebase authentication. They guard both the owner and `qaFixture` marker before making any cloud writes. Never substitute a customer project for these fixtures.

Run `audit-ui.cjs` and `asset-ui.cjs` in the pinned Playwright 1.58.2 image with `REVEX_PREVIEW_URL` set to the candidate preview. Supply the existing private QA fixture credentials at `/workspace/qa-private/accounts.json`; credentials are deliberately absent from this repository. Results and screenshots go to `/workspace/results/audit` and `/workspace/results/assets`.

Coverage includes actual native-model raycasting and known-distance measurement, retained numeric source chapters hidden from presentation, history disclosure, repeated Spec Book updates, embedded GLB textures, real IFC/FBX parsers, OBJ/materials, STL/ZIP, actual Storage/Firestore save and reload, floor and rotation preservation, reuse/removal, download-folder handler, stale import boundaries, live WALLT, grounded purchase links, and responsive panel containment. The folder test substitutes a granted directory handle; the browser's native permission prompt is not automated.

Backend checks:

```
node --test server/revex-report-functions/publication-source.test.js server/revex-energy-functions/job-ownership.test.js server/revex-assistant-functions/purchase-links.test.js
```

Separate runtime acceptance used the deployed worker image and source: OpenStudio 3.10.0 / EnergyPlus 25.1.0 completed four full 8,760-hour runs (explicit and template HVAC, baseline and proposed). Official PNNL COMcheck returned a four-page report on an anonymized fixture. These prove engine operation, not acceptance or compliance of a customer's building. The later actual-building audit identified a reference-construction row incorrectly treated as physical COMcheck geometry, justified overlapping opening cuts, and native numerical edge-clearance warnings. The analytical normalization is bounded and separately reported; the original Engineering export is unchanged. Positive, reconciled explicit zone volumes permit calculation while zone-enclosure warnings remain mandatory review findings. Native severe/fatal errors and unsupported opening geometry still stop the run.

Daily reports were verified against the actual immutable publication manifests, byte hashes and receipt chain, then generated through the production report code. Legacy missing top-level identity is accepted only when the immutable manifest binds it; conflicting identity still fails.

The broader recovery regression journey also covers two-editor conflicts, Unicode and image persistence, book CSV/PDF export, Docs and History, read failures, and late assistant responses. Render-return handling is tested with a simulated provider callback; this audit does not claim a newly purchased image-generation run.

The current personal Google render journey is in `personal-ui.cjs`: real Firebase/project/model loading, with Google OAuth, project enumeration and provider payment failure mocked so no image charges are incurred. It verifies identity isolation, explicit customer billing selection, pricing, no paid fallback or retry, and responsive containment at six widths. `PERSONAL-AND-ENERGY-UI.json` records the eleven passing checks; `HOSTING-REVIEW-RELEASE.json` pins the exact live candidate. Actual paid Google rendering and sensitive-scope verification remain external acceptance items.

The subsequent read-only provider check found that a token with Cloud Platform permission alone is insufficient for the Gemini API. The renderer now requests Google's documented `generative-language.retriever` scope, uses `cloud-platform.read-only` only for project enumeration, and rejects partial grants. Ten authorization checks and the eleven browser checks pass. `HOSTING-PERMISSIONS-RELEASE.json` pins this final release; `GOOGLE-PERMISSION-ACCEPTANCE.json` distinguishes the real provider observation from mocked acceptance. Google branding is verified; sensitive-scope review still requires a real authorization demonstration video.

The fresh production run completed on September 28 at 11:29 UTC for Engineering revision `eng_20260928T092852379Z`, publishing `energy_20260928T112851Z`. Both annual simulations, EN-1 spreadsheet/PDF, official four-page COMcheck (pass, index 6), and final publication completed. All 17 published downloads returned HTTP 200 and matched their declared bytes and hashes. The final release ZIP contains nine entries: three models, two annual HTML reports, EN-1 XLSX/PDF, official COMcheck PDF, and the nine-PDF Packager archive. Its document index preserves the geometry review disclosure and embedded audit JSON. `ENERGY-PRODUCTION-ACCEPTANCE.json` records this outcome. It is a completed calculation with mandatory review findings, not filing approval or a promise that arbitrary Revit geometry is supported.

Energy behavioral tests: `python -m unittest discover -s server/revex-energy-worker -p "test_*.py"`. Sixteen tests cover reference-only rows, supported overlap partition and rejection cases, bounded numerical clearance, volume reconciliation, native failure preservation, and the fixed nine-PDF archive with its geometry disclosure and embedded audit attachment.
