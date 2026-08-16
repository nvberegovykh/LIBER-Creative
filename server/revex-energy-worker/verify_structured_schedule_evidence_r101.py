#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import revex_structured_schedule_facts as graph
import revex_structured_schedule_projection as projection


def schedule(name, uid, field_headings, rows, sheet, header_rows=None):
    return {
        "name": name,
        "uniqueId": uid,
        "fields": [{"order": i, "columnHeading": h, "name": h, "hidden": False} for i, h in enumerate(field_headings)],
        "headerRows": header_rows if header_rows is not None else [field_headings],
        "bodyRows": rows,
        "placedOnSheets": [{"sheetNumber": sheet, "sheetName": "fixture", "sheetUniqueId": f"sheet-{sheet}", "instanceUniqueId": f"inst-{uid}"}],
    }


def evidence(height_b="65'-0\"", second_code=None):
    schedules = [
        # Deliberately generic native field names: the semantic headings are visible
        # only in the multi-row Revit table header. Runtime must follow the table.
        schedule(
            "Code Matrix Segment", "sched-code-a",
            ["Text", "Text", "Text"],
            [
                ["Number of Stories above grade plane", "7", "4"],
                ["Building Hight above grade plane", "85'", "65'"],
                ["Energy Conservation Code", "", "2020 NYCECC Appendix CA"],
            ], "SHEET-A",
            header_rows=[
                ["Table", "Code Limit", "Current Design"],
                ["DESCRIPTION", "PERMITTED / REQUIRED PER BC", "PROPOSED"],
            ],
        ),
        schedule(
            "Bulk Verification", "sched-code-b",
            ["Item", "Provided"],
            [["Building Height Above Grade Plane", height_b]], "SHEET-B",
        ),
        schedule(
            "Zoning Area Calculation", "sched-area",
            ["Floor Level", "BC Gross Area", "Gross Area", "Deduction Area", "Zoning Floor Area"],
            [["Totals", "12,906.90 SF", "10,451.65 SF", "1,193.25 SF", "8,795 SF"]], "SHEET-C",
        ),
    ]
    if second_code:
        schedules.append(schedule(
            "Energy Notes", "sched-energy-b", ["Requirement", "Value"],
            [["Energy code", second_code]], "SHEET-D",
        ))
    return {
        "schema": "liber.revex.engineering-schedule-evidence.v1",
        "authority": "active-revit-document-native-schedules",
        "scheduleCount": len(schedules), "capturedScheduleCount": len(schedules), "failedScheduleCount": 0,
        "schedules": schedules, "failures": [],
    }


resolved = graph.resolve_core(evidence())
assert resolved["facts"]["energyCode"]["status"] == "RESOLVED"
assert resolved["facts"]["energyCode"]["value"] == "2020 NYCECC"
assert resolved["facts"]["buildingHeightFt"]["status"] == "RESOLVED"
assert resolved["facts"]["buildingHeightFt"]["value"] == 65.0
assert resolved["facts"]["buildingHeightFt"]["corroboratingCandidateCount"] == 2
assert {row["scheduleName"] for row in resolved["facts"]["buildingHeightFt"]["candidates"]} == {"Code Matrix Segment", "Bulk Verification"}
assert resolved["facts"]["stories"]["value"] == 4
assert resolved["facts"]["floorAreaFt2"]["value"] == 10451.65

height_conflict = graph.resolve_core(evidence("66'-0\""))
assert height_conflict["facts"]["buildingHeightFt"]["status"] == "CONFLICT"
assert set(height_conflict["facts"]["buildingHeightFt"]["distinctValues"]) == {65.0, 66.0}

code_conflict = graph.resolve_core(evidence(second_code="2025 NYCECC"))
assert code_conflict["facts"]["energyCode"]["status"] == "CONFLICT"
assert set(code_conflict["facts"]["energyCode"]["distinctValues"]) == {"2020 NYCECC", "2025 NYCECC"}

with tempfile.TemporaryDirectory(prefix="revex-r102-schedules-") as td:
    root = Path(td)
    schedule_path = root / "engine-REVIT-SCHEDULE-EVIDENCE.json"
    schedule_path.write_text(json.dumps(evidence(), indent=2), encoding="utf-8")
    facts_path = root / "page-facts.json"
    facts_path.write_text(json.dumps({
        "schema": "liber.revex.revit-page-facts.v1",
        "pages": [{
            "pageType": "Z", "sheetNumber": "Z-X", "sheetName": "old page scan", "sourceFile": "old.pdf", "confidence": .99,
            "project": {"energyCode": "2016 NYCECC"},
            "bulk": {"stories": 9, "buildingHeightFt": 44.0, "grossFloorAreaFt2": 9999.0, "conditionedFloorAreaFt2": None},
            "lighting": {"floorAreaFt2": 9999.0}, "envelope": []
        }],
        "comcheckSemantic": {"floorAreaFt2": 9999.0, "energyCode": "2016 NYCECC"},
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
    assert structured[0]["project"]["energyCode"] == "2020 NYCECC"
    assert structured[0]["bulk"]["buildingHeightFt"] == 65.0
    assert structured[0]["bulk"]["stories"] == 4
    assert derived["comcheckSemantic"]["energyCode"] == "2020 NYCECC"
    assert derived["comcheckSemantic"]["floorAreaFt2"] == 10451.65
    old = next(p for p in derived["pages"] if p.get("sheetNumber") == "Z-X")
    assert old["project"]["energyCode"] is None
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
    "REVEX_R102_STRUCTURED_SCHEDULE_FACT_GRAPH": "PASSED",
    "energyCode": "2020 NYCECC",
    "buildingHeightFt": 65.0,
    "corroboratingHeightSources": 2,
    "multiRowHeaderSemantic": True,
    "conflictsStopGuessing": True,
    "projectSpecificHardcode": False,
    "sheetSpecificHardcode": False,
}))
