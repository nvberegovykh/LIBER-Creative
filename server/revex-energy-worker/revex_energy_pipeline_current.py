#!/usr/bin/env python3
"""Canonical managed Energy pipeline facade.

Versioned guards remain preserved as shadows. This file is the only active managed-pipeline
entrypoint and binds typed evidence, current VT policy, the proven simulation/filing engine,
one verified user-facing release package, and the active WALLT repair controller.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import zipfile

import revex_energy_pipeline_guard as base
import revex_energy_pipeline_guard_r116 as r116
import revex_energy_pipeline_guard_r118 as shadow
import revex_user_identity_en1 as en1

_impl_hint = str(os.environ.get("REVEX_PIPELINE_IMPL") or "").strip()
if _impl_hint:
    _energy_root = Path(_impl_hint).resolve().parent
else:
    packaged = Path("/opt/revex/energy")
    _energy_root = packaged if packaged.is_dir() else Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
if str(_energy_root) not in sys.path:
    sys.path.insert(0, str(_energy_root))

import revex_final_touchups as current_touchups
import revex_energy_agent as maintainer
from revex_energy_contracts import FilingPackage

shadow.r125 = current_touchups
CURRENT_RELEASE_PACKAGE = "REVEX_ENERGY_RELEASE_PACKAGE.zip"
MANUAL_PACKAGE = "REVEX_ENERGY_MANUAL_REVIEW_PACKAGE.zip"
RECOVERY_PACKAGE = "REVEX_RECOVERY_PACKAGE.zip"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _request_path(argv=None) -> Path | None:
    values = list(argv) if argv is not None else list(sys.argv[1:])
    for index, value in enumerate(values):
        if value == "--request" and index + 1 < len(values):
            return Path(values[index + 1]).resolve()
    return None


def _request_output_root(request_path: Path, request: dict) -> Path:
    raw = str(request.get("outputFolder") or "").strip()
    if raw:
        return Path(raw).resolve()
    parent = Path(request_path).resolve().parent
    return parent.parent if parent.name.lower() in {"work", "_input", "input"} else parent


def _attach_maintainer_state(output_root: Path, result: dict) -> dict:
    """Expose WALLT state/repair requests without changing immutable source authority."""
    state_path = output_root / maintainer.STATE_NAME
    events_path = output_root / maintainer.EVENTS_NAME
    repair_path = output_root / getattr(maintainer, "REPAIR_REQUEST_NAME", "REVEX_ENERGY_REVIT_REPAIR_REQUEST.json")
    state = None
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            state = None
    if state is not None:
        result["maintainer"] = state

    rows = [dict(row) for row in list(result.get("artifacts") or [])]
    existing = {str(row.get("name") or "") for row in rows}
    for path, kind, visible, review_name in (
        (state_path, "maintainer-state", True, "WALLT Energy Controller State"),
        (repair_path, "revit-repair-request", True, "WALLT Revit Repair Request"),
        (events_path, "maintainer-events", False, "WALLT Energy Controller Event Trace"),
    ):
        if not path.is_file() or path.name in existing:
            continue
        rows.append({
            "name": path.name,
            "reviewName": review_name,
            "path": path.name,
            "kind": kind,
            "userVisible": visible,
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        })
    result["artifacts"] = rows
    return result


def _install_current_full_pipeline_runner() -> None:
    if getattr(r116, "__revex_current_subprocess_patched__", False):
        return
    runner = _energy_root / "revex_pipeline_runner.py"
    if not runner.is_file():
        raise RuntimeError(f"REVEX current full pipeline runner is unavailable: {runner}")
    original_run = shadow._ORIGINAL_R116_SUBPROCESS_RUN

    def run(command, *args, **kwargs):
        try:
            values = list(command)
        except TypeError:
            return original_run(command, *args, **kwargs)
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
                    "stage": "FULL_PIPELINE_CURRENT",
                    "status": "CANONICAL_RUNNER",
                    "runner": str(runner),
                    "impl": str(pinned),
                    "controller": "WALLT_ACTIVE_REPAIR",
                }, ensure_ascii=True), flush=True)
                return original_run(values, *args, **kwargs)
        return original_run(command, *args, **kwargs)

    r116.subprocess.run = run
    r116.__revex_current_subprocess_patched__ = True


shadow._install_full_pipeline_runner = _install_current_full_pipeline_runner


def _verify_clean_zip(path: Path) -> None:
    expected = set(en1.PUBLIC_REVIEW_NAMES)
    with zipfile.ZipFile(path) as archive:
        entries = [name for name in archive.namelist() if not name.endswith("/")]
    if len(entries) != 9 or len(set(entries)) != 9 or set(entries) != expected:
        raise RuntimeError("clean Energy release ZIP does not match the exact nine-file filing/review contract")


def _review_models(output_root: Path, artifact_rows: list[dict] | None = None) -> list[dict]:
    rows = []
    artifacts = [dict(row) for row in list(artifact_rows or [])]
    for name, role in (("GEOMETRY.osm", "current-geometry"), ("BASELINE.osm", "baseline"), ("PROPOSED.osm", "proposed")):
        path = output_root / name
        if path.is_file():
            rows.append({
                "name": name, "role": role, "path": name, "viewer": "osm-3d",
                "rotatable": True, "bytes": path.stat().st_size, "sha256": _sha256(path),
            })
            continue
        # Full-pipeline review names are archive aliases over the real declared artifact path.
        # Expose the real path/hash so Companion can fetch and rotate the OSM directly without
        # manufacturing a second copy or depending on the ZIP container.
        row = next((item for item in artifacts
                    if str(item.get("reviewName") or "") == name
                    or str(item.get("name") or "") == name), None)
        if row is None:
            continue
        rows.append({
            "name": name, "role": role, "path": row.get("path"), "viewer": "osm-3d",
            "rotatable": True, "bytes": row.get("bytes"), "sha256": row.get("sha256"),
            "artifactName": row.get("name"),
        })
    return rows


def _promote_clean_release_package(request_path: Path, code: int) -> int:
    """A COMPLETE run exposes one verified package and a final WALLT approval surface."""
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    output_root = _request_output_root(Path(request_path), request)
    result_path = output_root / "energy-result.json"
    if not result_path.is_file():
        return int(code or 2)
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result = _attach_maintainer_state(output_root, result)
    if str(result.get("status") or "").upper() != "COMPLETE":
        result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
        return int(code or 2)

    try:
        manual = output_root / MANUAL_PACKAGE
        release = output_root / CURRENT_RELEASE_PACKAGE
        if manual.is_file():
            _verify_clean_zip(manual)
            shutil.copy2(manual, release)
            if _sha256(manual) != _sha256(release):
                raise RuntimeError("canonical release package bytes differ from the verified clean source package")
        elif release.is_file():
            _verify_clean_zip(release)
        else:
            raise RuntimeError("completed Energy run produced no clean release package")

        rows = []
        for raw in list(result.get("artifacts") or []):
            row = dict(raw)
            if str(row.get("name") or "") == RECOVERY_PACKAGE:
                row["userVisible"] = False
                row["reviewName"] = "REVEX Diagnostic Recovery Package"
            if str(row.get("name") or "") != CURRENT_RELEASE_PACKAGE:
                rows.append(row)
        release_sha = _sha256(release)
        rows.append({
            "name": CURRENT_RELEASE_PACKAGE,
            "reviewName": "REVEX Energy Release Package",
            "path": CURRENT_RELEASE_PACKAGE,
            "kind": "release-package",
            "userVisible": True,
            "bytes": release.stat().st_size,
            "sha256": release_sha,
        })
        result["artifacts"] = rows
        result["sourceCandidate"] = str(os.environ.get("REVEX_SOURCE_CANDIDATE") or result.get("sourceCandidate") or "unbound")
        result["releasePackage"] = {
            "schema": "liber.revex.energy-release-package.v2",
            "name": CURRENT_RELEASE_PACKAGE,
            "path": CURRENT_RELEASE_PACKAGE,
            "bytes": release.stat().st_size,
            "sha256": release_sha,
            "entryCount": 9,
            "entries": sorted(en1.PUBLIC_REVIEW_NAMES),
            "sourceEngineeringRevision": result.get("sourceEngineeringRevision"),
            "sourceCandidate": result.get("sourceCandidate"),
            "diagnosticRecoveryPackageUserVisible": False,
        }

        package = FilingPackage.discover(output_root).require_complete()
        result["filingPackageContract"] = {
            "schema": "liber.revex.energy-filing-package.v1",
            "status": "PASSED",
            "artifacts": package.canonical_names(),
            "releasePackage": CURRENT_RELEASE_PACKAGE,
            "missingVtPolicy": 0.45,
            "actualVtPreserved": True,
        }
        review_models = _review_models(output_root, result.get("artifacts") or [])
        maint = dict(result.get("maintainer") or {})
        if maint:
            maint["status"] = "REVIEW_READY"
            maint["stage"] = "PACKAGE_REVIEW"
            maint["message"] = "All internal Energy/filing integrity checks passed. Review the synchronized package and OSM models, then approve this revision."
            maint["packageApprovalRequired"] = True
            maint["reviewModels"] = review_models
            maint["releasePackage"] = CURRENT_RELEASE_PACKAGE
            result["maintainer"] = maint
            state_path = output_root / maintainer.STATE_NAME
            if state_path.is_file():
                state_path.write_text(json.dumps(maint, ensure_ascii=True, indent=2), encoding="utf-8")
                for row in result["artifacts"]:
                    if str(row.get("name") or "") == maintainer.STATE_NAME:
                        row["bytes"] = state_path.stat().st_size
                        row["sha256"] = _sha256(state_path)
        result["reviewModels"] = review_models
        result["packageApprovalRequired"] = True

        result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
        print(json.dumps({
            "stage": "CURRENT_FILING_PACKAGE",
            "status": "PASSED",
            "package": CURRENT_RELEASE_PACKAGE,
            "entryCount": 9,
            "reviewModels": len(review_models),
            "maintainer": "REVIEW_READY" if result.get("maintainer") else "NOT_PRESENT",
        }, ensure_ascii=True), flush=True)
        return 0
    except Exception as exc:
        result["status"] = "FAILED"
        result["error"] = f"Current filing package contract failed: {type(exc).__name__}: {exc}"
        result["failureContext"] = {
            "failedStage": "CURRENT_FILING_PACKAGE",
            "type": type(exc).__name__,
            "message": str(exc),
        }
        result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
        print(json.dumps({
            "stage": "CURRENT_FILING_PACKAGE",
            "status": "FAILED",
            "error": str(exc),
        }, ensure_ascii=True), flush=True)
        return 2


def main(argv=None) -> int:
    request_path = _request_path(argv)
    code = int(shadow.main(argv))
    if request_path is not None:
        return _promote_clean_release_package(request_path, code)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
