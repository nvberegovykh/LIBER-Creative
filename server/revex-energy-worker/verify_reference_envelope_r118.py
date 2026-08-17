#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile

import revex_reference_envelope_projection_r118 as ref

REFERENCE = (
    Path(__file__).resolve().parents[2]
    / "src/Liber.Revex.Revit/Engineering/Energy/References/79_WINTHROP_APPROVED_PROPOSED.osm"
)
profiles = ref._approved_profiles(REFERENCE)
assert profiles["window"]["construction"] == "WIN_EXT_TRIPLE_LOW_E"
assert profiles["door"]["construction"] == "DOOR_EXT"
assert profiles["window"]["uFactor"] == 0.30
assert profiles["window"]["shgc"] == 0.30
assert profiles["window"]["vt"] == 0.45
assert profiles["door"]["uFactor"] == 0.30
assert profiles["door"]["shgc"] == 0.30
assert profiles["door"]["vt"] == 0.45
assert profiles["window"]["handle"] == profiles["door"]["handle"]

missing_windows = [
    ("G11.1", "WEST", 25.0),
    ("G11.2", "EAST", 96.0),
    ("G11.3", "NORTH", 83.0),
    ("G11.4", "NORTH", 87.0),
    ("G11.5", "EAST", 87.0),
    ("G11.6", "EAST", 28.0),
]
missing_doors = [
    ("D11.1", "EAST", 24.0),
    ("D11.2", "NORTH", 23.0),
    ("D12.1", "WEST", 48.0),
]
rows = [
    # Current EN thermal rows only corroborate equivalence. Their values are never copied
    # into the missing detailed tags; the applied values are read from the approved OSM.
    {"kind":"window","assemblyType":"G1.1","description":"Triple Pane Casement Window","orientation":None,"grossAreaFt2":None,"uFactor":0.30,"shgc":0.30,"cavityR":None,"continuousR":None,"confidence":0.99,"evidence":"G1.1 U 0.30 SHGC 0.30"},
    {"kind":"door","assemblyType":"D4.1","description":"Exterior LOW-E Glass Door","orientation":None,"grossAreaFt2":None,"uFactor":0.30,"shgc":0.30,"cavityR":None,"continuousR":None,"confidence":0.99,"evidence":"D4.1 glass door U 0.30 SHGC 0.30"},
]
for code, orientation, area in missing_windows:
    rows.append({"kind":"window","assemblyType":code,"description":f"{code} Window Fixed","orientation":orientation,"grossAreaFt2":area,"uFactor":None,"shgc":None,"cavityR":None,"continuousR":None,"confidence":0.99,"evidence":f"{code} Window Fixed {area:g} SF"})
for code, orientation, area in missing_doors:
    rows.append({"kind":"door","assemblyType":code,"description":f"{code} Glass Door Operable","orientation":orientation,"grossAreaFt2":area,"uFactor":None,"shgc":None,"cavityR":None,"continuousR":None,"confidence":0.99,"evidence":f"{code} Glass Door Operable {area:g} SF"})

facts = {
    "pages": [{
        "pageType":"EN",
        "sheetNumber":"EN-005.00",
        "sheetName":"THERMAL BOUNDARY & FENESTRATION DIAGRAMS",
        "sourceFile":"REVIT_PAGE_EN_EN-005.00_THERMAL_BOUNDARY_FENESTRATION_DIAGRAMS.pdf",
        "confidence":0.99,
        "envelope": rows,
    }]
}

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    facts_path = root / "facts.json"
    facts_path.write_text(json.dumps(facts), encoding="utf-8")
    request_path = root / "request.json"
    request_path.write_text(json.dumps({
        "revision":"eng_20260817T032812010Z",
        "projectId":"revex_fixture",
        "projectName":"Current Project",
        "pageFactsPath":str(facts_path),
        "outputFolder":str(root / "out"),
    }), encoding="utf-8")
    output = root / "out"
    resolved = ref.resolve_request(request_path, output)
    assert resolved != request_path
    request = json.loads(resolved.read_text(encoding="utf-8"))
    derived = json.loads(Path(request["pageFactsPath"]).read_text(encoding="utf-8"))
    audit = json.loads((output / "REFERENCE_ENVELOPE_PROJECTION_R118.json").read_text(encoding="utf-8"))

    filled = {row["code"]: row for row in audit["filled"]}
    expected = {code for code, _, _ in missing_windows + missing_doors}
    assert set(filled) == expected, (set(filled), expected)
    assert audit["currentProjectCxlUsedAsThermalAuthority"] is False
    assert audit["referenceProjectIdentityCopied"] is False
    assert audit["referenceProjectQuantitiesCopied"] is False
    assert audit["sourceEvidenceMutated"] is False

    derived_rows = derived["pages"][0]["envelope"]
    thermal_by_code = {}
    geometry_by_code = {}
    for row in derived_rows:
        code, _ = ref._row_code(row)
        if not code:
            continue
        if row.get("uFactor") not in (None, ""):
            thermal_by_code.setdefault(code, []).append(row)
        if row.get("grossAreaFt2") not in (None, "") and row.get("uFactor") in (None, ""):
            geometry_by_code.setdefault(code, []).append(row)

    for code, orientation, area in missing_windows + missing_doors:
        projected = [r for r in thermal_by_code.get(code, []) if r.get("referenceEnvelopeAuthority")]
        assert len(projected) == 1, code
        assert projected[0]["uFactor"] == 0.30, code
        assert projected[0]["shgc"] == 0.30, code
        assert projected[0]["vt"] == 0.45, code
        assert projected[0]["sourceFile"] == "79_WINTHROP_APPROVED_PROPOSED.osm", code
        geometry = geometry_by_code[code][0]
        assert geometry["grossAreaFt2"] == area, code
        assert geometry["orientation"] == orientation, code
        assert geometry["vt"] == 0.45, code

    # Fail closed for an unrelated envelope: no matching current thermal signature means
    # the reference must not silently populate another project's missing row.
    other_facts = json.loads(json.dumps(facts))
    for row in other_facts["pages"][0]["envelope"]:
        if row.get("uFactor") not in (None, ""):
            row["uFactor"] = 0.55
            row["shgc"] = 0.40
    other_path = root / "other-facts.json"
    other_path.write_text(json.dumps(other_facts), encoding="utf-8")
    other_request = root / "other-request.json"
    other_request.write_text(json.dumps({
        "revision":"eng_other",
        "projectId":"revex_other",
        "pageFactsPath":str(other_path),
        "outputFolder":str(root / "other-out"),
    }), encoding="utf-8")
    other_resolved = ref.resolve_request(other_request, root / "other-out")
    assert other_resolved == other_request

source = Path(__file__).with_name("revex_reference_envelope_projection_r118.py").read_text(encoding="utf-8")
assert "250_Midwood_Street" not in source
assert "COMcheck_250_MIDWOOD" not in source
assert "CURRENT_PROJECT_GEOMETRY_PLUS_APPROVED_REFERENCE_THERMAL_PERFORMANCE" in source
assert "referenceProjectIdentityCopied" in source
assert "currentProjectCxlUsedAsThermalAuthority" in source

print(json.dumps({
    "REVEX_R118_REFERENCE_ENVELOPE": "PASSED",
    "reference": REFERENCE.name,
    "approvedWindow": {"U": 0.30, "SHGC": 0.30, "VT": 0.45},
    "approvedGlazedDoor": {"U": 0.30, "SHGC": 0.30, "VT": 0.45},
    "resolvedCodes": sorted(expected),
    "currentGeometryPreserved": True,
    "unrelatedEnvelopeFailsClosed": True,
    "currentProjectCxlNotThermalAuthority": True,
}))
