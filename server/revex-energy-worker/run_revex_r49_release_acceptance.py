#!/usr/bin/env python3
"""Run the real-project r49 acceptance chain before any publication mutation."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import app as worker


EXPECTED_REVIEW_ENTRIES = {
    "GEOMETRY.osm",
    "BASELINE.osm",
    "PROPOSED.osm",
    "BASELINE_REPORT.html",
    "PROPOSED_REPORT.html",
    "EN-1.xlsx",
    "COMcheck_BACKSTOP.pdf",
    "PACKAGER_REPORTS.zip",
}


PAGE_SCAN_VERSION = "20260813r49"


def _expected_page_hashes(manifest: dict) -> dict[str, str]:
    rows = [
        row for row in list(manifest.get("artifacts") or [])
        if str(row.get("role") or "").lower() == "revit-page-pdf"
    ]
    return {
        worker.safe_name(str(row.get("name") or "")).lower(): str(row.get("sha256") or "").lower()
        for row in rows
        if str(row.get("name") or "").strip() and str(row.get("sha256") or "").strip()
    }


def _try_reuse_page_facts(manifest: dict, output: Path) -> Path | None:
    """Reuse a prior scan only when it is byte-bound to this exact Revit evidence.

    The cache is an optimization, never an authority bypass: scan version, active
    Revit identity digest, and every immutable T/Z/EN page filename + SHA-256 must
    match the current Engineering manifest exactly.
    """
    if str(os.environ.get("REVEX_R49_FORCE_FRESH_PAGE_SCAN") or "").strip().lower() in {"1", "true", "yes"}:
        return None
    expected_pages = _expected_page_hashes(manifest)
    expected_identity = str((manifest.get("projectBinding") or {}).get("identityEvidenceDigest") or "").strip().lower()
    if not expected_pages or not expected_identity:
        return None

    publish_root = output.parent.parent
    candidates: list[Path] = []
    if publish_root.is_dir():
        for candidate in publish_root.glob("*/real-project-energy/revit-page-facts.json"):
            try:
                if candidate.resolve() != (output / "revit-page-facts.json").resolve():
                    candidates.append(candidate)
            except OSError:
                continue
    candidates.sort(key=lambda path: path.stat().st_mtime if path.exists() else 0.0, reverse=True)

    current_scanner = Path(worker.__file__).resolve()
    current_scanner_sha = worker.sha256(current_scanner) if current_scanner.is_file() else ""
    for candidate in candidates:
        try:
            prior_stage = candidate.parent.parent
            prior_scanner = prior_stage / "source" / "server" / "revex-energy-worker" / "app.py"
            prior_scanner_sha = worker.sha256(prior_scanner) if prior_scanner.is_file() else ""
            # PAGE_SCAN_VERSION is the explicit compatibility contract for the expensive raw page scan.
            # Post-scan semantic extraction can evolve independently and is rerun below, so an app.py
            # hash change alone must not force every immutable Revit sheet through Gemini again.
            facts = json.loads(candidate.read_text(encoding="utf-8"))
            if facts.get("schema") != "liber.revex.revit-page-facts.v1":
                continue
            if facts.get("scanVersion") != PAGE_SCAN_VERSION or facts.get("status") not in {"COMPLETE", "PARTIAL"}:
                continue
            identity = str((facts.get("structuredIdentity") or {}).get("evidenceDigest") or "").strip().lower()
            if identity != expected_identity:
                continue
            actual_pages = {
                worker.safe_name(str(page.get("sourceFile") or "")).lower(): str(page.get("sourceSha256") or "").lower()
                for page in list(facts.get("pages") or [])
                if str(page.get("sourceFile") or "").strip() and str(page.get("sourceSha256") or "").strip()
            }
            if not actual_pages or not set(actual_pages).issubset(set(expected_pages)):
                continue
            if any(expected_pages.get(name) != digest for name, digest in actual_pages.items()):
                continue
            if facts.get("status") == "COMPLETE" and actual_pages != expected_pages:
                continue
            # A PARTIAL scan may be reused only as immutable raw page facts. Missing pages remain
            # missing and downstream filing gates still fail unless the surviving current-project
            # evidence is independently sufficient. The semantic COMcheck pass below always reruns.
            destination = output / "revit-page-facts.json"
            shutil.copy2(candidate, destination)
            print(json.dumps({
                "stage": "PAGE_SCAN_CACHE_REUSED",
                "scanVersion": PAGE_SCAN_VERSION,
                "pages": len(actual_pages),
                "identityDigest": expected_identity,
                "cacheSha256": worker.sha256(destination),
                "scannerSha256": current_scanner_sha,
                "sourceScannerSha256": prior_scanner_sha,
                "semanticPassRerun": True,
                "source": str(candidate),
            }, sort_keys=True), flush=True)
            return destination
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return None


def configure_failure_safe_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="backslashreplace")
        except (AttributeError, OSError):
            pass


def require_review_eligible_comparison(comparison: dict) -> str:
    """Classify the masked approved-run result without confusing cohort identity with regression.

    The masked approved profile is a regression oracle only when topology and modeled
    area identify the same cohort. A different cohort is intentionally unbenchmarked,
    not failed: the pipeline may still mark it review-eligible after all independent
    simulation/filing gates pass. True matching-cohort regressions remain blocked.
    """
    status = str(comparison.get("status") or "")
    selection = str(comparison.get("iterationSelection") or "")
    review_eligible = comparison.get("reviewEligible") is True
    cohort_matches = comparison.get("cohortMatches") is True
    if not review_eligible:
        raise RuntimeError(
            "Real-project Energy comparison withheld the review candidate: "
            f"status={status or '<missing>'}; selection={selection or '<missing>'}."
        )
    if status == "PASSED" and selection == "BEST_WORKING_ITERATION" and cohort_matches:
        return "BENCHMARKED_BEST_WORKING_ITERATION"
    if (status == "NOT_APPLICABLE_DIFFERENT_COHORT"
            and selection == "UNBENCHMARKED_DIFFERENT_COHORT"
            and not cohort_matches):
        return "UNBENCHMARKED_DIFFERENT_COHORT"
    raise RuntimeError(
        "Real-project Energy comparison state is internally inconsistent: "
        f"status={status or '<missing>'}; selection={selection or '<missing>'}; "
        f"cohortMatches={comparison.get('cohortMatches')!r}; reviewEligible={comparison.get('reviewEligible')!r}."
    )


def main() -> int:
    configure_failure_safe_stdio()
    parser = argparse.ArgumentParser()
    parser.add_argument("--engineering-root", type=Path, required=True)
    parser.add_argument("--output-folder", type=Path, required=True)
    parser.add_argument("--review-package", type=Path, required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--pipeline", type=Path, required=True)
    args = parser.parse_args()

    engineering_root = args.engineering_root.resolve()
    output = args.output_folder.resolve()
    review_target = args.review_package.resolve()
    manifest_path = engineering_root / "engineering-sync.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Real Revit Engineering manifest is missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    project_id = str(manifest.get("projectId") or "").strip()
    source_revision = str(manifest.get("revision") or "").strip()
    if project_id != args.project_id or not source_revision:
        raise RuntimeError("Real Revit Engineering project/revision identity is incomplete or mismatched.")

    local_by_name = worker.index_local_artifacts(engineering_root.iterdir())
    worker.require_integrity(manifest, project_id, source_revision)
    gbxml, weather, report, summary = worker.validate_artifact_contract(manifest, local_by_name)
    output.mkdir(parents=True, exist_ok=False)
    page_facts = _try_reuse_page_facts(manifest, output)
    if page_facts is None:
        page_facts = worker.scan_revit_page_facts(manifest, local_by_name, output, project_id)
    else:
        page_facts = worker.enrich_comcheck_schedule_facts(manifest, local_by_name, page_facts, project_id)
    facts = json.loads(page_facts.read_text(encoding="utf-8"))
    if facts.get("status") not in {"COMPLETE", "PARTIAL"} or not list(facts.get("pages") or []):
        raise RuntimeError(
            "Managed T/Z/EN scan did not produce real-project page facts: "
            + str(facts.get("errors") or facts.get("error") or facts.get("status"))
        )

    consent = {
        "schema": worker.COMCHECK_CONSENT_SCHEMA,
        "projectId": project_id,
        "sourceEngineeringRevision": source_revision,
        "service": worker.COMCHECK_SERVICE,
        "endpoint": worker.COMCHECK_ENDPOINT,
        "scope": worker.COMCHECK_SCOPE,
        "approved": True,
        "approvedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "approvedByUid": "publisher-owner-explicit-r49-release-request",
        "immutable": True,
    }
    request = {
        "schema": "liber.revex.energy-request.v1",
        "pipelineVersion": "0.8.19-r49",
        "correlationId": f"release-acceptance-{source_revision}",
        "parentCorrelationId": str(manifest.get("correlationId") or ""),
        "initiator": "PUBLISH_REVEX_R49 real-project acceptance",
        "projectId": project_id,
        "projectName": (manifest.get("projectBinding") or {}).get("identityDisplayName")
                       or (manifest.get("sourceModel") or {}).get("title")
                       or "Real Revit publication project",
        "revision": source_revision,
        "engineeringManifestPath": str(manifest_path),
        "gbxmlPath": str(gbxml),
        "gbxmlReportPath": str(report) if report else "",
        "gbxmlSummaryPath": str(summary) if summary else "",
        "weatherFile": str(weather),
        "pageFactsPath": str(page_facts),
        "sourceArtifacts": [str(path) for path in local_by_name.values()] + [str(page_facts)],
        "outputFolder": str(output),
        "openStudioCli": "",
        "standardVersion": "NYCECC 2020",
        "filingPath": "NYCECC_APPENDIX_CA_PRM",
        "externalProcessingConsent": consent,
        "publicationQa": True,
        "execution": {
            "mode": "publisher-real-project",
            "evidenceExtraction": "automatic-staged-Revit-host",
            "comcheck": "official-pnnl-backstop-from-current-project-cxl",
        },
        "identityPolicy": "CURRENT_IDENTITY_FROM_ACTIVE_REVIT_T_Z; REFERENCE_IDENTITY_MASKED; APPLICANT_MODELER_BLANK",
        "applicant": {},
    }
    request_path = output.parent / "REVEX-R49-REAL-PROJECT-ENERGY-REQUEST.json"
    request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")
    environment = os.environ.copy()
    environment["REVEX_PUBLICATION_QA"] = "true"
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, str(args.pipeline.resolve()), "--request", str(request_path)],
        cwd=str(args.pipeline.resolve().parent), env=environment,
    )
    result_path = output / "energy-result.json"
    if not result_path.is_file():
        raise RuntimeError(f"Real-project Energy result is missing (pipeline exit {completed.returncode}).")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    comparison = dict(result.get("approvedRunComparison") or {})
    package = dict(result.get("manualReviewPackage") or {})
    if completed.returncode != 0 or result.get("status") != "COMPLETE":
        raise RuntimeError(
            "Real-project Energy chain did not complete: "
            + str(result.get("error") or result.get("status") or completed.returncode)
        )
    comparison_disposition = require_review_eligible_comparison(comparison)
    if package.get("status") != "CREATED":
        raise RuntimeError("The review-eligible Energy iteration did not produce the manual review package.")
    source_package = output / str(package.get("path") or "")
    if not source_package.is_file() or not zipfile.is_zipfile(source_package):
        raise RuntimeError("The eight-item Energy review package is missing or invalid.")
    with zipfile.ZipFile(source_package) as archive:
        entries = {name for name in archive.namelist() if not name.endswith("/")}
        if entries != EXPECTED_REVIEW_ENTRIES:
            raise RuntimeError(
                f"Energy review package contract mismatch; missing={sorted(EXPECTED_REVIEW_ENTRIES-entries)}, "
                f"unexpected={sorted(entries-EXPECTED_REVIEW_ENTRIES)}"
            )
    review_target.parent.mkdir(parents=True, exist_ok=True)
    temporary = review_target.with_suffix(review_target.suffix + ".tmp")
    shutil.copy2(source_package, temporary)
    temporary.replace(review_target)
    acceptance = {
        "schema": "liber.revex.real-project-release-acceptance.v1",
        "status": "PASSED",
        "projectId": project_id,
        "sourceEngineeringRevision": source_revision,
        "resultRevision": result.get("resultRevision"),
        "identitySource": "active-revit-document-t-z-title-evidence",
        "referenceIdentity": "MASKED",
        "approvedRunComparison": comparison,
        "comparisonDisposition": comparison_disposition,
        "manualReviewPackage": {
            "path": str(review_target),
            "bytes": review_target.stat().st_size,
            "sha256": worker.sha256(review_target),
            "topLevelFiles": 7,
            "topLevelArchives": 1,
        },
        "bimSpecEnergy": True,
        "officialComcheck": True,
        "finishedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    acceptance_path = output.parent / "REVEX-R49-REAL-PROJECT-ACCEPTANCE.json"
    acceptance_path.write_text(json.dumps(acceptance, indent=2), encoding="utf-8")
    print(json.dumps(acceptance, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
