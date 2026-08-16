# REVEX r89 acceptance contract

This revision repairs the managed Energy dependency graph without regenerating Revit evidence.

- Active-Revit T/Z identity remains authoritative.
- Explicit project identity entered during revision-scoped authorization may fill missing project fields only and may not overwrite an established Revit/T/Z value.
- Applicant and lead-modeler identity are revision-scoped EN-1 inputs only and are not transmitted to COMcheck.
- Identity resolution order is explicit missing-only fallback -> content-aware project/party consensus -> deterministic normalization/geocode -> pinned r49 pipeline.
- A COMPLETE run is finalized to an EN-1 workbook plus a validated 16-page EN-1 PDF using a disposable fit-to-page print copy; source workbook visibility/layout is not rewritten for printing.
- Clean user-facing Energy output is exactly nine files: GEOMETRY.osm, BASELINE.osm, PROPOSED.osm, BASELINE_REPORT.html, PROPOSED_REPORT.html, EN-1.xlsx, EN-1.pdf, COMcheck_BACKSTOP.pdf, PACKAGER_REPORTS.zip.
- CXL and engine/result JSON remain immutable internal integrity evidence and are hidden from the clean output list.
- Historical failed-result evidence must not be emitted as a new current-run error on Energy page load. A new exact failure requires the current replay to return BROKER_FAILED.
- No renderer change and no Revit rerun are part of this recovery.
