#!/usr/bin/env python3
"""REVEX r118 managed-Energy guard.

Preserves the complete r116 durability/preflight execution contract and inserts one
narrow downstream step before the existing COMcheck preflight: current-project EN
geometry rows that lack thermal properties may inherit performance from the approved
79 Winthrop proposed envelope reference when current EN thermal facts corroborate the
same envelope signature.

No Revit, gbXML, GeometryCo, simulation, project identity or current geometry authority
is changed by this guard.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable
import json
import sys
import zipfile

import revex_energy_pipeline_guard as base
import revex_energy_pipeline_guard_r116 as r116
import revex_reference_envelope_projection_r118 as reference_envelope

_ORIGINAL_R116_EVIDENCE_RESOLVER = r116._resolve_comcheck_evidence_request


def _osm_fields_without_comments(block: str) -> list[str]:
    fields: list[str] = []
    for raw in block.splitlines():
        value = raw.split("!-", 1)[0].strip()
        if value:
            fields.append(value.rstrip(",;").strip())
    return fields


def _exact_thermal_match_only(geometry: dict, thermal_rows: list[dict]) -> bool:
    kind = str(geometry.get("kind") or "").strip().lower()
    code = reference_envelope._row_code(geometry)[0]
    return bool(code) and any(
        str(row.get("kind") or "").strip().lower() == kind
        and reference_envelope._row_code(row)[0] == code
        for row in thermal_rows
    )


def _resolve_comcheck_evidence_then_reference(request_path: Path, output_root: Path) -> Path:
    current = _ORIGINAL_R116_EVIDENCE_RESOLVER(request_path, output_root)
    # OpenStudio serializes values as `value, !- Field Name`. The approved OSM is
    # authoritative; comments are not field data. Also fill only an exact missing EN tag
    # (G11.3 must not be hidden because G11.1 happens to have a thermal row).
    reference_envelope._osm_fields = _osm_fields_without_comments
    reference_envelope._has_existing_match = _exact_thermal_match_only
    return reference_envelope.resolve_request(current, output_root)


PACKAGE_NAME = "REVEX_RECOVERY_PACKAGE.zip"
PACKAGE_MANIFEST_NAME = "REVEX_RECOVERY_PACKAGE_MANIFEST.json"


def _request_path_from_argv(argv: Iterable[str] | None) -> Path | None:
    values = list(argv) if argv is not None else list(sys.argv[1:])
    for index, value in enumerate(values):
        if value == "--request" and index + 1 < len(values):
            return Path(values[index + 1]).resolve()
    return None


def _ensure_recovery_package(request_path: Path) -> Path:
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    output_root = Path(str(request.get("outputFolder") or "")).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    result_path = output_root / "energy-result.json"
    if result_path.is_file():
        result = json.loads(result_path.read_text(encoding="utf-8"))
    else:
        result = base.fallback_result(request, output_root, 2)

    required = {
        "BASELINE_UPDATED_GEOMETRY.osm", "PROPOSED_UPDATED_GEOMETRY.osm",
        "EN-1_READY_TO_INSERT.xlsx", "COMcheck_PROJECT_INPUT_READY.cxl",
        "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf", "COMcheck_BACKSTOP_RESULT.json",
    }
    present = {path.name for path in output_root.rglob("*") if path.is_file()}
    allowed_suffixes = {".osm", ".html", ".xlsx", ".pdf", ".cxl", ".json", ".txt", ".log", ".zip", ".err"}
    candidates: list[Path] = []
    for path in sorted(output_root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if not path.is_file() or path.name in {PACKAGE_NAME, PACKAGE_MANIFEST_NAME, "energy-result.json"}:
            continue
        if path.suffix.lower() in allowed_suffixes or path.name.startswith(("NATIVE_CHECK_", "SPACE_MAPPING_REVIEW_")):
            candidates.append(path)

    guarantee = {
        "schema": "liber.revex.energy-recovery-package.v1",
        "sourceEngineeringRevision": request.get("revision"),
        "pipelineStatus": str(result.get("status") or "UNKNOWN").upper(),
        "strictComplete": str(result.get("status") or "").upper() == "COMPLETE",
        "requiredStrictOutputsPresent": sorted(required & present),
        "requiredStrictOutputsMissing": sorted(required - present),
        "included": [path.resolve().relative_to(output_root).as_posix() for path in candidates],
        "policy": "ALWAYS_EMIT_PACKAGE; STRICT_COMPLETE_STATUS_REMAINS_UNCHANGED",
    }
    result["packageGuarantee"] = guarantee
    result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    manifest_path = output_root / PACKAGE_MANIFEST_NAME
    manifest_path.write_text(json.dumps(guarantee, ensure_ascii=True, indent=2), encoding="utf-8")

    package_path = output_root / PACKAGE_NAME
    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in candidates + [manifest_path, result_path]:
            archive.write(path, path.resolve().relative_to(output_root).as_posix())

    row = {
        "name": PACKAGE_NAME, "reviewName": "REVEX Energy Package",
        "path": PACKAGE_NAME, "kind": "recovery-package", "userVisible": True,
        "bytes": package_path.stat().st_size, "sha256": base.sha256(package_path),
    }
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["artifacts"] = [item for item in list(result.get("artifacts") or []) if str(item.get("name") or "") != PACKAGE_NAME] + [row]
    result["packageGuarantee"] = guarantee
    result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "PACKAGE_GUARANTEE_R123", "status": "EMITTED",
        "package": PACKAGE_NAME, "pipelineStatus": guarantee["pipelineStatus"],
        "strictComplete": guarantee["strictComplete"], "includedFiles": len(candidates),
        "missingStrictOutputs": guarantee["requiredStrictOutputsMissing"],
    }, ensure_ascii=True), flush=True)
    return package_path


def main(argv: Iterable[str] | None = None) -> int:
    # r116 looks this function up from its module globals at execution time. Replace only
    # that one downstream seam; every other r116 operation stays intact.
    r116._resolve_comcheck_evidence_request = _resolve_comcheck_evidence_then_reference
    r116.PREFLIGHT_NAME = "COMCHECK_PREFLIGHT_R118.json"
    base.EXACT_NAMES.update({
        "REFERENCE_ENVELOPE_PROJECTION_R118.json",
        "00_PAGE_FACTS_REFERENCE_ENVELOPE_R118.json",
        "00_PIPELINE_REQUEST_REFERENCE_ENVELOPE_R118.json",
        "COMCHECK_PREFLIGHT_R118.json",
        PACKAGE_MANIFEST_NAME,
    })
    request_path = _request_path_from_argv(argv)
    try:
        code = r116.main(argv)
    except Exception as exc:
        if request_path is None:
            raise
        request = json.loads(request_path.read_text(encoding="utf-8"))
        output_root = Path(str(request.get("outputFolder") or "")).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        result = base.fallback_result(request, output_root, 2)
        result["error"] = f"REVEX recovery boundary caught {type(exc).__name__}: {exc}"
        result["failureContext"] = {"failedStage": "RECOVERY_BOUNDARY_R123", "type": type(exc).__name__, "message": str(exc)}
        (output_root / "energy-result.json").write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
        code = 2
    if request_path is not None:
        _ensure_recovery_package(request_path)
    return int(code)


if __name__ == "__main__":
    raise SystemExit(main())
