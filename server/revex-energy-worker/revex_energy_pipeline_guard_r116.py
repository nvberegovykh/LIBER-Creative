#!/usr/bin/env python3
"""REVEX r116 managed-Energy guard.

This is an execution envelope around the preserved r49 Energy implementation.
It adds only:
- corrected current-project COMcheck evidence fallback;
- exact r49 CXL preflight before GeometryCo/EnergyPlus;
- explicit terminal failure evidence when filing input is incomplete.

GeometryCo, both OpenStudio/EnergyPlus runs, official COMcheck execution, EN-1,
and the strict final package remain owned by the pinned r49 implementation.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Iterable

import revex_energy_pipeline_guard as base

PIPELINE_VERSION = base.PIPELINE_VERSION
SCHEMA = base.SCHEMA
PREFLIGHT_NAME = "COMCHECK_PREFLIGHT_R116.json"


def _resolve_comcheck_evidence_request(request_path: Path, output_root: Path) -> Path:
    try:
        import revex_comcheck_evidence_r116 as resolver
        return resolver.resolve_request(request_path, output_root)
    except Exception as exc:
        print(json.dumps({
            "stage": "COMCHECK_EVIDENCE_R116",
            "status": "UNRESOLVED",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path


def _load_pipeline_module(impl: Path):
    parent = str(impl.parent)
    inserted = parent not in sys.path
    if inserted:
        sys.path.insert(0, parent)
    try:
        spec = importlib.util.spec_from_file_location("revex_r49_preflight_impl", impl)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Cannot load pinned Energy implementation for COMcheck preflight: {impl}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if inserted:
            try:
                sys.path.remove(parent)
            except ValueError:
                pass


def _comcheck_preflight(request_path: Path, output_root: Path, impl: Path) -> dict:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(str(request.get("pageFactsPath") or ""))
    pipeline = _load_pipeline_module(impl)
    facts = pipeline.load_page_facts(page_path)
    identity = pipeline.current_project_identity(facts)
    folder = output_root / "00_COMCHECK_PREFLIGHT_R116"
    folder.mkdir(parents=True, exist_ok=True)
    log = pipeline.RunLog(
        folder,
        str(request.get("correlationId") or "r116-preflight"),
        "REVEX r116 pre-simulation COMcheck input gate",
    )

    cxl = None
    audit: dict = {"status": "NOT_RUN", "missing": []}
    error = ""
    try:
        cxl, audit_pdf, audit = pipeline.prepare_project_comcheck(facts, identity, folder, log)
        _ = audit_pdf
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        audit = {"status": "FAILED", "missing": [error]}

    identity_missing = list(identity.get("missing") or [])
    missing = list(audit.get("missing") or [])
    if identity_missing:
        status = "BLOCKED_PROJECT_IDENTITY"
        missing = [f"project identity: {name}" for name in identity_missing] + missing
    elif not cxl:
        status = "BLOCKED_COMCHECK_INPUT"
    else:
        status = "PASSED"

    record = {
        "schema": "liber.revex.comcheck-preflight.v1",
        "version": "20260817r116",
        "sourceEngineeringRevision": str(request.get("revision") or ""),
        "status": status,
        "missing": missing,
        "error": error or None,
        "projectIdentityMissing": identity_missing,
        "comcheckAudit": audit,
        "cxlPrepared": bool(cxl),
        "cxl": cxl.name if cxl else None,
        "executionPolicy": "MUST_PASS_BEFORE_GEOMETRYCO_AND_ENERGYPLUS",
        "sourceEvidenceMutated": False,
    }
    path = output_root / PREFLIGHT_NAME
    path.write_text(json.dumps(record, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "COMCHECK_PREFLIGHT_R116",
        "status": status,
        "missing": missing,
        "cxlPrepared": bool(cxl),
    }, ensure_ascii=True), flush=True)
    return record


def _blocked_result(request: dict, output_root: Path, preflight: dict) -> dict:
    finished = dt.datetime.now(dt.timezone.utc)
    status = str(preflight.get("status") or "BLOCKED_COMCHECK_INPUT")
    missing = [str(value) for value in list(preflight.get("missing") or [])]
    message = (
        "Current immutable Revit evidence is not sufficient for the filing-grade COMcheck input"
        + (": " + "; ".join(missing) if missing else ".")
    )
    result = {
        "schema": SCHEMA,
        "pipelineVersion": PIPELINE_VERSION,
        "correlationId": str(request.get("correlationId") or ""),
        "parentCorrelationId": request.get("parentCorrelationId"),
        "initiator": str(request.get("initiator") or "REVEX r116 COMcheck preflight"),
        "projectId": request.get("projectId"),
        "projectName": request.get("projectName") or "Current REVEX Project",
        "sourceEngineeringRevision": request.get("revision"),
        "resultRevision": "energy_blocked_" + finished.strftime("%Y%m%dT%H%M%SZ"),
        "status": status,
        "finishedAt": finished.isoformat(),
        "error": message,
        "failureContext": {
            "failedStage": "COMCHECK_PREFLIGHT_R116",
            "type": "PipelineBlocked",
            "message": message,
            "missing": missing,
        },
        "artifacts": [],
        "debugArtifacts": [],
        "publicationQa": False,
        "comcheck": {
            "status": status,
            "projectInputReady": False,
            "missing": missing,
            "officialDoeReport": None,
            "officialDoeReportStatus": "NOT_RUN",
        },
        "revitWriteBack": False,
        "pdfInsertion": False,
        "authorityBoundary": "Preflight failure never writes back to Revit and never launches simulations.",
    }
    base.EXACT_NAMES.add(PREFLIGHT_NAME)
    return base.promote_failure_evidence(result, output_root)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    args, passthrough = parser.parse_known_args(list(argv) if argv is not None else None)
    request_path = args.request.resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output_root = Path(str(request.get("outputFolder") or "")).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    impl = base._pipeline_impl()
    if not impl.is_file() or impl.resolve() == Path(__file__).resolve():
        raise RuntimeError(f"Pinned REVEX Energy implementation is unavailable: {impl}")

    # Preserve the established evidence authority chain exactly through the point
    # where all current-project filing facts have been reconciled.
    effective_request = base._resolve_user_identity_request(request_path, output_root)
    effective_request = base._resolve_content_identity_request(effective_request, output_root)
    effective_request = base._resolve_r69_request(effective_request, output_root)
    effective_request = base._resolve_user_identity_request(effective_request, output_root)
    effective_request = base._resolve_structured_schedule_request(effective_request, output_root)
    structured_conflicts = base._structured_schedule_conflicts(effective_request)
    if structured_conflicts:
        print(json.dumps({
            "stage": "STRUCTURED_SCHEDULE_R101",
            "status": "HARD_CONFLICT",
            "conflicts": structured_conflicts,
            "pdfFallbackSkipped": True,
        }, ensure_ascii=True), flush=True)
    else:
        effective_request = _resolve_comcheck_evidence_request(effective_request, output_root)

    # The actual r49 COMcheck CXL builder is the preflight authority. If it cannot
    # create a current-project CXL now, do not spend 20-30 minutes on simulations.
    preflight = _comcheck_preflight(effective_request, output_root, impl)
    if str(preflight.get("status") or "") != "PASSED":
        result = _blocked_result(request, output_root, preflight)
        (output_root / "energy-result.json").write_text(
            json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8"
        )
        return 2

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
                result = base._finalize_complete_result(effective_request, result, output_root)
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
                result = base.promote_failure_evidence(result, output_root)
                result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
                completed = subprocess.CompletedProcess(command, 2)
        else:
            result = base.promote_failure_evidence(result, output_root)
            result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    else:
        result = base.fallback_result(request, output_root, int(completed.returncode or 1))
        result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")

    return int(completed.returncode or (0 if str(result.get("status") or "").upper() == "COMPLETE" else 2))


if __name__ == "__main__":
    raise SystemExit(main())
