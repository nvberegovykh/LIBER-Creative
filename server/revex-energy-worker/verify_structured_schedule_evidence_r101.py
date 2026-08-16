#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
import tempfile
from pathlib import Path

import revex_structured_schedule_facts as graph
import revex_structured_schedule_projection as projection


def schedule(name, uid, headings, rows, sheet):
    return {
        "name": name,
        "uniqueId": uid,
        "fields": [{"order": i, "columnHeading": h, "name": h, "hidden": False} for i, h in enumerate(headings)],
        "headerRows": [headings],
        "bodyRows": rows,
        "placedOnSheets": [{"sheetNumber": sheet, "sheetName": "fixture", "sheetUniqueId": f"sheet-{sheet}", "instanceUniqueId": f"inst-{uid}"}],
    }


def evidence(height_b="65'-0\""):
    schedules = [
        schedule(
            "Code Matrix Segment", "sched-code-a",
            ["DESCRIPTION", "PERMITTED/REQUIRED PER BC", "PROPOSED"],
            [
                ["Number of Stories above grade plane", "7", "4"],
                ["Building Hight above grade plane", "85'", "65'"],
            ], "G-002.00",
        ),
        schedule(
            "Bulk Verification", "sched-code-b",
            ["Item", "Provided"],
            [["Building Height Above Grade Plane", height_b]], "Z-003.00",
        ),
        schedule(
            "Zoning Area Calculation", "sched-area",
            ["Floor Level", "BC Gross Area", "Gross Area", "Deduction Area", "Zoning Floor Area"],
            [["Totals", "12,906.90 SF", "10,451.65 SF", "1,193.25 SF", "8,795 SF"]], "Z-001.00",
        ),
    ]
    return {
        "schema": "liber.revex.engineering-schedule-evidence.v1",
        "authority": "active-revit-document-native-schedules",
        "scheduleCount": len(schedules), "capturedScheduleCount": len(schedules), "failedScheduleCount": 0,
        "schedules": schedules, "failures": [],
    }


resolved = graph.resolve_core(evidence())
assert resolved["facts"]["buildingHeightFt"]["status"] == "RESOLVED"
assert resolved["facts"]["buildingHeightFt"]["value"] == 65.0
assert resolved["facts"]["buildingHeightFt"]["corroboratingCandidateCount"] == 2
assert {row["scheduleName"] for row in resolved["facts"]["buildingHeightFt"]["candidates"]} == {"Code Matrix Segment", "Bulk Verification"}
assert resolved["facts"]["stories"]["value"] == 4
assert resolved["facts"]["floorAreaFt2"]["value"] == 10451.65

conflict = graph.resolve_core(evidence("66'-0\""))
assert conflict["facts"]["buildingHeightFt"]["status"] == "CONFLICT"
assert set(conflict["facts"]["buildingHeightFt"]["distinctValues"]) == {65.0, 66.0}

with tempfile.TemporaryDirectory(prefix="revex-r101-schedules-") as td:
    root = Path(td)
    schedule_path = root / "engine-REVIT-SCHEDULE-EVIDENCE.json"
    schedule_path.write_text(json.dumps(evidence(), indent=2), encoding="utf-8")
    facts_path = root / "page-facts.json"
    facts_path.write_text(json.dumps({
        "schema": "liber.revex.revit-page-facts.v1",
        "pages": [{
            "pageType": "Z", "sheetNumber": "Z-X", "sheetName": "old page scan", "sourceFile": "old.pdf", "confidence": .99,
            "project": {}, "bulk": {"stories": 9, "buildingHeightFt": 44.0, "grossFloorAreaFt2": 9999.0, "conditionedFloorAreaFt2": None},
            "lighting": {"floorAreaFt2": 9999.0}, "envelope": []
        }],
        "comcheckSemantic": {"floorAreaFt2": 9999.0},
    }, indent=2), encoding="utf-8")
    request_path = root / "request.json"
    request_path.write_text(json.dumps({
        "revision": "eng_fixture", "pageFactsPath": str(facts_path), "sourceArtifacts": [str(schedule_path)], "outputFolder": str(root)
    }, indent=2), encoding="utf-8")
    derived_path = projection.resolve_request(request_path, root)
    assert derived_path != request_path
    request = json.loads(derived_path.read_text(encoding="utf-8"))
    derived = json.loads(Path(request["pageFactsPath"]).read_text(encoding="utf-8"))
    structured = [p for p in derived["pages"] if p.get("sourceAuthority") == "active-revit-document-native-schedules"]
    assert len(structured) == 1
    assert structured[0]["bulk"]["buildingHeightFt"] == 65.0
    assert structured[0]["bulk"]["stories"] == 4
    assert derived["comcheckSemantic"]["floorAreaFt2"] == 10451.65
    old = next(p for p in derived["pages"] if p.get("sheetNumber") == "Z-X")
    assert old["bulk"]["buildingHeightFt"] is None
    assert old["bulk"]["stories"] is None
    assert old["bulk"]["grossFloorAreaFt2"] is None
    assert old["lighting"]["floorAreaFt2"] is None

for module in (Path(graph.__file__), Path(projection.__file__)):
    upper = module.read_text(encoding="utf-8").upper()
    assert "250 MIDWOOD" not in upper
    assert "79 WINTHROP" not in upper
    assert "G-002" not in upper

print(json.dumps({
    "REVEX_R101_STRUCTURED_SCHEDULE_FACT_GRAPH": "PASSED",
    "buildingHeightFt": 65.0,
    "corroboratingSources": 2,
    "conflictStopsGuessing": True,
    "projectSpecificHardcode": False,
    "sheetSpecificHardcode": False,
}))
