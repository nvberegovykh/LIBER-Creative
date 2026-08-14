#!/usr/bin/env python3
"""Offline r49 identity, transformer, and official-engine client regression QA."""

from __future__ import annotations

import importlib.util
from collections import Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

from openpyxl import load_workbook


HERE = Path(__file__).resolve().parent
PIPELINE_PATH = HERE / "revex_energy_pipeline.py"
SPEC = importlib.util.spec_from_file_location("revex_energy_pipeline_r49", PIPELINE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {PIPELINE_PATH}")
pipeline = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pipeline
SPEC.loader.exec_module(pipeline)


def local_text(root, name: str) -> str:
    node = next((item for item in root.iter() if item.tag.rsplit("}", 1)[-1] == name), None)
    return str(node.text or "").strip() if node is not None else ""


LOAD_TYPES = (
    "OS:People", "OS:Lights", "OS:ElectricEquipment", "OS:GasEquipment",
    "OS:SteamEquipment", "OS:OtherEquipment", "OS:InternalMass",
    "OS:SpaceInfiltration", "OS:DesignSpecification:OutdoorAir",
)
HVAC_TYPES = (
    "OS:PlantLoop", "OS:AirLoopHVAC", "OS:ZoneHVAC", "OS:Coil", "OS:Fan",
    "OS:Boiler", "OS:Chiller", "OS:Pump", "OS:HeatExchanger", "OS:WaterHeater",
)


def behavior_inventory(compiler, model_path: Path) -> dict:
    counts = Counter(obj.obj_type for obj in compiler.parse_osm(model_path).objects)
    return {
        "schedules": {key: value for key, value in sorted(counts.items()) if key.startswith("OS:Schedule")},
        "loads": {key: value for key, value in sorted(counts.items()) if key.startswith(LOAD_TYPES)},
        "systems": {key: value for key, value in sorted(counts.items()) if key.startswith(HVAC_TYPES)},
    }


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
            body = b'dwr.engine.remote.handleCallback("0","0","REVEXR49DWRSESSION123456789012345");'
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


def mock_en1_pdf(path: Path) -> bytes:
    from reportlab.pdfgen import canvas
    pdf = path / "EN-1_READY_TO_INSERT.pdf"
    page = canvas.Canvas(str(pdf))
    for index, sheet in enumerate(pipeline.EN1_PRINT_SHEETS, start=1):
        page.drawString(72, 740, f"EN-1 CURRENT TEST PROJECT — filing sheet {index}/16")
        page.drawString(72, 720, sheet)
        page.showPage()
    page.save()
    return pdf.read_bytes()


def main() -> int:
    required = [
        pipeline.EN1_TEMPLATE, pipeline.COMCHECK_CXL_TEMPLATE,
        pipeline.BASELINE_REFERENCE, pipeline.PROPOSED_REFERENCE, pipeline.GEOMETRYCO,
        pipeline.PACKAGER,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise AssertionError("Missing r49 filing structure dependencies: " + ", ".join(missing))

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
        "structuredIdentity": {
            "title": "CURRENT TEST PROJECT", "address": "999 CURRENT AVENUE",
            "city": "BROOKLYN", "state": "NY", "zip": "11201",
            "evidenceDigest": "a" * 64, "evidenceSheets": ["T001 · TITLE", "Z001 · ZONING"],
        },
        "pages": [
            {"pageType": "T", "confidence": 0.99, "project": {**z_project, "title": None},
             "bulk": {"stories": 4, "buildingHeightFt": 55}},
            {"pageType": "Z", "confidence": 1.0, "project": {**z_project, "address": None, "city": None, "state": None, "zip": None},
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
    assert identity["evidenceDigest"] == "a" * 64
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
    with tempfile.TemporaryDirectory(prefix="revex-r49-en1-qa-") as temp:
        transformed = Path(temp) / "EN-1_CURRENT_PROJECT.xlsx"
        workbook.save(transformed)
        pipeline.assert_no_reference_identity_xlsx(transformed)

    with tempfile.TemporaryDirectory(prefix="revex-r49-energy-qa-") as temp:
        folder = Path(temp)
        log = pipeline.RunLog(folder, "r49-offline-qa", "release QA")
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
        assert {local_text(node, "grossArea") for node in root.iter() if node.tag.rsplit("}", 1)[-1] in ("agWall", "roof", "floor")} == {"1000.000", "500.000"}
        assert "1991.000" not in cxl.read_text(encoding="utf-8"), "Template model areas must not survive into the current-project CXL."
        assert local_text(root, "powerDensity") == "0.650000"
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
        compiler = pipeline.load_module(pipeline.GEOMETRYCO, "revex_geometryco_record_contract_qa")
        compiled = folder / "02_COMPILED_MODELS"
        compilation = compiler.compile_baseline_proposed_pair(
            pipeline.BASELINE_REFERENCE,
            pipeline.BASELINE_REFERENCE,
            pipeline.PROPOSED_REFERENCE,
            compiled,
            require_native_check=False,
        )
        assert compilation["success"] is True
        expected_geometry = {"spaces": 159, "surfaces": 1930, "subsurfaces": 294}
        expected_schedules = {"baseline": 243, "proposed": 89}
        expected_systems = {"baseline": 13, "proposed": 18}
        reference_paths = {"baseline": pipeline.BASELINE_REFERENCE, "proposed": pipeline.PROPOSED_REFERENCE}
        output_paths = {
            "baseline": compiled / "BASELINE_UPDATED_GEOMETRY.osm",
            "proposed": compiled / "PROPOSED_UPDATED_GEOMETRY.osm",
        }
        for role in ("baseline", "proposed"):
            role_report = compilation["reports"][role]
            assert role_report["exact_geometry_lock"]["passed"] is True
            assert role_report["exact_geometry_lock"]["new_space_identity_passed"] is True
            assert {key: role_report["exact_geometry_lock"][key] for key in expected_geometry} == expected_geometry
            assert role_report["space_mapping"]["count"] == 159
            assert role_report["space_mapping"]["ambiguous_count"] == 0
            assert role_report["schedule_lock"]["passed"] is True
            assert role_report["schedule_lock"]["changed_schedule_objects"] == 0
            assert role_report["schedule_lock"]["changed_protected_schedule_references"] == 0
            assert role_report["serialized_roundtrip_validation"]["passed"] is True
            repairs = role_report.get("energyplus_compatibility_repairs") or {"count": 0, "lossless": True}
            assert repairs.get("lossless") is True
            before = behavior_inventory(compiler, reference_paths[role])
            after = behavior_inventory(compiler, output_paths[role])
            assert after == before, f"{role} schedules, loads, or HVAC/system inventory changed"
            assert sum(after["schedules"].values()) == expected_schedules[role]
            assert sum(after["systems"].values()) == expected_systems[role]
            pipeline.stamp_compiled_project_identity(output_paths[role], identity, role.upper(), log)

        baseline_run_dir = folder / "03_SIMULATION" / "BASELINE"
        proposed_run_dir = folder / "03_SIMULATION" / "PROPOSED"
        baseline_run_dir.mkdir(parents=True)
        proposed_run_dir.mkdir(parents=True)
        baseline_osm = output_paths["baseline"]
        proposed_osm = output_paths["proposed"]
        runs = []
        for run_dir in (baseline_run_dir, proposed_run_dir):
            html = run_dir / "eplustbl.html"
            idf = run_dir / "in.idf"
            html.write_text("<html><head><title>CURRENT TEST PROJECT</title></head><body><p>Building: CURRENT TEST PROJECT</p>" + ("current simulation " * 40) + "</body></html>", encoding="utf-8")
            idf.write_text("Version,24.2;\n" + ("!- current model\n" * 40), encoding="utf-8")
            (run_dir / "eplusout.err").write_text("Program Version,EnergyPlus, Version 24.2\n************* EnergyPlus Completed Successfully-- 0 Warning; 0 Severe Errors; Elapsed Time=00hr 00min 01.00sec", encoding="utf-8")
            (run_dir / "eplusout.end").write_text("EnergyPlus Completed Successfully-- 0 Warning; 0 Severe Errors;", encoding="utf-8")
            runs.append({"folder": run_dir, "html": html, "idf": idf})

        packager = pipeline.load_module(pipeline.PACKAGER, "revex_record_review_packager_qa")
        review_dir = folder / "04_REVIEW_PACKAGE"
        review_zip = Path(packager.generate_package(
            str(runs[0]["html"]), str(runs[1]["html"]), str(review_dir),
            z_project["title"], True, standard_version="NYCECC 2020",
            baseline_model_file=str(runs[0]["idf"]), proposed_model_file=str(runs[1]["idf"]),
        ))
        expected_review_names = {f"{z_project['title']} - {label}.pdf" for label in pipeline.REVIEW_PACKAGE_PDF_LABELS}
        with zipfile.ZipFile(review_zip) as package:
            assert {Path(name).name for name in package.namelist() if not name.endswith("/")} == expected_review_names

        en1_pdf = folder / "EN-1_READY_TO_INSERT.pdf"
        en1_pdf.write_bytes(mock_en1_pdf(folder))
        completion = pipeline.validate_completion_outputs(
            baseline_osm, proposed_osm, runs[0], runs[1], review_zip, z_project["title"],
            en1_pdf, cxl, report, official
        )
        assert completion["compiledOsmCount"] == 2
        assert completion["officialDoeReport"] is True
        assert completion["reviewPackagePdfCount"] == 9

        approved_metrics = {
            "modeledSquareFeet": pipeline.APPROVED_RUN_PROFILE["modeledSquareFeet"],
            "conditionedSquareFeet": pipeline.APPROVED_RUN_PROFILE["conditionedSquareFeet"],
        }
        for role in ("baseline", "proposed"):
            expected = pipeline.APPROVED_RUN_PROFILE["roles"][role]
            approved_metrics[role] = {
                "siteKbtu": expected["siteKbtu"],
                "siteEuiKbtuPerFt2": expected["siteEuiKbtuPerFt2"],
                "electricKwh": expected["electricKwh"],
                "gasTherm": expected["gasTherm"],
                "unmetHours": expected["unmetHours"],
                "cost": 40402.0 if role == "baseline" else 25556.0,
                "endUses": {label: {"sharePct": value} for label, value in expected["endUseSharePct"].items()},
            }
        approved_comparison = pipeline.compare_approved_run_profile(
            approved_metrics, compiled / "COMPILATION_AUDIT.json", baseline_osm
        )
        assert approved_comparison["status"] == "PASSED", approved_comparison
        assert approved_comparison["iterationSelection"] == "BEST_WORKING_ITERATION"
        regressed_metrics = json.loads(json.dumps(approved_metrics))
        regressed_metrics["proposed"]["siteKbtu"] *= 1.20
        regressed_metrics["proposed"]["siteEuiKbtuPerFt2"] *= 1.20
        regression = pipeline.compare_approved_run_profile(
            regressed_metrics, compiled / "COMPILATION_AUDIT.json", baseline_osm
        )
        assert regression["status"] == "REGRESSION", regression
        assert regression["reviewEligible"] is False

        geometry_dir = folder / "01_ORIGINAL_MODELS"
        geometry_dir.mkdir()
        geometry_osm = geometry_dir / "REVIT_GEOMETRY_ORIGINAL.osm"
        shutil.copy2(baseline_osm, geometry_osm)
        en1_xlsx = folder / "EN-1_READY_TO_INSERT.xlsx"
        review_workbook = load_workbook(pipeline.EN1_TEMPLATE)
        review_info = review_workbook["1,2,3 Information"]
        pipeline.blank_en1_identity_fields(review_info)
        pipeline.apply_en1_project_identity(review_info, identity)
        review_workbook.save(en1_xlsx)
        review_workbook.close()
        pipeline.assert_no_reference_identity_xlsx(en1_xlsx)
        review_artifacts = [
            pipeline.relative_artifact(path, folder, kind)
            for path, kind in (
                (geometry_osm, "geometry-osm"),
                (baseline_osm, "baseline-osm"),
                (proposed_osm, "proposed-osm"),
                (runs[0]["html"], "baseline-html"),
                (runs[1]["html"], "proposed-html"),
                (en1_xlsx, "en1-spreadsheet"),
                (report, "official-comcheck-pdf"),
                (review_zip, "packager-reports-archive"),
            )
        ]
        assert tuple(artifact["kind"] for artifact in review_artifacts) == pipeline.VALID_ENERGY_REVIEW_PACKAGE
        manual_package = pipeline.create_manual_review_package(folder, review_artifacts, {
            "schema": "liber.revex.energy-manual-review-package.v1",
            "projectName": z_project["title"],
            "referenceTemplatesIncluded": False,
            "referenceIdentityExcluded": True,
            "files": review_artifacts,
        })
        with zipfile.ZipFile(manual_package) as package:
            names = {name for name in package.namelist() if not name.endswith("/")}
            assert len(names) == 8
            assert {artifact["path"] for artifact in review_artifacts}.issubset(names)
            index = json.loads(package.comment)
            assert index["referenceTemplatesIncluded"] is False
            assert index["referenceIdentityExcluded"] is True

    print({
        "activeRevitTzIdentityOnly": True,
        "applicantBlank": True,
        "modelerBlank": True,
        "referenceIdentityExcluded": True,
        "currentEnTechnicalFacts": True,
        "compiledModelIdentityFromActiveRevitTzEvidence": True,
        "comcheckInputReady": True,
        "officialBackstopClient": True,
        "missingConsentRejected": True,
        "wrongRevisionConsentRejected": True,
        "exactRevisionConsentAccepted": True,
        "compiledOsmCompletionGate": True,
        "approvedRecordGeometryCounts": {"spaces": 159, "surfaces": 1930, "subsurfaces": 294, "thermalZones": 2},
        "baselineScheduleObjects": 243,
        "proposedScheduleObjects": 89,
        "baselineHvacSystemObjects": 13,
        "proposedHvacSystemObjects": 18,
        "loadsAndSystemsInventoryPreserved": True,
        "approvedNinePdfReviewFormat": True,
        "maskedApprovedRunComparison": True,
        "referenceRegressionWithholdsReviewCandidate": True,
        "userReviewContractItems": 8,
        "productionUserArtifactsExactlySevenFilesPlusOneArchive": True,
        "manualReviewPackageBesideRun": True,
        "manualReviewPackageExcludesProtectedReferences": True,
        "filingSheets": len(pipeline.EN1_PRINT_SHEETS),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
