#!/usr/bin/env python3
"""Live, non-production clean-project COMcheck acceptance for REVEX r49.

Uses synthetic NYC project identity/facts only. It proves the official service can
translate current EN facts into a fresh project, calculate the envelope backstop,
export clean CheckXML, and return a genuine PDF before production work begins.
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

spec = importlib.util.spec_from_file_location("revex_r49_live_comcheck_pipeline", PIPELINE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Cannot load {PIPELINE_PATH}")
pipeline = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pipeline
spec.loader.exec_module(pipeline)


def main() -> int:
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
                        "description": "Insulation Entirely Above Deck", "grossAreaFt2": 2000,
                        "continuousR": 30, "confidence": 1.0,
                    },
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

    with tempfile.TemporaryDirectory(prefix="revex-r49-live-comcheck-") as temp:
        folder = Path(temp)
        log = pipeline.RunLog(folder, "r49-live-comcheck", "REVEX live clean COMcheck transport QA")
        cxl, _audit_pdf, audit = pipeline.prepare_project_comcheck(facts, identity, folder, log)
        if cxl is None or not cxl.is_file() or audit.get("status") != "INPUT_READY":
            raise RuntimeError(f"Synthetic COMcheck input was not ready: {audit}")

        from comcheck_backstop import run_official_backstop, BACKSTOP_CODE

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

        root = ET.parse(cxl).getroot()
        names = [item.tag.rsplit("}", 1)[-1] for item in root.iter()]
        for name, expected in (("agWall", 1), ("window", 1), ("roof", 1), ("floor", 1)):
            actual = names.count(name)
            if actual != expected:
                raise RuntimeError(f"Clean COMcheck export lost {name}: {actual} != {expected}")
        clean_text = cxl.read_text(encoding="utf-8", errors="replace")
        for token in (project["title"], "W1_Ext. Wall", "G1.1_Window", "R1_Roof", "F1_Floor"):
            if token not in clean_text:
                raise RuntimeError(f"Clean COMcheck export lost current evidence token: {token}")

        print("REVEX_COMCHECK_FULL_LIVE_SYNTHETIC=PASSED")
        print("REVEX_COMCHECK_UPLOAD_DWR_ELIMINATED=PASSED")
        print("REVEX_COMCHECK_CLEAN_EXPORT=PASSED")
        print(f"REVEX_COMCHECK_REPORT_PAGES={summary['reportPages']}")
        print(f"REVEX_COMCHECK_BACKSTOP_CODE={summary['code']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
