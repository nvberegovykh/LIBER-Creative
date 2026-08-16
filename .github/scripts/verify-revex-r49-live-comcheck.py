#!/usr/bin/env python3
"""Live, non-production clean-project COMcheck acceptance for REVEX.

Uses synthetic project identity/facts only. It proves BOTH sides of the boundary:
1) REVEX emits COMcheck's exact separate project fields (title, street address, city,
   state, ZIP) without concatenating locality into the street-address field; and
2) the official legacy COMcheck-Web service accepts that fresh-project model, calculates
   the envelope backstop, exports clean CheckXML, and returns a genuine PDF.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ENERGY = ROOT / "src" / "Liber.Revex.Revit" / "Engineering" / "Energy"
PIPELINE_PATH = ENERGY / "revex_energy_pipeline.py"
sys.path.insert(0, str(ENERGY))

spec = importlib.util.spec_from_file_location("revex_live_comcheck_pipeline", PIPELINE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Cannot load {PIPELINE_PATH}")
pipeline = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pipeline
spec.loader.exec_module(pipeline)


def child_text(root: ET.Element, name: str) -> str:
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] == name:
            return str(node.text or "").strip()
    return ""


def assert_project_fields(cxl: Path, project: dict, stage: str) -> None:
    root = ET.parse(cxl).getroot()
    expected = {
        "projectTitle": project["title"],
        "projectAddress": project["address"],
        "projectCity": project["city"],
        "projectState": project["state"],
        "projectZipCode": project["zip"],
    }
    actual = {key: child_text(root, key) for key in expected}
    if actual != expected:
        raise RuntimeError(f"{stage}: COMcheck project-field contract mismatch: expected={expected!r}, actual={actual!r}")
    if project["city"].casefold() in actual["projectAddress"].casefold() or project["zip"] in actual["projectAddress"]:
        raise RuntimeError(f"{stage}: projectAddress incorrectly contains city/ZIP instead of street-only identity")


def main() -> int:
    # Synthetic identity deliberately keeps the street address separate from locality.
    # This is the exact shape expected from the generalized active-Revit normalizer.
    project = {
        "title": "REVEX COMCHECK LIVE QA",
        "address": "999 TEST AVENUE",
        "houseNumber": "999",
        "streetName": "TEST AVENUE",
        "borough": "BROOKLYN",
        "city": "BROOKLYN",
        "state": "NY",
        "zip": "11201",
        "block": "9999",
        "lot": "99",
        "bin": "9999999",
        "communityBoard": "2",
        "jobType": "NB",
        "architecturalJobNumber": "QA-ONLY",
        "mechanicalJobNumber": "QA-ONLY",
        "plumbingJobNumber": "QA-ONLY",
        "energyCode": None,
    }
    facts = {
        "status": "COMPLETE",
        "structuredIdentity": {
            "title": project["title"],
            "address": project["address"],
            "city": project["city"],
            "state": project["state"],
            "zip": project["zip"],
            "evidenceDigest": "b" * 64,
            "evidenceSheets": ["T-QA", "Z-QA", "EN-QA"],
        },
        "pages": [
            {
                "pageType": "T", "confidence": 1.0,
                "project": {**project, "title": None},
                "bulk": {"stories": 4, "buildingHeightFt": 55},
            },
            {
                "pageType": "Z", "confidence": 1.0,
                "project": {**project, "address": None, "city": None, "state": None, "zip": None},
                "bulk": {"stories": 4, "buildingHeightFt": 55},
            },
            {
                "pageType": "EN", "confidence": 1.0,
                "project": {"energyCode": "2020 NYC Energy Conservation Code Appendix CA"},
                "envelope": [
                    {
                        "kind": "wall", "assemblyType": "W1_Ext. Wall",
                        "description": "Steel-Framed, 16in. o.c.", "orientation": "NORTH",
                        "grossAreaFt2": 2000, "cavityR": 22, "continuousR": 8, "confidence": 1.0,
                    },
                    {
                        "kind": "window", "assemblyType": "G1.1_Window",
                        "description": "Metal Frame: Operable", "parentAssemblyType": "W1_Ext. Wall",
                        "orientation": "NORTH", "grossAreaFt2": 400,
                        "uFactor": 0.30, "shgc": 0.30, "product": "REVEX QA", "confidence": 1.0,
                    },
                    {
                        "kind": "roof", "assemblyType": "R1_Roof",
                        "description": "Insulation Entirely Above Deck",
                        "continuousR": 30, "confidence": 1.0,
                        "evidence": "R1_Roof R30 current construction",
                    },
                    {"kind": "roof", "assemblyType": "Roof Region R1", "grossAreaFt2": 800, "confidence": 1.0, "evidence": "R1 roof region 800 SF"},
                    {"kind": "roof", "assemblyType": "Roof Region R2", "grossAreaFt2": 700, "confidence": 1.0, "evidence": "R2 roof region 700 SF"},
                    {"kind": "roof", "assemblyType": "Roof Region R3", "grossAreaFt2": 500, "confidence": 1.0, "evidence": "R3 roof region 500 SF"},
                    {
                        "kind": "floor", "assemblyType": "F1_Floor",
                        "description": "Mass Floor", "grossAreaFt2": 2000,
                        "continuousR": 10, "confidence": 1.0,
                    },
                ],
                "lighting": {
                    "wholeBuildingType": "Multifamily",
                    "floorAreaFt2": 8000,
                    "lpdWPerFt2": 0.65,
                    "fixtures": [],
                    "exteriorUses": [],
                },
            },
        ],
    }

    identity = pipeline.current_project_identity(facts)
    if identity.get("missing"):
        raise RuntimeError(f"Synthetic identity unexpectedly incomplete: {identity['missing']}")
    for key in ("title", "address", "city", "state", "zip"):
        if identity.get(key) != project[key]:
            raise RuntimeError(f"Identity normalization changed {key}: {identity.get(key)!r} != {project[key]!r}")

    with tempfile.TemporaryDirectory(prefix="revex-live-comcheck-") as temp:
        folder = Path(temp)
        log = pipeline.RunLog(folder, "live-comcheck", "REVEX live clean COMcheck consumer-contract QA")
        cxl, _audit_pdf, audit = pipeline.prepare_project_comcheck(facts, identity, folder, log)
        if cxl is None or not cxl.is_file() or audit.get("status") != "INPUT_READY":
            raise RuntimeError(f"Synthetic COMcheck input was not ready: {audit}")

        # Prove the generated CheckXML contract before touching the external service.
        assert_project_fields(cxl, project, "REVEX generated CXL")

        from comcheck_backstop import run_official_backstop, BACKSTOP_CODE, _fresh_project_spec

        browser_spec = _fresh_project_spec(cxl)
        expected_spec = {
            "title": project["title"],
            "address": project["address"],
            "projectCity": project["city"],
            "projectState": project["state"],
            "projectZip": project["zip"],
        }
        actual_spec = {key: browser_spec.get(key) for key in expected_spec}
        if actual_spec != expected_spec:
            raise RuntimeError(f"Fresh COMcheck browser model contract mismatch: expected={expected_spec!r}, actual={actual_spec!r}")

        report, response, summary = run_official_backstop(
            cxl,
            folder,
            identity,
            lambda status, **detail: log.write("COMCHECK_LIVE_FULL", status, **detail),
        )
        if not report.is_file() or not report.read_bytes().startswith(b"%PDF-"):
            raise RuntimeError("Official COMcheck did not return a PDF")
        if not response.is_file():
            raise RuntimeError("Official COMcheck calculation evidence is missing")
        if summary.get("officialDoeReport") is not True:
            raise RuntimeError(f"Official report flag missing: {summary}")
        if summary.get("code") != BACKSTOP_CODE:
            raise RuntimeError(f"Wrong backstop path: {summary}")
        if int(summary.get("reportPages") or 0) < 1:
            raise RuntimeError(f"Official report has no pages: {summary}")
        if summary.get("transport") != "FRESH_PROJECT_BROWSER_MODEL":
            raise RuntimeError(f"Legacy CXL upload path was not eliminated: {summary}")

        # COMcheck itself exports the clean project back over cxl. Verify the service preserved
        # exactly the same separated identity fields rather than silently concatenating them.
        assert_project_fields(cxl, project, "Official COMcheck clean export")

        root = ET.parse(cxl).getroot()
        names = [item.tag.rsplit("}", 1)[-1] for item in root.iter()]
        for name, expected in (("agWall", 1), ("window", 1), ("roof", 1), ("floor", 1)):
            actual = names.count(name)
            if actual != expected:
                raise RuntimeError(f"Clean COMcheck export lost {name}: {actual} != {expected}")
        clean_text = cxl.read_text(encoding="utf-8", errors="replace")
        for token in (project["title"], project["address"], project["city"], project["state"], project["zip"],
                      "W1_Ext. Wall", "G1.1_Window", "R1_Roof", "F1_Floor"):
            if token not in clean_text:
                raise RuntimeError(f"Clean COMcheck export lost current evidence token: {token}")

        print("REVEX_COMCHECK_PROJECT_FIELDS_SEPARATE=PASSED")
        print("REVEX_COMCHECK_LIVE_ENDPOINT=PASSED")
        print("REVEX_COMCHECK_FULL_LIVE_SYNTHETIC=PASSED")
        print("REVEX_COMCHECK_UPLOAD_DWR_ELIMINATED=PASSED")
        print("REVEX_COMCHECK_CLEAN_EXPORT=PASSED")
        print(f"REVEX_COMCHECK_REPORT_PAGES={summary['reportPages']}")
        print(f"REVEX_COMCHECK_BACKSTOP_CODE={summary['code']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
