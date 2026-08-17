#!/usr/bin/env python3
"""REVEX r118 managed-Energy guard.

Preserves the complete r116 durability/preflight execution contract and inserts one
narrow downstream step before the existing COMcheck preflight: current-project EN
geometry rows that lack thermal properties may inherit performance from the approved
79 Winthrop proposed envelope reference when current EN thermal facts corroborate the
same envelope signature.

r125 adds only final filing touch-ups on top of this established guard:
- native Revit schedule totals outrank arithmetic region re-sums;
- VT/VLT fallbacks are complete and explicit;
- compact COMcheck labels;
- template-preserving EN-1 publication.

No Revit, gbXML, GeometryCo, simulation, project identity or current geometry authority
is changed by this guard.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable
import json
import os
import sys
import zipfile

import revex_energy_pipeline_guard as base
import revex_energy_pipeline_guard_r116 as r116
import revex_reference_envelope_projection_r118 as reference_envelope

# r125 lives beside the pinned Energy implementation, which is already copied into the
# production worker image. Make it importable from this server-side guard subprocess.
_impl_hint = str(os.environ.get("REVEX_PIPELINE_IMPL") or "").strip()
if _impl_hint:
    _energy_root = Path(_impl_hint).resolve().parent
else:
    _packaged = Path("/opt/revex/energy")
    _energy_root = _packaged if _packaged.is_dir() else (
        Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
    )
if str(_energy_root) not in sys.path:
    sys.path.insert(0, str(_energy_root))

import revex_final_touchups_r125 as r125

_ORIGINAL_R116_EVIDENCE_RESOLVER = r116._resolve_comcheck_evidence_request

_ORIGINAL_R116_SUBPROCESS_RUN = r116.subprocess.run


def _install_full_pipeline_runner() -> None:
    """Route only r116's pinned full-pipeline subprocess through the r125 in-process patch runner."""
    if getattr(r116, "__revex_r125_subprocess_patched__", False):
        return
    runner = _energy_root / "revex_pipeline_runner_r125.py"
    if not runner.is_file():
        raise RuntimeError(f"REVEX r125 full pipeline runner is unavailable: {runner}")

    def run(command, *args, **kwargs):
        try:
            values = list(command)
        except TypeError:
            return _ORIGINAL_R116_SUBPROCESS_RUN(command, *args, **kwargs)
        if len(values) >= 2:
            try:
                target = Path(str(values[1])).resolve()
                pinned = base._pipeline_impl().resolve()
            except Exception:
                target = None
                pinned = None
            if target is not None and pinned is not None and target == pinned:
                values = [values[0], str(runner), "--impl", str(pinned), *values[2:]]
                print(json.dumps({
                    "stage": "FULL_PIPELINE_R125",
                    "status": "PATCHED_RUNNER",
                    "runner": str(runner),
                    "impl": str(pinned),
                }, ensure_ascii=True), flush=True)
                return _ORIGINAL_R116_SUBPROCESS_RUN(values, *args, **kwargs)
        return _ORIGINAL_R116_SUBPROCESS_RUN(command, *args, **kwargs)

    r116.subprocess.run = run
    r116.__revex_r125_subprocess_patched__ = True


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
    projected = reference_envelope.resolve_request(current, output_root)
    # r125 derives only publication facts. It never edits the immutable Engineering
    # source: native schedule total is attached as authority metadata and missing VT
    # receives approved-reference/code fallback in a derived page-facts copy.
    return r125.apply_request_touchups(projected, output_root, reference_envelope)


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
    # r116 looks these functions up from its module globals at execution time.
    r116._resolve_comcheck_evidence_request = _resolve_comcheck_evidence_then_reference
    r116.PREFLIGHT_NAME = "COMCHECK_PREFLIGHT_R118.json"
    # Patch each dynamically loaded r49 module before the preflight and route the full
    # pinned implementation through the same r125 patch layer.
    r125.install_guard_touchups(r116, reference_envelope)
    _install_full_pipeline_runner()
    base.EXACT_NAMES.update({
        "REFERENCE_ENVELOPE_PROJECTION_R118.json",
        "00_PAGE_FACTS_REFERENCE_ENVELOPE_R118.json",
        "00_PIPELINE_REQUEST_REFERENCE_ENVELOPE_R118.json",
        "COMCHECK_PREFLIGHT_R118.json",
        PACKAGE_MANIFEST_NAME,
        "ENERGY_FINAL_TOUCHUPS_R125.json",
        "00_PAGE_FACTS_FINAL_TOUCHUPS_R125.json",
        "00_PIPELINE_REQUEST_FINAL_TOUCHUPS_R125.json",
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
