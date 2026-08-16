#!/usr/bin/env python3
"""REVEX managed-Energy execution guard.

Runs the pinned r49 pipeline unchanged, then promotes only failure diagnostics into
its normal artifact contract when the run does not complete.

Current evidence order:
1. revision-scoped explicit user identity fills only missing identity fields;
2. content-aware identity separation + deterministic r69 normalization;
3. explicit identity is projected once more at the exact identity boundary;
4. r101 reconciles native Revit schedules captured in the same immutable Engineering
   revision as gbXML. Resolved schedule facts outrank page scanning. Conflicting current
   schedule facts are removed from the derived request and block PDF recovery so the
   pinned pipeline fails visibly rather than choosing one silently;
5. r100 recovers only still-missing COMcheck facts from immutable T/Z/EN PDFs;
6. pinned r49 remains the final GeometryCo / EnergyPlus / CXL / EN-1 implementation.

Source Engineering evidence is never mutated.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterable

PIPELINE_VERSION = "0.8.19-r49"
SCHEMA = "liber.revex.energy-result.v1"
MAX_DIAGNOSTIC_FILES = 64
MAX_DIAGNOSTIC_BYTES = 24 * 1024 * 1024

EXACT_NAMES = {
    "REVEX-ENERGY-PIPELINE.jsonl",
    "01_GBXML_TO_OSM.log",
    "02_GEOMETRYCO.log",
    "COMPILATION_AUDIT.json",
    "INTERIM_COMPILATION_REPORT.json",
    "VALIDATION_SUMMARY.txt",
    "FAILURE_REPORT.json",
    "FAILURE_SUMMARY.txt",
    "COMcheck_INPUT_AUDIT.json",
    "COMcheck_BACKSTOP_RESULT.json",
    "COMcheck_BACKSTOP_RESPONSE.txt",
    "REVEX_OPENSTUDIO_RUN.log",
    "eplusout.err",
    "00_PAGE_FACTS_USER_IDENTITY_R89.json",
    "00_PIPELINE_REQUEST_USER_IDENTITY_R89.json",
    "PROJECT_IDENTITY_USER_OVERRIDE_R89.json",
    "EN-1_PRINT_AUDIT.json",
    "00_PAGE_FACTS_CONTENT_IDENTITY_R88.json",
    "00_PIPELINE_REQUEST_CONTENT_IDENTITY_R88.json",
    "PROJECT_IDENTITY_CONTENT_AGENT_R88.json",
    "00_PAGE_FACTS_RESOLVED_R69.json",
    "00_PIPELINE_REQUEST_RESOLVED_R69.json",
    "00_PAGE_FACTS_STRUCTURED_SCHEDULE_R101.json",
    "00_PIPELINE_REQUEST_STRUCTURED_SCHEDULE_R101.json",
    "STRUCTURED_SCHEDULE_PROJECTION_R101.json",
    "00_PAGE_FACTS_COMCHECK_EVIDENCE_R100.json",
    "00_PIPELINE_REQUEST_COMCHECK_EVIDENCE_R100.json",
    "COMCHECK_EVIDENCE_RESOLUTION_R100.json",
}
PREFIXES = (
    "NATIVE_CHECK_",
    "SPACE_MAPPING_REVIEW_",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _relative(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _is_failure_evidence(path: Path, root: Path) -> bool:
    if not path.is_file():
        return False
    if path.name in {"energy-result.json", "REVEX-SERVER-WORKER.log"}:
        return False
    try:
        rel = _relative(path, root)
    except ValueError:
        return False
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_DIAGNOSTIC_BYTES:
        return False
    if path.name in EXACT_NAMES or path.name.startswith(PREFIXES):
        return True
    if "/FAILED_COMPILE_" in f"/{rel}" and path.suffix.lower() in {".json", ".txt", ".log"}:
        return True
    if rel.startswith("03_SIMULATION/") and path.name in {"REVEX_OPENSTUDIO_RUN.log", "eplusout.err"}:
        return True
    return False


def collect_failure_artifacts(output_root: Path) -> list[dict]:
    if not output_root.is_dir():
        return []
    selected = [path for path in output_root.rglob("*") if _is_failure_evidence(path, output_root)]
    selected.sort(key=lambda p: (_relative(p, output_root).count("/"), _relative(p, output_root).lower()))
    artifacts: list[dict] = []
    for path in selected[:MAX_DIAGNOSTIC_FILES]:
        rel = _relative(path, output_root)
        artifacts.append({
            "name": path.name,
            "path": rel,
            "kind": "diagnostic",
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
    return artifacts


def promote_failure_evidence(result: dict, output_root: Path) -> dict:
    status = str(result.get("status") or "").upper()
    if status == "COMPLETE":
        return result
    diagnostics = collect_failure_artifacts(output_root)
    existing = list(result.get("artifacts") or [])
    by_path = {str(row.get("path") or ""): row for row in existing if str(row.get("path") or "")}
    for row in diagnostics:
        by_path.setdefault(row["path"], row)
    result["artifacts"] = list(by_path.values())
    result["failureEvidence"] = {
        "schema": "liber.revex.energy-failure-evidence.v1",
        "preserved": True,
        "artifactCount": len(diagnostics),
        "artifacts": [row["path"] for row in diagnostics],
        "note": "Failure evidence is immutable run output only; no failed Energy result is promoted to COMPLETE.",
    }
    return result


def fallback_result(request: dict, output_root: Path, returncode: int) -> dict:
    finished = dt.datetime.now(dt.timezone.utc)
    error = f"Energy pipeline exited {returncode} without writing energy-result.json. Preserved diagnostics are attached."
    result = {
        "schema": SCHEMA,
        "pipelineVersion": PIPELINE_VERSION,
        "correlationId": str(request.get("correlationId") or ""),
        "parentCorrelationId": request.get("parentCorrelationId"),
        "initiator": str(request.get("initiator") or "REVEX managed Energy guard"),
        "projectId": request.get("projectId"),
        "projectName": request.get("projectName") or "Current REVEX Project",
        "sourceEngineeringRevision": request.get("revision"),
        "resultRevision": "energy_failed_" + finished.strftime("%Y%m%dT%H%M%SZ"),
        "status": "FAILED",
        "finishedAt": finished.isoformat(),
        "error": error,
        "failureContext": {
            "failedStage": "PIPELINE_PROCESS",
            "type": "PipelineProcessFailure",
            "message": error,
            "returnCode": returncode,
        },
        "artifacts": [],
        "debugArtifacts": [],
        "publicationQa": False,
        "comcheck": {"status": "NOT_RUN", "officialDoeReport": None, "officialDoeReportStatus": "NOT_RUN"},
        "revitWriteBack": False,
        "pdfInsertion": False,
        "authorityBoundary": "No failed managed-Energy run writes back to Revit.",
    }
    return promote_failure_evidence(result, output_root)


def _pipeline_impl() -> Path:
    configured = str(os.environ.get("REVEX_PIPELINE_IMPL") or "").strip()
    if configured:
        return Path(configured).resolve()
    installed = Path("/opt/revex/energy/revex_energy_pipeline.py")
    if installed.is_file():
        return installed
    return (Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy/revex_energy_pipeline.py").resolve()


def _resolve_user_identity_request(request_path: Path, output_root: Path) -> Path:
    import revex_user_identity_en1 as user_identity
    return user_identity.resolve_request(request_path, output_root)


def _resolve_content_identity_request(request_path: Path, output_root: Path) -> Path:
    try:
        import revex_identity_content_agent as content_identity
        return content_identity.resolve_request(request_path, output_root)
    except Exception as exc:
        print(json.dumps({
            "stage": "PROJECT_IDENTITY_CONTENT_AGENT",
            "status": "UNRESOLVED",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path


def _resolve_r69_request(request_path: Path, output_root: Path) -> Path:
    try:
        import revex_energy_pipeline_r69 as resolver
        return resolver._resolved_request(request_path, output_root)
    except Exception as exc:
        print(json.dumps({
            "stage": "PROJECT_IDENTITY_R69",
            "status": "UNRESOLVED",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path


def _resolve_structured_schedule_request(request_path: Path, output_root: Path) -> Path:
    try:
        import revex_structured_schedule_projection as resolver
        return resolver.resolve_request(request_path, output_root)
    except Exception as exc:
        print(json.dumps({
            "stage": "STRUCTURED_SCHEDULE_R101",
            "status": "UNRESOLVED",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path


def _structured_schedule_conflicts(request_path: Path) -> list[str]:
    try:
        request = json.loads(Path(request_path).read_text(encoding="utf-8"))
        return [str(value) for value in list((request.get("structuredScheduleProjection") or {}).get("conflicts") or [])]
    except Exception:
        return []


def _resolve_comcheck_evidence_request(request_path: Path, output_root: Path) -> Path:
    try:
        import revex_comcheck_evidence as resolver
        return resolver.resolve_request(request_path, output_root)
    except Exception as exc:
        # This resolver never masks the pinned r49 failure. If bounded recovery cannot prove
        # the missing T/Z/EN facts, the original/partially-derived request proceeds and r49
        # reports the exact remaining COMcheck dependency as before.
        print(json.dumps({
            "stage": "COMCHECK_EVIDENCE_R100",
            "status": "UNRESOLVED",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path


def _finalize_complete_result(request_path: Path, result: dict, output_root: Path) -> dict:
    import revex_user_identity_en1 as user_identity
    return user_identity.finalize_complete_result(request_path, result, output_root)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    args, passthrough = parser.parse_known_args(list(argv) if argv is not None else None)
    request_path = args.request.resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output_root = Path(str(request.get("outputFolder") or "")).resolve()
    if not output_root:
        raise RuntimeError("REVEX Energy request has no outputFolder.")
    output_root.mkdir(parents=True, exist_ok=True)

    impl = _pipeline_impl()
    if not impl.is_file() or impl.resolve() == Path(__file__).resolve():
        raise RuntimeError(f"Pinned REVEX Energy implementation is unavailable: {impl}")

    effective_request = _resolve_user_identity_request(request_path, output_root)
    effective_request = _resolve_content_identity_request(effective_request, output_root)
    effective_request = _resolve_r69_request(effective_request, output_root)
    effective_request = _resolve_user_identity_request(effective_request, output_root)

    # r101: current native Revit schedule facts precede PDF recovery. If two valid
    # current-revision schedules disagree on the same typed fact, keep that fact absent
    # and skip r100 so no PDF/OCR fallback can silently choose one side of the conflict.
    effective_request = _resolve_structured_schedule_request(effective_request, output_root)
    structured_conflicts = _structured_schedule_conflicts(effective_request)
    if structured_conflicts:
        print(json.dumps({
            "stage": "STRUCTURED_SCHEDULE_R101",
            "status": "HARD_CONFLICT",
            "conflicts": structured_conflicts,
            "pdfFallbackSkipped": True,
        }, ensure_ascii=True), flush=True)
    else:
        effective_request = _resolve_comcheck_evidence_request(effective_request, output_root)

    command = [sys.executable, str(impl), "--request", str(effective_request), *passthrough]
    completed = subprocess.run(command, cwd=str(impl.parent), env=os.environ.copy())
    result_path = output_root / "energy-result.json"
    if result_path.is_file():
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if result.get("schema") != SCHEMA:
            raise RuntimeError("Pinned Energy pipeline wrote an incompatible energy-result.json schema.")
        if str(result.get("pipelineVersion") or "") != PIPELINE_VERSION:
            raise RuntimeError("Pinned Energy pipeline wrote an unexpected pipeline version.")
        if str(result.get("status") or "").upper() == "COMPLETE":
            try:
                result = _finalize_complete_result(effective_request, result, output_root)
                result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
            except Exception as exc:
                error = f"EN-1/user-output finalization failed: {type(exc).__name__}: {exc}"
                result["status"] = "FAILED"
                result["error"] = error
                result["failureContext"] = {
                    "failedStage": "FINALIZE_USER_IDENTITY_EN1",
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
                result = promote_failure_evidence(result, output_root)
                result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
                completed = subprocess.CompletedProcess(command, 2)
        else:
            result = promote_failure_evidence(result, output_root)
            result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    else:
        result = fallback_result(request, output_root, int(completed.returncode or 1))
        result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")

    return int(completed.returncode or (0 if str(result.get("status") or "").upper() == "COMPLETE" else 2))


if __name__ == "__main__":
    raise SystemExit(main())
