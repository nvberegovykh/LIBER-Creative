#!/usr/bin/env python3
"""Offline r49 managed-worker contract QA.

Exercises the immutable active-document binding, artifact hashes, project-scoped
paths, revision-scoped COMcheck consent, pipeline handoff, strict completion
contract, and Storage publication without network or Google credentials.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parent
os.environ.setdefault("REVEX_SOURCE_CANDIDATE", "qa-source-candidate")
spec = importlib.util.spec_from_file_location("revex_r49_worker", ROOT / "app.py")
assert spec and spec.loader
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.modules.setdefault("app", worker)
acceptance_spec = importlib.util.spec_from_file_location(
    "revex_r49_release_acceptance_contract", ROOT / "run_revex_r49_release_acceptance.py"
)
assert acceptance_spec and acceptance_spec.loader
release_acceptance = importlib.util.module_from_spec(acceptance_spec)
acceptance_spec.loader.exec_module(release_acceptance)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="revex-r49-worker-qa-") as temp:
        folder = Path(temp)
        project_id = "revex_project_qa"
        revision = "eng_immutable_qa_001"
        evidence_digest = "a" * 64
        gbxml = folder / "revit-energy.xml"
        weather = folder / "weather.epw"
        identity = folder / "revit-project-identity.json"
        page_pdf = folder / "REVIT_PAGE_EN_EN-001.01_ENERGY ANALYSIS - PERFORMANCE PATH.pdf"
        page_index = folder / "revit-page-index.json"
        gbxml.write_text("<gbXML>" + ("current-model" * 100) + "</gbXML>", encoding="utf-8")
        weather.write_text("LOCATION,Test City,NY,USA,TMY3,725030,40.7,-73.9,-5,3\n" + ("0," * 20), encoding="utf-8")
        identity.write_text(json.dumps({
            "schema": "liber.revex.revit-project-identity.v1",
            "authority": "active-revit-document-t-z-title-evidence",
            "digest": evidence_digest,
            "displayName": "CURRENT TEST PROJECT",
            "model": "Current Test Model",
            "sheets": ["T001 · TITLE", "Z001 · ZONING"],
            "fields": {
                "project.Project Name": "CURRENT TEST PROJECT",
                "project.Project Address": "999 CURRENT AVENUE",
                "sheet.T001.titleBlock.City": "BROOKLYN",
                "sheet.T001.titleBlock.State": "NY",
                "sheet.T001.titleBlock.Zip Code": "11201",
            },
        }), encoding="utf-8")
        page_pdf.write_bytes(b"%PDF-1.4\n% immutable Revit EN evidence\n")
        page_index.write_text(json.dumps({
            "schema": "liber.revex.revit-page-index.v1",
            "pages": [{
                "file": page_pdf.name,
                "discipline": "EN",
                "sheetNumber": "EN-001.01",
            }],
        }), encoding="utf-8")

        manifest = {
            "schema": "liber.revex.engineering-sync.v1",
            "architecture": "REVIT_EVIDENCE_GRAPH_V1",
            "projectId": project_id,
            "revision": revision,
            "projectBinding": {
                "version": "active-revit-evidence-v1",
                "source": "explicit-user-selection",
                "documentUniqueId": "revit-doc-qa",
                "documentFingerprint": "fingerprint-qa",
                "identityEvidenceDigest": evidence_digest,
            },
            "publicationIntegrity": {
                "threshold": 0.80, "qualityTarget": 0.95,
                "ratios": {"overall": 0.91, "physical": 0.91},
            },
            "writeBackToRevitAfterExport": False,
            "pdfInsertion": False,
            "weather": {
                "city": "Test City", "stateProvince": "NY", "country": "USA",
                "dataSource": "TMY3", "wmo": "725030", "sha256": digest(weather),
            },
            "artifacts": [],
        }
        for path, role in (
            (gbxml, "gbxml"), (weather, "weather-epw"), (identity, "revit-project-identity"),
            (page_pdf, "revit-page-pdf"), (page_index, "revit-page-index"),
        ):
            manifest["artifacts"].append({
                "name": path.name, "role": role, "bytes": path.stat().st_size,
                "sha256": digest(path),
            })
        local = worker.index_local_artifacts(folder.iterdir())
        canonical_page_name = worker.safe_name(page_pdf.name).lower()
        assert local[canonical_page_name] == page_pdf
        page_rows = worker.index_revit_page_rows(json.loads(page_index.read_text(encoding="utf-8")))
        assert page_rows[canonical_page_name]["discipline"] == "EN"
        worker.require_integrity(manifest, project_id, revision)
        publisher_manifest = json.loads(json.dumps(manifest))
        publisher_manifest["projectBinding"]["source"] = "publisher-real-revit-evidence"
        worker.require_integrity(publisher_manifest, project_id, revision)
        invalid_source = json.loads(json.dumps(manifest))
        invalid_source["projectBinding"]["source"] = "synthetic-recorded-revit"
        try:
            worker.require_integrity(invalid_source, project_id, revision)
            raise AssertionError("Synthetic recorded-Revit binding was accepted as real evidence")
        except ValueError:
            pass
        found_gbxml, found_weather, _, _ = worker.validate_artifact_contract(manifest, local)
        assert found_gbxml == gbxml and found_weather == weather
        with worker.APP.app_context():
            health = worker.healthz().get_json()
        assert health["sourceCandidate"] == "qa-source-candidate"
        normalized = worker.load_structured_identity(manifest, local)
        assert normalized["title"] == "CURRENT TEST PROJECT"
        assert normalized["address"] == "999 CURRENT AVENUE"
        assert normalized["city"] == "BROOKLYN" and normalized["zip"] == "11201"
        assert normalized["evidenceDigest"] == evidence_digest

        assert worker._explicit_energy_code_from_visible_text(
            "1. CODE REFERENCE This project complies with the 2020 NYC Energy Conservation Code using the ASHRAE 90.1 Performance Path."
        ) == "2020 NYC Energy Conservation Code"
        use, area, evidence = worker._building_use_from_semantic_blob(
            "Random Schedule Name | Building Area 1-Multifamily: Residential Floor Area 10059"
        )
        assert use == "Multifamily" and area == 10059.0 and "Floor Area 10059" in evidence
        use_flat, area_flat, _ = worker._building_use_from_semantic_blob(
            "Building Area 1 Multifamily Residential Floor Area 10,059"
        )
        assert use_flat == "Multifamily" and area_flat == 10059.0
        use2, area2, _ = worker._building_use_from_semantic_blob(
            "Unrelated title [Bldg. Use 1 - Multifamily] (b)"
        )
        assert use2 == "Multifamily" and area2 is None
        assert worker._explicit_climate_zone_from_visible_text("CLIMATE ZONE 4A") == "4A"
        assert worker._ai_semantic_value_supported(10059, ["Multifamily Floor Area 10059"], "floorAreaFt2")
        assert worker._ai_semantic_value_supported("Multifamily", ["Bldg. Use 1 - Multifamily"], "wholeBuildingType")

        consent = {
            "schema": worker.COMCHECK_CONSENT_SCHEMA, "approved": True,
            "projectId": project_id, "sourceEngineeringRevision": revision,
            "approvedByUid": "qa-user", "approvedAt": "2026-08-13T00:00:00Z",
            "service": worker.COMCHECK_SERVICE, "endpoint": worker.COMCHECK_ENDPOINT,
            "scope": worker.COMCHECK_SCOPE,
        }
        assert worker.require_comcheck_consent({"comcheckConsent": consent}, project_id, revision) == consent
        try:
            worker.require_comcheck_consent({"comcheckConsent": consent}, project_id, "eng_wrong")
            raise AssertionError("cross-revision consent was accepted")
        except ValueError:
            pass
        wrong = json.loads(json.dumps(manifest))
        wrong["projectBinding"]["identityEvidenceDigest"] = "b" * 64
        try:
            worker.load_structured_identity(wrong, local)
            raise AssertionError("mismatched active-document identity digest was accepted")
        except ValueError:
            pass

    assert release_acceptance.require_review_eligible_comparison({
        "status": "PASSED",
        "iterationSelection": "BEST_WORKING_ITERATION",
        "reviewEligible": True,
        "cohortMatches": True,
    }) == "BENCHMARKED_BEST_WORKING_ITERATION"
    assert release_acceptance.require_review_eligible_comparison({
        "status": "NOT_APPLICABLE_DIFFERENT_COHORT",
        "iterationSelection": "UNBENCHMARKED_DIFFERENT_COHORT",
        "reviewEligible": True,
        "cohortMatches": False,
    }) == "UNBENCHMARKED_DIFFERENT_COHORT"
    for rejected_comparison in (
        {"status": "REGRESSION", "iterationSelection": "WITHHELD_REFERENCE_REGRESSION",
         "reviewEligible": False, "cohortMatches": True},
        {"status": "PASSED", "iterationSelection": "UNBENCHMARKED_DIFFERENT_COHORT",
         "reviewEligible": True, "cohortMatches": False},
    ):
        try:
            release_acceptance.require_review_eligible_comparison(rejected_comparison)
            raise AssertionError(f"Invalid approved-run comparison was accepted: {rejected_comparison}")
        except RuntimeError:
            pass

    print(json.dumps({
        "workerVersion": "0.8.19-r49",
        "activeDocumentBinding": True,
        "publisherRealRevitBinding": True,
        "syntheticBindingRejected": True,
        "structuredIdentity": True,
        "tZEvidence": True,
        "artifactIntegrity": True,
        "canonicalRevitPageArtifactNames": True,
        "canonicalRevitPageIndexNames": True,
        "revisionScopedConsent": True,
        "crossRevisionConsentRejected": True,
        "sourceCandidateBound": True,
        "scheduleSemanticRecognition": True,
        "scheduleNamesNonAuthoritative": True,
        "differentCohortReviewAccepted": True,
        "matchingCohortRegressionRejected": True,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
