# REVEX Companion — Energy Engineering Pipeline

Status: implementation branch `revex-energy-pipeline`

## Boundary

Energy Engineering is a derived workflow attached to one authoritative REVEX source revision. It is intentionally separated from Design Book / Spec Book editing. It may read the synced BIM revision and its engineering export, but it may not rewrite designer-authored data or the central RVT.

## Inputs

Each energy run is pinned to one REVEX revision and records hashes for every input:

- REVEX project + central revision metadata
- Revit engineering geometry export (`gbXML` / equivalent geometry payload)
- synced model element/level/space identity required for validation
- approved Baseline OSM reference
- approved Proposed OSM reference
- weather file
- EN-1 master workbook
- COMcheck seed/configuration

The initial approved OSM behavior reference is the working 79 Winthrop pair. Their schedules, constructions, HVAC, program objects and other non-geometry data are protected. Geometry and space assignment are the controlled replacement layer.

## Pipeline

`sync revision -> engineering geometry -> geometry QA -> OSM geometry translation -> Baseline/Proposed template application -> OpenStudio load validation -> EnergyPlus Baseline + Proposed simulation -> report packager -> EN-1 processor -> COMcheck processor -> plan insertion manifest -> energy package -> project Record Out`

### 1. Initiator

Creates a run ID and immutable input manifest from the current REVEX revision. No run is allowed to silently switch to a newer Revit revision after initiation.

### 2. Analyzer

Checks engineering geometry against synced Revit evidence without rendering-heavy comprehension. It records missing/extra surfaces, abnormal cuts, opening/host inconsistencies, vertical extents, detached objects, and space coverage. The analyzer produces structured findings; it does not mutate the design model.

### 3. Translator

Converts valid engineering geometry to OpenStudio geometry while preserving stable source IDs where possible. Geometry may be decomposed only when required for OpenStudio/EnergyPlus compatibility and only with area/volume preservation checks.

### 4. Template compiler

Applies translated geometry to both approved references:

- Baseline template -> `BASELINE_UPDATED_GEOMETRY.osm`
- Proposed template -> `PROPOSED_UPDATED_GEOMETRY.osm`

Protected template layers include schedules, schedule references, constructions, loads, HVAC/plant, controls, weather/design-day configuration and all unrelated non-geometry objects. Any protected-layer change is a blocking integrity failure.

### 5. Evaluator

Loads both OSMs with the supported OpenStudio version and runs static model checks before simulation. Geometry identity, adjacency, dangling handles, schedule references and protected-object hashes are verified.

### 6. Simulation

Runs Baseline and Proposed through OpenStudio/EnergyPlus using the pinned weather file. Both runs are required for a complete energy package. All `.err`, `.end`, logs and generated model/report artifacts are retained.

### 7. Packager

Uses the existing EnergyPlus report packager behavior to generate concise review outputs while preserving the original EnergyPlus HTML reports.

### 8. EN-1 processor

Uses the latest approved 79 Winthrop Amendment EN-1 workbook as the form master. It preserves workbook/page structure and all unedited reference content, removes applicant-specific and prior-project edited values, then fills only fields supported by current run outputs/project metadata. Reference screenshots/description evidence are replaced with the current run references. Unsupported or ambiguous fields remain blank and are logged; they are never guessed.

Outputs include:

- completed EN-1 workbook
- printable EN-1 PDF/pages when the conversion worker is available
- page-1 filing data JSON for insertion into the Revit printing set
- EN-1 field provenance log

### 9. COMcheck processor

Uses the existing COMcheck processor/API work and known-loadable seed as a separate compliance-document generator. It does not alter OpenStudio or EN-1 calculations. It outputs the loadable project file, report pages when available, provenance and API/native-engine logs.

### 10. Plan inclusion

The final package contains `plan-insertions.json` describing EN-1 and COMcheck pages that belong in the current printing set. REVEX/Revit can consume this manifest to insert/update the corresponding energy sheets/pages without mixing engineering data into Design Book edits.

### 11. Maintenance/error policy

Every stage emits machine-readable events with severity, source object IDs, attempted repair, outcome and artifact hashes. Automatic repair is limited to deterministic engineering normalization that preserves architectural intent. Uncertain semantic changes are logged and left for review.

The workflow should complete whenever the model contains sufficient energy-domain geometry. Noncritical errors become warnings and remain visible in the lightweight user log. A run blocks only when continuing would create materially false geometry/results, violate protected template integrity, or make either Baseline/Proposed simulation invalid.

## Energy package

A successful run produces a single versioned package containing at minimum:

- `manifest.json`
- `engineering-input/` geometry + source revision metadata
- `osm/BASELINE_UPDATED_GEOMETRY.osm`
- `osm/PROPOSED_UPDATED_GEOMETRY.osm`
- `simulation/baseline/` OSM + EnergyPlus HTML + error/log files
- `simulation/proposed/` OSM + EnergyPlus HTML + error/log files
- `reports/` packager output
- `en1/` workbook, printable pages, provenance, Revit page-1 insertion data
- `comcheck/` project/report/provenance artifacts
- `plan-insertions.json`
- `logs/user.log` concise warnings/errors
- `logs/full.jsonl` complete machine-readable event stream
- `checksums.sha256`

The complete package is written to the project Record Out/energy area and registered in REVEX Companion under the source revision that produced it.

## Reference locks already recovered

- Working 79 Winthrop approved Baseline/Proposed OSMs use OpenStudio 3.10.0.
- Prior compiler QA proved geometry replacement can preserve all protected schedules and schedule references while replacing the geometry layer.
- Existing report packager is retained rather than rewritten.
- Latest 79 Winthrop Amendment EN-1 workbook/PDF is the form reference.
- Existing COMcheck API setup and known-loadable Midwood seed are retained as processor references.

No existing Design Book, Spec Book, BIM viewer, history, render or controlled-sync behavior is replaced by this pipeline.