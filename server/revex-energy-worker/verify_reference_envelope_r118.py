#!/usr/bin/env python3
from __future__ import annotations
import json, tempfile
from pathlib import Path
import revex_reference_envelope_projection_r118 as ref
import revex_energy_pipeline_guard_r118 as guard

# Use the exact production r118 normalizers.
ref._osm_fields = guard._osm_fields_without_comments
ref._has_existing_match = guard._exact_thermal_match_only
reference = Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy/References/79_WINTHROP_APPROVED_PROPOSED.osm"
profiles = ref._approved_profiles(reference)
for kind, construction in (("window","WIN_EXT_TRIPLE_LOW_E"),("door","DOOR_EXT")):
    p=profiles[kind]
    assert p["construction"] == construction
    assert (p["uFactor"],p["shgc"],p["vt"]) == (0.30,0.30,0.45)
assert profiles["window"]["handle"] == profiles["door"]["handle"]

windows=["G11.1","G11.2","G11.3","G11.4","G11.5","G11.6"]
doors=["D11.1","D11.2","D12.1"]
rows=[
 {"kind":"window","assemblyType":"G1.1","description":"Triple Pane Window","uFactor":.30,"shgc":.30,"grossAreaFt2":None,"confidence":.99,"evidence":"G1.1 U .30 SHGC .30"},
 {"kind":"door","assemblyType":"D4.1","description":"Exterior Glass Door","uFactor":.30,"shgc":.30,"grossAreaFt2":None,"confidence":.99,"evidence":"D4.1 glass U .30 SHGC .30"},
]
for i,code in enumerate(windows): rows.append({"kind":"window","assemblyType":code,"description":code+" Window Fixed","orientation":"NORTH","grossAreaFt2":10+i,"uFactor":None,"shgc":None,"confidence":.99,"evidence":code+" Window Fixed"})
for i,code in enumerate(doors): rows.append({"kind":"door","assemblyType":code,"description":code+" Glass Door","orientation":"NORTH","grossAreaFt2":20+i,"uFactor":None,"shgc":None,"confidence":.99,"evidence":code+" Glass Door"})
facts={"pages":[{"pageType":"EN","sourceFile":"CURRENT_EN.pdf","confidence":.99,"envelope":rows}]}

with tempfile.TemporaryDirectory() as td:
    root=Path(td); fp=root/"facts.json"; fp.write_text(json.dumps(facts))
    rp=root/"request.json"; rp.write_text(json.dumps({"revision":"eng_20260817T032812010Z","projectId":"current","pageFactsPath":str(fp),"outputFolder":str(root/"out")}))
    resolved=ref.resolve_request(rp,root/"out"); assert resolved != rp
    audit=json.loads((root/"out/REFERENCE_ENVELOPE_PROJECTION_R118.json").read_text())
    expected=set(windows+doors); assert {r["code"] for r in audit["filled"]} == expected
    assert not audit["currentProjectCxlUsedAsThermalAuthority"]
    assert not audit["referenceProjectIdentityCopied"] and not audit["referenceProjectQuantitiesCopied"]
    derived=json.loads(Path(json.loads(resolved.read_text())["pageFactsPath"]).read_text())
    original={(r["assemblyType"],r.get("grossAreaFt2"),r.get("orientation")) for r in rows if r.get("grossAreaFt2")}
    now={(r["assemblyType"],r.get("grossAreaFt2"),r.get("orientation")) for r in derived["pages"][0]["envelope"] if r.get("grossAreaFt2")}
    assert original == now

source=Path(__file__).with_name("revex_reference_envelope_projection_r118.py").read_text()
assert "250_Midwood_Street" not in source and "COMcheck_250_MIDWOOD" not in source
print(json.dumps({"REVEX_R118_REFERENCE_ENVELOPE":"PASSED","reference":reference.name,"U":.30,"SHGC":.30,"VT":.45,"resolvedCodes":sorted(windows+doors),"currentGeometryPreserved":True,"currentProjectCxlNotThermalAuthority":True}))
