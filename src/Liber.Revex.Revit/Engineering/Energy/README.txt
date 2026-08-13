REVEX ENERGY PIPELINE 0.8.19 — build 20260812r33
================================================

One chain
---------
Revit evidence -> Universal gbXML >=80% hard-stop gate / >=95% quality target -> OpenStudio geometry OSM ->
GeometryCo 4.3.1 paired Baseline/Proposed compilation -> native
OpenStudio/EnergyPlus simulation -> Review Packager -> EN-1 workbook/PDF.

The native REVEX Engineering host owns weather resolution and starts the
pipeline automatically after an EXPORTED Engineering Sync. Companion Energy is
status/result only; it does not collect EPW, OpenStudio, code-standard,
applicant/modeler, signature, or seal inputs and has no second Run button.

Runtime requirements
--------------------
- Revit 2026 for the evidence/export stage.
- Project Weather file (.EPW). REVEX accepts an explicit native Engineering selection or REVEX_EPW; bounded project ENERGY/weather discovery is used only when it resolves exactly one valid EPW. The selected file remains changeable until SYNC ENGINEERING starts.
- OpenStudio Application 1.10 / SDK 3.10. The worker detects flat SDK installs
  and the common nested OpenStudioApplication*/openstudio-3.10*/bin layout.
- Python dependencies in requirements.txt; Excel or LibreOffice is used only for
  final EN-1 PDF calculation/export.

Approved behavior references
----------------------------
The approved 79 Winthrop Baseline/Proposed OSMs are behavior-preserving
templates. GeometryCo replaces spaces/surfaces/openings atomically while
protecting schedules, HVAC, loads, constructions, thermostats, controls, and
simulation setup. The approved EN-1 workbook is copied per run and filled with
current model results.

Authority / identity boundary
-----------------------------
The only Energy Sync writes to Revit are those performed by the Universal
exporter: verified MEP Spaces, retained EnergyAnalysisDetailModel, and
idempotent tags on standalone EN/ENERGY plan views. The downstream pipeline
never inserts PDFs, changes sheets/printing sets, or writes back to Revit.
Every EN-1 run copy clears applicant and lead-modeler values and leaves
signature/seal areas blank; REVEX does not collect or apply those values.

COMcheck boundary
-----------------
COMcheck_79_WINTHROP_APPROVED.pdf is bundled as reference evidence only. A run
may expose COMcheck_REFERENCE_79_WINTHROP_APPROVED.pdf with
projectComcheckFiling=false. REVEX never relabels that reference as another
project's filing document.

Failure behavior
----------------
Below-80% Revit evidence cannot enter this pipeline. Evidence from 80% through <95% can enter but carries a visible Companion quality warning. Later failures still write
energy-result.json and REVEX-ENERGY-PIPELINE.jsonl with correlation/parent run,
initiator, dependency snapshot, failed stage, process output tail, exception
chain, and traceback.


R31 PRODUCTION EXECUTION
The production Energy worker is server-only. Revit/REVEX publishes engineering-sync.json, the >=80% hard-stop gbXML evidence package (with >=95% quality target metadata), and one verified EPW. server/revex-energy-worker builds this folder into a pinned OpenStudio 3.10 container and runs this pipeline without accepting workstation executable/template/standard/identity inputs. LibreOffice is in the image for EN-1 PDF export. Local invocation remains source/debug capability only and is not called by the production REVEX UI.
