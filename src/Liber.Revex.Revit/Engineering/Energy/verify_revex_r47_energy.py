#!/usr/bin/env python3
"""Offline r47 identity, transformer, and official-engine client regression QA."""

from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path
import xml.etree.ElementTree as ET

from openpyxl import load_workbook


HERE = Path(__file__).resolve().parent
PIPELINE_PATH = HERE / "revex_energy_pipeline.py"
SPEC = importlib.util.spec_from_file_location("revex_energy_pipeline_r47", PIPELINE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {PIPELINE_PATH}")
pipeline = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pipeline
SPEC.loader.exec_module(pipeline)


def local_text(root, name: str) -> str:
    node = next((item for item in root.iter() if item.tag.rsplit("}", 1)[-1] == name), None)
    return str(node.text or "").strip() if node is not None else ""


class MockComcheckHandler(BaseHTTPRequestHandler):
    pdf_bytes = b""

    def log_message(self, *_args) -> None:
        return

    def _write(self, body: bytes, content_type: str, status: int = 200, cookie: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.endswith("/index.html"):
            self._write(b"<html>COMcheck test</html>", "text/html", cookie="JSESSIONID=qa; Path=/CheckWeb")
        elif "/report.html?" in self.path:
            self._write(b'<a href="report/current/pdf">Your compliance report</a>', "text/html")
        elif self.path.endswith("/report/current/pdf"):
            self._write(self.pdf_bytes, "application/pdf")
        else:
            self._write(b"not found", "text/plain", 404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        _ = self.rfile.read(length)
        if self.path.endswith("/__System.generateId.dwr"):
            body = b'dwr.engine.remote.handleCallback("0","0","REVEXR47DWRSESSION123456789012345");'
        elif self.path.endswith("/ProjectService.uploadProject.dwr"):
            body = b'dwr.engine.remote.handleCallback("1","0",{projectName:"CURRENT TEST PROJECT"});'
        elif self.path.endswith("/ProjectService.calculateEnvelopeCompliance.dwr"):
            body = b'dwr.engine.remote.handleCallback("2","0",{envelopeStatus:{passes:true,complianceIndex:12.3,statusMessage:"Passes"}});'
        else:
            body = b"dwr.engine.remote.handleBatchException({message:'unexpected test endpoint'},'0');"
        self._write(body, "text/javascript")


def mock_comcheck_pdf(path: Path) -> bytes:
    from reportlab.pdfgen import canvas
    pdf = path / "official-test.pdf"
    page = canvas.Canvas(str(pdf))
    page.drawString(72, 740, "COMcheck-Web Compliance Report")
    page.drawString(72, 720, "2020 NYCECC Appendix CA Modeling Envelope Backstop")
    page.drawString(72, 700, "CURRENT TEST PROJECT — 999 CURRENT AVENUE")
    page.save()
    return pdf.read_bytes()


def main() -> int:
    required = [
        pipeline.EN1_TEMPLATE, pipeline.COMCHECK_CXL_TEMPLATE,
        pipeline.BASELINE_REFERENCE, pipeline.PROPOSED_REFERENCE, pipeline.GEOMETRYCO,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise AssertionError("Missing r47 filing structure dependencies: " + ", ".join(missing))

    z_project = {
        "title": "CURRENT TEST PROJECT", "address": "999 CURRENT AVENUE",
        "houseNumber": "999", "streetName": "CURRENT AVENUE", "borough": "BROOKLYN",
        "city": "BROOKLYN", "state": "NY", "zip": "11201", "block": "1234",
        "lot": "56", "bin": "9876543", "communityBoard": "2", "jobType": "ALT-CO",
        "architecturalJobNumber": "A0001", "mechanicalJobNumber": "M0002",
        "plumbingJobNumber": "P0003", "energyCode": None,
    }
    facts = {
        "status": "COMPLETE",
        "pages": [
            {"pageType": "Z", "confidence": 1.0, "project": z_project,
             "bulk": {"stories": 4, "buildingHeightFt": 55}},
            {"pageType": "EN", "confidence": 1.0,
             "project": {"title": "FORBIDDEN EN IDENTITY", "address": "DO NOT COPY",
                         "energyCode": "2020 NYC Energy Conservation Code - NYC Stretch"},
             "envelope": [
                 {"kind": "wall", "assemblyType": "steel framed", "description": "CURRENT WALL",
                  "orientation": "N", "grossAreaFt2": 1000, "cavityR": 19, "continuousR": 5, "confidence": 1},
                 {"kind": "roof", "assemblyType": "insulation entirely above deck", "description": "CURRENT ROOF",
                  "grossAreaFt2": 500, "continuousR": 30, "confidence": 1},
                 {"kind": "floor", "assemblyType": "mass", "description": "CURRENT FLOOR",
                  "grossAreaFt2": 500, "continuousR": 10, "confidence": 1},
             ],
             "lighting": {"wholeBuildingType": "Multifamily", "floorAreaFt2": 2000,
                          "lpdWPerFt2": 0.65,
                          "fixtures": [{"description": "CURRENT FIXTURE", "wattage": 20,
                                        "quantity": 65, "confidence": 1}],
                          "exteriorUses": []}},
        ],
    }
    identity = pipeline.current_project_identity(facts)
    assert not identity["missing"], identity["missing"]
    assert identity["title"] == z_project["title"]
    assert identity["address"] == z_project["address"]
    assert "FORBIDDEN" not in str(identity)

    consent = {
        "schema": pipeline.COMCHECK_CONSENT_SCHEMA,
        "projectId": "project_qa",
        "sourceEngineeringRevision": "eng_qa_immutable_001",
        "service": pipeline.COMCHECK_SERVICE,
        "endpoint": pipeline.COMCHECK_ENDPOINT,
        "scope": pipeline.COMCHECK_SCOPE,
        "approved": True,
        "approvedAt": datetime.now(timezone.utc).isoformat(),
        "approvedByUid": "user_qa",
        "immutable": True,
    }
    try:
        pipeline.require_comcheck_consent({}, "project_qa", "eng_qa_immutable_001")
        raise AssertionError("Missing consent was accepted")
    except pipeline.PipelineError:
        pass
    try:
        pipeline.require_comcheck_consent(consent, "project_qa", "eng_different")
        raise AssertionError("Consent for a different immutable revision was accepted")
    except pipeline.PipelineError:
        pass
    assert pipeline.require_comcheck_consent(consent, "project_qa", "eng_qa_immutable_001") == consent

    workbook = load_workbook(pipeline.EN1_TEMPLATE)
    info = workbook["1,2,3 Information"]
    pipeline.blank_en1_identity_fields(info)
    pipeline.apply_en1_project_identity(info, identity)
    pipeline.assert_en1_identity_fields_blank(info)
    pipeline.assert_en1_project_identity(info, identity)
    pipeline.assert_no_reference_identity_workbook(workbook)
    assert "999" in str(info["B5"].value)
    assert "CURRENT AVENUE" in str(info["C5"].value)
    with tempfile.TemporaryDirectory(prefix="revex-r47-en1-qa-") as temp:
        transformed = Path(temp) / "EN-1_CURRENT_PROJECT.xlsx"
        workbook.save(transformed)
        pipeline.assert_no_reference_identity_xlsx(transformed)

    with tempfile.TemporaryDirectory(prefix="revex-r47-energy-qa-") as temp:
        folder = Path(temp)
        log = pipeline.RunLog(folder, "r47-offline-qa", "release QA")
        cxl, audit_pdf, audit = pipeline.prepare_project_comcheck(facts, identity, folder, log)
        assert audit["status"] == "INPUT_READY", audit
        assert audit["officialDoeReport"] is None, "Input preparation must not record a failed official report."
        assert audit["officialDoeReportStatus"] == "NOT_RUN"
        assert cxl and cxl.is_file()
        assert audit_pdf.is_file()
        root = ET.parse(cxl).getroot()
        assert local_text(root, "projectTitle") == z_project["title"]
        assert local_text(root, "projectAddress") == z_project["address"]
        assert local_text(root, "projectCity") == z_project["city"]
        assert local_text(root, "projectState") == z_project["state"]
        assert local_text(root, "projectZipCode") == z_project["zip"]
        assert local_text(root, "floorArea") == "2000.000"
        assert "FORBIDDEN EN IDENTITY" not in cxl.read_text(encoding="utf-8")

        stamped_models = []
        for role, source in (("BASELINE", pipeline.BASELINE_REFERENCE), ("PROPOSED", pipeline.PROPOSED_REFERENCE)):
            stamped = folder / f"{role}_CURRENT_PROJECT.osm"
            shutil.copy2(source, stamped)
            pipeline.stamp_compiled_project_identity(stamped, identity, role, log)
            stamped_text = stamped.read_text(encoding="utf-8")
            assert z_project["title"] in stamped_text
            pipeline.assert_no_reference_identity_text(stamped_text, f"{role} QA model")
            stamped_models.append(stamped)

        MockComcheckHandler.pdf_bytes = mock_comcheck_pdf(folder)
        server = ThreadingHTTPServer(("127.0.0.1", 0), MockComcheckHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        os.environ["REVEX_ALLOW_COMCHECK_TEST_ENDPOINT"] = "true"
        try:
            from comcheck_backstop import run_official_backstop
            report, response, official = run_official_backstop(
                cxl, folder, identity,
                lambda status, **detail: log.write("COMCHECK_BACKSTOP_QA", status, **detail),
                base_url=f"http://127.0.0.1:{server.server_port}/CheckWeb/"
            )
        finally:
            server.shutdown()
            server.server_close()
            os.environ.pop("REVEX_ALLOW_COMCHECK_TEST_ENDPOINT", None)
        assert report.is_file() and report.read_bytes().startswith(b"%PDF-")
        assert response.is_file()
        assert official["officialDoeReport"] is True
        assert official["code"] == "2020 NYCECC Appendix CA Modeling Envelope Backstop"
        compiled = folder / "02_COMPILED_MODELS"
        baseline_run_dir = folder / "03_SIMULATION" / "BASELINE"
        proposed_run_dir = folder / "03_SIMULATION" / "PROPOSED"
        compiled.mkdir(parents=True)
        baseline_run_dir.mkdir(parents=True)
        proposed_run_dir.mkdir(parents=True)
        baseline_osm = compiled / "BASELINE_UPDATED_GEOMETRY.osm"
        proposed_osm = compiled / "PROPOSED_UPDATED_GEOMETRY.osm"
        for path in (baseline_osm, proposed_osm):
            path.write_text("OS:Building,\n" + ("REVEX-CURRENT-MODEL\n" * 300), encoding="utf-8")
        runs = []
        for run_dir in (baseline_run_dir, proposed_run_dir):
            html = run_dir / "eplustbl.html"
            idf = run_dir / "in.idf"
            html.write_text("<html>" + ("current simulation " * 40) + "</html>", encoding="utf-8")
            idf.write_text("Version,24.2;\n" + ("!- current model\n" * 40), encoding="utf-8")
            (run_dir / "eplusout.end").write_text("EnergyPlus Completed Successfully-- 0 Warning; 0 Severe Errors;", encoding="utf-8")
            runs.append({"folder": run_dir, "html": html, "idf": idf})
        en1_pdf = folder / "EN-1_READY_TO_INSERT.pdf"
        en1_pdf.write_bytes(MockComcheckHandler.pdf_bytes)
        completion = pipeline.validate_completion_outputs(
            baseline_osm, proposed_osm, runs[0], runs[1], en1_pdf, cxl, report, official
        )
        assert completion["compiledOsmCount"] == 2
        assert completion["officialDoeReport"] is True

    print({
        "zIdentityOnly": True,
        "applicantBlank": True,
        "modelerBlank": True,
        "referenceIdentityExcluded": True,
        "currentEnTechnicalFacts": True,
        "compiledModelIdentityFromZPages": True,
        "comcheckInputReady": True,
        "officialBackstopClient": True,
        "missingConsentRejected": True,
        "wrongRevisionConsentRejected": True,
        "exactRevisionConsentAccepted": True,
        "compiledOsmCompletionGate": True,
        "filingSheets": len(pipeline.EN1_PRINT_SHEETS),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
