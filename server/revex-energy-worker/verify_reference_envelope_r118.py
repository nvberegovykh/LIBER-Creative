#!/usr/bin/env python3
from __future__ import annotations
import json, os, tempfile
from pathlib import Path
import revex_reference_envelope_projection_r118 as ref
import revex_energy_pipeline_guard_r118 as guard

# Exercise the exact production OSM parser and exact-code current-authority rule.
ref._osm_fields = guard._osm_fields_without_comments
ref._has_existing_match = guard._exact_thermal_match_only

reference = ref._reference_path()
configured = str(os.environ.get("REVEX_APPROVED_ENVELOPE_REFERENCE") or "").strip()
if configured:
    expected = Path(configured).resolve(); assert reference == expected and expected.is_file(), (reference, expected)
if Path("/opt/revex").is_dir():
    expected_packaged = Path("/opt/revex/energy/References/79_WINTHROP_APPROVED_PROPOSED.osm")
    assert reference == expected_packaged and reference.is_file(), (reference, expected_packaged)

profiles = ref._approved_profiles(reference)
assert profiles["window"]["construction"] == "WIN_EXT_TRIPLE_LOW_E"
assert profiles["door"]["construction"] == "DOOR_EXT"
assert (profiles["window"]["uFactor"], profiles["window"]["shgc"], profiles["window"]["vt"]) == (0.30, 0.30, 0.45)
assert (profiles["door"]["uFactor"], profiles["door"]["shgc"], profiles["door"]["vt"]) == (0.30, 0.30, 0.45)
assert profiles["roof"]["construction"] == "R1_ROOF_PROPOSED"
assert (profiles["roof"]["cavityR"], profiles["roof"]["continuousR"]) == (26.4, 15.0)
assert profiles["wall_above"]["construction"] == "MAT_WALL_SPRAYFOAM_R13_2IN"
assert profiles["wall_cellar"]["construction"] == "F1_WALL_CELLAR_12INCONC_R8_R13"
assert (profiles["wall_above"]["cavityR"], profiles["wall_above"]["continuousR"]) == (13.0, 8.0)
assert (profiles["wall_cellar"]["cavityR"], profiles["wall_cellar"]["continuousR"]) == (13.0, 8.0)
assert profiles["floor_exposed"]["construction"] == "F1_EXT_FLOOR_JOIST"
assert profiles["floor_exposed"]["continuousR"] == 8.0
assert profiles["floor_slab"]["construction"] == "G_FLOOR_CELLAR_SLAB_6IN"
assert (profiles["floor_slab"]["cavityR"], profiles["floor_slab"]["continuousR"]) == (0.0, 0.0)

# This is the complete code family from the live 2026-08-17 failure, deduplicated.
roof_codes = ["R1", "R2", "R3", "R4"]
cellar_wall_codes = ["F1.1"]
wall_codes = ["W1.1", "W1.2", "W2.1", "W2.2", "W2.3", "W2.4"]
window_codes = ["G1.1", "G1.2", "G2.1", "G3.1", "G11.1", "G11.2", "G11.3", "G11.4", "G11.5", "G11.6"]
door_codes = ["D2.1", "D4.1", "D11.1", "D12.1"]
floor_codes = ["F2.1", "S1.1"]

rows = [
    # One current-project thermal anchor proves that this request belongs to the approved
    # same-envelope family; this anchor remains current evidence and is never overwritten.
    {"kind":"window","assemblyType":"G99.1","description":"Current approved-family window","uFactor":.30,"shgc":.30,"grossAreaFt2":None,"confidence":.99,"evidence":"G99.1 U .30 SHGC .30"},
]
for i, code in enumerate(roof_codes):
    rows.append({"kind":"roof","assemblyType":code,"description":f"{code} Roof","orientation":None,"grossAreaFt2":100+i,"confidence":.99,"evidence":f"{code} Roof"})
for i, code in enumerate(cellar_wall_codes):
    rows.append({"kind":"wall","assemblyType":code,"description":f"{code} Cellar 12 in concrete wall","orientation":"NORTH","grossAreaFt2":80+i,"confidence":.99,"evidence":f"{code} Cellar foundation wall"})
for i, code in enumerate(wall_codes):
    rows.append({"kind":"wall","assemblyType":code,"description":f"{code} CMU exterior wall","orientation":"NORTH","grossAreaFt2":90+i,"confidence":.99,"evidence":f"{code} CMU exterior wall"})
for i, code in enumerate(window_codes):
    rows.append({"kind":"window","assemblyType":code,"description":f"{code} Window Fixed","orientation":"NORTH","grossAreaFt2":10+i,"confidence":.99,"evidence":f"{code} Window Fixed"})
for i, code in enumerate(door_codes):
    rows.append({"kind":"door","assemblyType":code,"description":f"{code} Exterior entrance door","orientation":"NORTH","grossAreaFt2":20+i,"confidence":.99,"evidence":f"{code} Exterior entrance door"})
rows += [
    {"kind":"floor","assemblyType":"F2.1","description":"F2.1 Exposed exterior floor joist","orientation":None,"grossAreaFt2":120,"confidence":.99,"evidence":"F2.1 Exposed exterior floor"},
    {"kind":"floor","assemblyType":"S1.1","description":"S1.1 Cellar slab on grade","orientation":None,"grossAreaFt2":130,"confidence":.99,"evidence":"S1.1 Cellar slab on grade"},
]

facts = {"pages":[{"pageType":"EN","sourceFile":"CURRENT_EN.pdf","sheetNumber":"EN-001","confidence":.99,"envelope":rows}]}
with tempfile.TemporaryDirectory() as td:
    root=Path(td); fp=root/"facts.json"; fp.write_text(json.dumps(facts), encoding="utf-8")
    rp=root/"request.json"; rp.write_text(json.dumps({"revision":"eng_test","projectId":"current","pageFactsPath":str(fp),"outputFolder":str(root/"out")}), encoding="utf-8")
    resolved=ref.resolve_request(rp,root/"out"); assert resolved != rp
    audit=json.loads((root/"out/REFERENCE_ENVELOPE_PROJECTION_R118.json").read_text())
    expected=set(roof_codes+cellar_wall_codes+wall_codes+window_codes+door_codes+floor_codes)
    actual={r["code"] for r in audit["filled"]}
    assert actual == expected, (sorted(expected-actual), sorted(actual-expected), audit["skipped"])
    assert audit["referenceFamilyCorroborated"] is True
    assert not audit["skipped"], audit["skipped"]
    classes={r["code"]:r["class"] for r in audit["filled"]}
    assert all(classes[c]=="roof" for c in roof_codes)
    assert all(classes[c]=="wall_cellar" for c in cellar_wall_codes)
    assert all(classes[c]=="wall_above" for c in wall_codes)
    assert all(classes[c]=="window" for c in window_codes)
    assert all(classes[c]=="door" for c in door_codes)
    assert classes["F2.1"]=="floor_exposed" and classes["S1.1"]=="floor_slab"
    assert not audit["currentProjectCxlUsedAsThermalAuthority"]
    assert not audit["referenceProjectIdentityCopied"] and not audit["referenceProjectQuantitiesCopied"]
    derived=json.loads(Path(json.loads(resolved.read_text())["pageFactsPath"]).read_text())
    original={(r["kind"],r["assemblyType"],r.get("grossAreaFt2"),r.get("orientation")) for r in rows if r.get("grossAreaFt2") is not None}
    now={(r["kind"],r["assemblyType"],r.get("grossAreaFt2"),r.get("orientation")) for r in derived["pages"][0]["envelope"] if r.get("grossAreaFt2") is not None}
    assert original == now

source=Path(__file__).with_name("revex_reference_envelope_projection_r118.py").read_text()
assert "250_Midwood_Street" not in source and "COMcheck_250_MIDWOOD" not in source
print(json.dumps({
    "REVEX_R121_REFERENCE_ENVELOPE_CLASSES":"PASSED",
    "reference":str(reference),
    "productionPackagedPath":str(reference).replace("\\","/").endswith("/opt/revex/energy/References/79_WINTHROP_APPROVED_PROPOSED.osm") if Path("/opt/revex").is_dir() else None,
    "resolvedLiveFailureCodes":sorted(set(roof_codes+cellar_wall_codes+wall_codes+window_codes+door_codes)),
    "extraFloorCoverage":floor_codes,
    "classes":["roof","floor_exposed","floor_slab","wall_above","wall_cellar","window","door"],
    "currentGeometryPreserved":True,
    "currentProjectCxlNotThermalAuthority":True
}))
