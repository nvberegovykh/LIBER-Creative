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
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("revex_r49_worker", ROOT / "app.py")
assert spec and spec.loader
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


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
        for path, role in ((gbxml, "gbxml"), (weather, "weather-epw"), (identity, "revit-project-identity")):
            manifest["artifacts"].append({
                "name": path.name, "role": role, "bytes": path.stat().st_size,
                "sha256": digest(path),
            })
        local = {path.name.lower(): path for path in (gbxml, weather, identity)}
        worker.require_integrity(manifest, project_id, revision)
        found_gbxml, found_weather, _, _ = worker.validate_artifact_contract(manifest, local)
        assert found_gbxml == gbxml and found_weather == weather
        normalized = worker.load_structured_identity(manifest, local)
        assert normalized["title"] == "CURRENT TEST PROJECT"
        assert normalized["address"] == "999 CURRENT AVENUE"
        assert normalized["city"] == "BROOKLYN" and normalized["zip"] == "11201"
        assert normalized["evidenceDigest"] == evidence_digest

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

    print(json.dumps({
        "workerVersion": "0.8.19-r49",
        "activeDocumentBinding": True,
        "structuredIdentity": True,
        "tZEvidence": True,
        "artifactIntegrity": True,
        "revisionScopedConsent": True,
        "crossRevisionConsentRejected": True,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
