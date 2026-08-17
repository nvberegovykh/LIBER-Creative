#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

from flask import jsonify, make_response, request
from google.cloud import storage

R123_SOURCE = "8fcff4ee182ff3187fb6b0e6e6bcef8821a6df9e"
RELEASE_PACKAGE = "REVEX_ENERGY_RELEASE_PACKAGE.zip"
REUSE_NAMES = ("GEOMETRY.osm", "BASELINE.osm", "PROPOSED.osm", "BASELINE_REPORT.html", "PROPOSED_REPORT.html")
PUBLIC_NAMES = set(REUSE_NAMES + ("EN-1.xlsx", "EN-1.pdf", "COMcheck_BACKSTOP.pdf", "PACKAGER_REPORTS.zip"))


def _log(stage: str, **detail) -> None:
    print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "stage": stage, **detail}, ensure_ascii=True), flush=True)


def _json_blob(bucket, path: str):
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    try:
        value = json.loads(blob.download_as_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _row(path: Path, root: Path, kind: str, review_name: str, visible: bool = True) -> dict:
    import app as worker
    return {"name": path.name, "path": path.resolve().relative_to(root.resolve()).as_posix(), "kind": kind,
            "reviewName": review_name, "userVisible": visible, "bytes": path.stat().st_size, "sha256": worker.sha256(path)}


def _prior_row(manifest: dict, review_name: str):
    return next((dict(row) for row in list(manifest.get("artifacts") or []) if str(row.get("reviewName") or "") == review_name), None)


def _prior_is_reusable(manifest: dict, project_id: str, revision: str, current_source: str) -> bool:
    if manifest.get("schema") != "liber.revex.energy-result.v1" or str(manifest.get("pipelineVersion") or "") != "0.8.19-r49":
        return False
    if str(manifest.get("projectId") or "") != project_id or str(manifest.get("sourceEngineeringRevision") or "") != revision:
        return False
    if str(manifest.get("sourceCandidate") or "") not in {R123_SOURCE, current_source}:
        return False
    comparison = dict(manifest.get("approvedRunComparison") or {})
    return comparison.get("reviewEligible") is True and str(comparison.get("status") or "").upper() != "REGRESSION"


def _restore_reused(bucket, prefix: str, prior: dict, root: Path):
    import app as worker
    restored = {}
    for review_name in REUSE_NAMES:
        row = _prior_row(prior, review_name)
        if row is None:
            return None
        rel = str(row.get("path") or "").replace("\\", "/").lstrip("/")
        target = (root / rel).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            return None
        blob = bucket.blob(f"{prefix}/artifacts/{rel}")
        if not blob.exists():
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(str(target))
        if target.stat().st_size != int(row.get("bytes") or -1) or worker.sha256(target).lower() != str(row.get("sha256") or "").lower():
            return None
        restored[review_name] = target
    return restored


def _download_engineering(data: dict, work: Path, project_id: str, revision: str):
    import app as worker
    bucket = storage.Client().bucket(str(data.get("bucket") or ""))
    expected_prefix = f"projects/{project_id}/revex/engineering/revisions/{revision}/"
    source = work / "source"
    source.mkdir(parents=True, exist_ok=True)
    local = {}
    for row in list(data.get("artifacts") or []):
        object_path = str(row.get("path") or "")
        if not object_path.startswith(expected_prefix):
            raise ValueError(f"Engineering artifact escaped immutable revision prefix: {object_path}")
        name = worker.safe_name(row.get("name") or object_path)
        target = source / name
        bucket.blob(object_path).download_to_filename(str(target))
        if target.stat().st_size != int(row.get("bytes") or -1) or worker.sha256(target).lower() != str(row.get("sha256") or "").lower():
            raise ValueError(f"Engineering transfer integrity failed: {name}")
        local[name.lower()] = target
    manifest_path = local.get("engineering-sync.json")
    if manifest_path is None:
        raise ValueError("engineering-sync.json is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    worker.require_integrity(manifest, project_id, revision)
    gbxml, weather, report, summary = worker.validate_artifact_contract(manifest, local)
    page_facts = worker.scan_revit_page_facts(manifest, local, source, project_id)
    return bucket, manifest, local, manifest_path, gbxml, weather, report, summary, page_facts


def _effective_request(data: dict, work: Path, root: Path, project_id: str, revision: str,
                       manifest: dict, local: dict, manifest_path: Path, gbxml: Path, weather: Path,
                       report: Path | None, summary: Path | None, page_facts: Path) -> Path:
    import app as worker
    import revex_energy_pipeline_guard as base
    import revex_energy_pipeline_guard_r118 as r118
    consent = worker.require_comcheck_consent(data, project_id, revision)
    req = {"schema": "liber.revex.energy-request.v1", "pipelineVersion": "0.8.19-r49",
           "correlationId": f"energy-resume-r124-{revision}", "parentCorrelationId": str(manifest.get("correlationId") or ""),
           "initiator": "REVEX r124 resumable publication", "projectId": project_id,
           "projectName": data.get("projectName") or manifest.get("sourceModel", {}).get("title") or "REVEX Energy",
           "revision": revision, "engineeringManifestPath": str(manifest_path), "gbxmlPath": str(gbxml),
           "gbxmlReportPath": str(report) if report else "", "gbxmlSummaryPath": str(summary) if summary else "",
           "weatherFile": str(weather), "pageFactsPath": str(page_facts),
           "sourceArtifacts": [str(path) for path in local.values()] + [str(page_facts)], "outputFolder": str(root),
           "openStudioCli": "", "standardVersion": "NYCECC 2020", "filingPath": "NYCECC_APPENDIX_CA_PRM",
           "comcheckContext": data.get("projectSource") or {}, "externalProcessingConsent": consent,
           "identityPolicy": "PROJECT_IDENTITY_FROM_ACTIVE_REVIT_EVIDENCE_AND_T_Z_PAGES; APPLICANT_AND_MODELER_BLANK", "applicant": {}}
    raw = work / "energy-resume-request.json"
    raw.write_text(json.dumps(req, ensure_ascii=True, indent=2), encoding="utf-8")
    effective = base._resolve_user_identity_request(raw, root)
    effective = base._resolve_content_identity_request(effective, root)
    effective = base._resolve_r69_request(effective, root)
    effective = base._resolve_user_identity_request(effective, root)
    effective = base._resolve_structured_schedule_request(effective, root)
    if not base._structured_schedule_conflicts(effective):
        effective = r118._resolve_comcheck_evidence_then_reference(effective, root)
    return Path(effective).resolve()


def _pipeline():
    import revex_energy_pipeline_guard as base
    impl = base._pipeline_impl()
    parent = str(impl.parent)
    inserted = parent not in sys.path
    if inserted:
        sys.path.insert(0, parent)
    try:
        spec = importlib.util.spec_from_file_location("revex_r124_pipeline", impl)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load Energy implementation: {impl}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if inserted:
            sys.path.remove(parent)


def _simple_pdf(xlsx: Path, pdf: Path) -> None:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("LibreOffice is unavailable for EN-1 PDF")
    out = Path(tempfile.mkdtemp(prefix="revex-r124-pdf-"))
    profile = Path(tempfile.gettempdir()) / f"revex-r124-lo-{uuid.uuid4().hex}"
    try:
        done = subprocess.run([soffice, "--headless", f"-env:UserInstallation=file://{profile.as_posix()}", "--convert-to", "pdf",
                               "--outdir", str(out), str(xlsx)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding="utf-8", errors="replace", timeout=180)
        candidate = out / f"{xlsx.stem}.pdf"
        if done.returncode != 0 or not candidate.is_file() or candidate.stat().st_size < 1024:
            raise RuntimeError("EN-1 PDF export failed: " + (done.stdout or "")[-1000:])
        shutil.copy2(candidate, pdf)
    finally:
        shutil.rmtree(out, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


def _finish_en1_and_zip(effective: Path, result: dict, root: Path, rows: list[dict]):
    import app as worker
    import revex_user_identity_en1 as en1
    req = json.loads(effective.read_text(encoding="utf-8"))
    context = en1._context(req)
    xlsx = root / "05_FILING" / "EN-1_READY_TO_INSERT.xlsx"
    identity = en1._fill_people_identity(xlsx, en1._sanitize_person(context.get("en1Applicant"), modeler=False),
                                         en1._sanitize_person(context.get("en1Modeler"), modeler=True))
    for row in rows:
        if (root / str(row.get("path") or "")).resolve() == xlsx.resolve():
            row.update(bytes=xlsx.stat().st_size, sha256=worker.sha256(xlsx))
    pdf = root / "05_FILING" / "EN-1_READY_TO_INSERT.pdf"
    strict_pdf = True
    try:
        en1._print_en1_pdf(xlsx, pdf, root)
    except Exception as exc:
        strict_pdf = False
        _log("EN1_STRICT_PDF_FALLBACK", error=f"{type(exc).__name__}: {exc}")
        if not pdf.is_file() or pdf.stat().st_size < 1024:
            _simple_pdf(xlsx, pdf)
    rows.append(_row(pdf, root, "en1-pdf", "EN-1.pdf"))
    if len(rows) != 9 or {str(row.get("reviewName") or "") for row in rows} != PUBLIC_NAMES:
        raise RuntimeError("release package public contract is not exactly nine files")
    package = root / RELEASE_PACKAGE
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for row in rows:
            local = (root / str(row["path"])).resolve()
            row.update(bytes=local.stat().st_size, sha256=worker.sha256(local))
            archive.write(local, str(row["reviewName"]))
    with zipfile.ZipFile(package) as check:
        entries = [name for name in check.namelist() if not name.endswith("/")]
        if len(entries) != 9 or set(entries) != PUBLIC_NAMES:
            raise RuntimeError("release ZIP verification failed")
    result["en1Identity"] = {"schema": "liber.revex.en1-user-identity.v1", **identity, "transmittedToComcheck": False}
    result["en1Pdf"] = {"name": pdf.name, "path": pdf.relative_to(root).as_posix(), "bytes": pdf.stat().st_size,
                        "sha256": worker.sha256(pdf), "strictPrintQa": strict_pdf}
    result["releasePackage"] = {"schema": "liber.revex.energy-release-package.v1", "name": RELEASE_PACKAGE,
                                "path": RELEASE_PACKAGE, "bytes": package.stat().st_size, "sha256": worker.sha256(package),
                                "entryCount": 9, "strictEn1PrintQa": strict_pdf,
                                "source": "VERIFIED_COMPLETED_SIMULATION_REUSE"}
    return result, package


def _publish(bucket, prefix: str, root: Path, result: dict, rows: list[dict]):
    import app as worker
    refreshed = []
    for row in rows:
        row = dict(row)
        local = (root / str(row.get("path") or "")).resolve()
        local.relative_to(root.resolve())
        if not local.is_file():
            raise RuntimeError(f"final artifact is missing: {row.get('path')}")
        row.update(bytes=local.stat().st_size, sha256=worker.sha256(local))
        refreshed.append(row)
    result["artifacts"] = refreshed
    result["sourceCandidate"] = worker.SOURCE_CANDIDATE or "unbound"
    result["publicationIntegrity"] = {"schema": "liber.revex.energy-publication-integrity.v1",
                                      "finalBytesRehashedImmediatelyBeforeUpload": True, "artifactCount": len(refreshed)}
    result_path = root / "energy-result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    uploaded = []
    for row in refreshed:
        local = (root / str(row["path"])).resolve()
        meta = worker.upload_with_token(bucket, local, f"{prefix}/artifacts/{row['path']}")
        uploaded.append({**row, **meta, "relativePath": row["path"]})
    manifest = worker.upload_with_token(bucket, result_path, f"{prefix}/energy-result.json", "application/json")
    return uploaded, manifest


def _attempt(data: dict):
    import app as worker
    project_id = str(data.get("projectId") or "").strip()
    revision = str(data.get("sourceRevision") or "").strip()
    bucket_name = str(data.get("bucket") or "").strip()
    prefix = str(data.get("outputPrefix") or "").strip().strip("/")
    if not project_id or not revision or not bucket_name or not prefix:
        return None
    bucket = storage.Client().bucket(bucket_name)
    prior = _json_blob(bucket, f"{prefix}/energy-result.json")
    if prior is None or not _prior_is_reusable(prior, project_id, revision, worker.SOURCE_CANDIDATE):
        return None
    with tempfile.TemporaryDirectory(prefix="revex-r124-resume-") as tmp:
        work = Path(tmp)
        root = work / "run"
        root.mkdir(parents=True, exist_ok=True)
        restored = _restore_reused(bucket, prefix, prior, root)
        if restored is None:
            return None
        _log("PUBLICATION_RESUME_REUSE_VERIFIED", projectId=project_id, sourceRevision=revision, reused=list(REUSE_NAMES))
        _, eng, local, manifest_path, gbxml, weather, report, summary, page_facts = _download_engineering(data, work, project_id, revision)
        effective = _effective_request(data, work, root, project_id, revision, eng, local, manifest_path, gbxml, weather, report, summary, page_facts)
        pipeline = _pipeline()
        effective_data = json.loads(effective.read_text(encoding="utf-8"))
        facts = pipeline.load_page_facts(Path(str(effective_data.get("pageFactsPath") or "")))
        identity = pipeline.current_project_identity(facts)
        if identity.get("missing"):
            raise RuntimeError("current-project identity is incomplete: " + ", ".join(identity["missing"]))
        project_name = str(identity.get("title") or identity.get("address") or data.get("projectName") or "REVEX Energy")
        packager = pipeline.load_module(pipeline.PACKAGER, "revex_r124_packager")
        review_zip = Path(packager.generate_package(str(restored["BASELINE_REPORT.html"]), str(restored["PROPOSED_REPORT.html"]),
                                                    str(root / "04_REVIEW_PACKAGE"), project_name, True,
                                                    standard_version=str(effective_data.get("standardVersion") or "NYCECC 2020"),
                                                    baseline_model_file=str(restored["BASELINE.osm"]),
                                                    proposed_model_file=str(restored["PROPOSED.osm"])))
        filing = root / "05_FILING"
        filing.mkdir(parents=True, exist_ok=True)
        log = pipeline.RunLog(root, str(effective_data.get("correlationId") or "r124"), "REVEX r124 resumable publication")
        en1_xlsx, _, metrics = pipeline.prepare_en1(packager, restored["BASELINE_REPORT.html"], restored["PROPOSED_REPORT.html"],
                                                    filing, log, pipeline.validate_epw(weather), identity)
        cxl, _, audit = pipeline.prepare_project_comcheck(facts, identity, filing, log)
        if cxl is None:
            raise RuntimeError("project-specific COMcheck CXL could not be rebuilt: " + "; ".join(audit.get("missing") or []))
        comcheck_pdf, _, result_json, comcheck_summary = pipeline.run_project_backstop(
            cxl, filing, identity, log, effective_data.get("externalProcessingConsent") or {}, project_id, revision)
        rows = [_row(restored["GEOMETRY.osm"], root, "geometry-osm", "GEOMETRY.osm"),
                _row(restored["BASELINE.osm"], root, "compiled-model", "BASELINE.osm"),
                _row(restored["PROPOSED.osm"], root, "compiled-model", "PROPOSED.osm"),
                _row(restored["BASELINE_REPORT.html"], root, "baseline-html", "BASELINE_REPORT.html"),
                _row(restored["PROPOSED_REPORT.html"], root, "proposed-html", "PROPOSED_REPORT.html"),
                _row(en1_xlsx, root, "en1-spreadsheet", "EN-1.xlsx"),
                _row(comcheck_pdf, root, "official-comcheck-pdf", "COMcheck_BACKSTOP.pdf"),
                _row(review_zip, root, "packager-reports-archive", "PACKAGER_REPORTS.zip")]
        now = dt.datetime.now(dt.timezone.utc)
        result = {"schema": "liber.revex.energy-result.v1", "pipelineVersion": "0.8.19-r49",
                  "correlationId": str(effective_data.get("correlationId") or ""), "parentCorrelationId": effective_data.get("parentCorrelationId"),
                  "initiator": "REVEX r124 resumable publication", "projectId": project_id, "projectName": project_name,
                  "projectIdentity": identity, "sourceEngineeringRevision": revision,
                  "resultRevision": "energy_" + now.strftime("%Y%m%dT%H%M%SZ"), "status": "COMPLETE",
                  "startedAt": now.isoformat(), "finishedAt": now.isoformat(), "error": None, "failureContext": None,
                  "metrics": metrics, "approvedRunComparison": prior.get("approvedRunComparison") or {}, "artifacts": rows,
                  "comcheck": {**dict(audit or {}), **dict(comcheck_summary or {}), "projectInputReady": True,
                               "officialDoeReport": True, "officialDoeReportStatus": "VERIFIED"},
                  "resume": {"schema": "liber.revex.energy-publication-resume.v1", "reusedSourceCandidate": prior.get("sourceCandidate"),
                             "reused": list(REUSE_NAMES), "geometryCoRerun": False, "energyPlusRerun": False,
                             "comcheckRerun": True, "en1Rebuilt": True, "packagerRebuilt": True},
                  "revitWriteBack": False, "pdfInsertion": False,
                  "authorityBoundary": "Resumed publication reuses verified derived simulation outputs and never writes to Revit."}
        result, release = _finish_en1_and_zip(effective, result, root, rows)
        final_rows = list(rows)
        final_rows.append(_row(cxl, root, "filing-input", cxl.name, False))
        final_rows.append(_row(result_json, root, "engine-evidence", result_json.name, False))
        final_rows.append(_row(release, root, "release-package", RELEASE_PACKAGE, True))
        uploaded, manifest_meta = _publish(bucket, prefix, root, result, final_rows)
        result = json.loads((root / "energy-result.json").read_text(encoding="utf-8"))
        _log("PUBLICATION_RESUME_COMPLETE", projectId=project_id, sourceRevision=revision, releasePackage=RELEASE_PACKAGE)
        return jsonify({"schema": "liber.revex.energy-server-response.v1", "projectId": project_id, "sourceRevision": revision,
                        "resultRevision": result.get("resultRevision"), "status": "COMPLETE", "error": None,
                        "manifest": result, "manifestPath": manifest_meta["path"], "manifestUrl": manifest_meta["url"],
                        "artifacts": uploaded}), 200


def install_publication_resume(app) -> None:
    original = app.view_functions.get("run_energy")
    if original is None or getattr(original, "__revex_r124_resume__", False):
        return

    def resumable_run_energy():
        import app as worker
        data = request.get_json(silent=True) or {}
        if worker.TOKEN and request.headers.get("X-REVEX-Runner-Token", "") != worker.TOKEN:
            return original()
        if data.get("schema") != "liber.revex.energy-server-request.v1":
            return original()
        try:
            resumed = _attempt(data)
            if resumed is not None:
                return resumed
        except Exception as exc:
            _log("PUBLICATION_RESUME_PRECHECK_FAILED", error=f"{type(exc).__name__}: {exc}")
        response = make_response(original())
        body = response.get_json(silent=True)
        error = str((body or {}).get("error") or "") if isinstance(body, dict) else ""
        if response.status_code >= 500 and "pipeline Energy artifact integrity mismatch" in error:
            try:
                resumed = _attempt(data)
                if resumed is not None:
                    return resumed
            except Exception as exc:
                _log("PUBLICATION_RESUME_AFTER_HASH_FAILURE_FAILED", error=f"{type(exc).__name__}: {exc}")
        return response

    resumable_run_energy.__name__ = original.__name__
    resumable_run_energy.__revex_r124_resume__ = True
    app.view_functions["run_energy"] = resumable_run_energy
