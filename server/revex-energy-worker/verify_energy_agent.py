#!/usr/bin/env python3
from __future__ import annotations
import json,sys,tempfile,xml.etree.ElementTree as ET
from pathlib import Path

ENERGY=Path(__file__).resolve().parents[2]/"src/Liber.Revex.Revit/Engineering/Energy"
if str(ENERGY) not in sys.path:sys.path.insert(0,str(ENERGY))
import revex_energy_agent_evidence as ev
import revex_energy_agent as agent
import revex_energy_agent_filing as filing

class M:
    @staticmethod
    def _comcheck_row_code(row):
        import re
        s=" ".join(str(row.get(k) or "") for k in ("assemblyType","description","evidence"));m=re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])",s.upper())
        return (m.group(1),m.group(1).split('.',1)[0]) if m else ("","")

codes=[
("roof","R1"),("roof","R2"),("roof","R3"),("roof","R4"),
("door","D4.1"),("door","D11.2"),("door","D11.1"),("door","D2.1"),("door","D12.1"),
("wall","F1.1"),("wall","W1.1"),("wall","W1.2"),("wall","W2.1"),("wall","W2.2"),("wall","W2.3"),("wall","W2.4"),
("window","G1.1"),("window","G1.2"),("window","G2.1"),("window","G3.1"),("window","G11.1"),("window","G11.2"),("window","G11.3"),("window","G11.4"),("window","G11.5"),("window","G11.6"),
]

with tempfile.TemporaryDirectory(prefix="revex-wallt-agent-") as td:
    root=Path(td);schedule=root/"REVIT-SCHEDULE-EVIDENCE.json"
    rows=[]
    for kind,code in codes:
        if kind=="window":rows.append([code,"Window","0.300","0.250",""])
        elif kind=="door":rows.append([code,"Door","0.500","",""])
        else:rows.append([code,kind.title(),"","","20.0"])
    schedule.write_text(json.dumps({"schema":"liber.revex.engineering-schedule-evidence.v1","authority":"active-revit-document-native-schedules","schedules":[{"name":"EN Envelope Thermal","fields":[{"name":"Tag"},{"name":"Description"},{"name":"U Factor"},{"name":"SHGC"},{"name":"R Value"}],"bodyRows":rows}]}),encoding="utf-8")
    request={"revision":"eng_test","projectId":"p","sourceArtifacts":[str(schedule)]}
    wanted=[{"kind":k,"code":c} for k,c in codes]
    resolved,audit=ev.schedule_rows(request,wanted)
    assert len(resolved)==len(codes),(len(resolved),len(codes),audit)
    assert all(x.get("status")=="RESOLVED" for x in audit),audit

    normalized,rep,missing=ev.normalize_rows(M,[{"kind":"window","assemblyType":"G1.1","uFactor":.30,"shgc":.25,"surfaceNormal":{"x":1,"y":0}}])
    assert normalized[0]["vt"]==.45 and normalized[0]["visibleTransmittanceAuthority"]=="REVEX_FIXED_MISSING_VT_0_45",normalized
    assert normalized[0]["orientation"]=="E",normalized
    assert not missing,missing

    clarified,ca=ev.clarification_rows({"maintainerClarification":"G11.6 U=0.31 SHGC=0.26 VT=0.45 EAST"},[{"kind":"window","code":"G11.6"}])
    assert len(clarified)==1 and clarified[0]["uFactor"]==.31 and clarified[0]["shgc"]==.26 and clarified[0]["orientation"]=="E",clarified

    # Exact failure behavior: stop before expensive stages and emit one resumable repair artifact
    # containing each unresolved evidence domain rather than fabricating a filing fact.
    facts=root/"facts.json";facts.write_text(json.dumps({"pages":[{"pageType":"EN","envelope":[{"kind":"window","assemblyType":"G99.1","grossAreaFt2":10}]}]}),encoding="utf-8")
    req=root/"request.json";req.write_text(json.dumps({"revision":"eng_wait","projectId":"p","outputFolder":str(root),"pageFactsPath":str(facts),"sourceArtifacts":[]}),encoding="utf-8")
    agent.bind_request(req)
    class Wait:
        @staticmethod
        def canonicalize_comcheck_envelope_rows(_pages):
            return ([{"kind":"window","assemblyType":"G99.1","grossAreaFt2":10}],{"thermalPropertyMergeErrors":["EN window geometry row G99.1 has no thermal-property match"]})
    try:agent._preflight_run(Wait)
    except RuntimeError as exc:assert "WALLT_WAITING_USER" in str(exc),exc
    else:raise AssertionError("unresolved filing evidence did not hard-stop before expensive stages")
    state=json.loads((root/agent.STATE_NAME).read_text(encoding="utf-8"));repair=json.loads((root/agent.REPAIR_REQUEST_NAME).read_text(encoding="utf-8"))
    assert state["status"]=="WAITING_USER" and state["stage"]=="WALLT_FILING_PREFLIGHT",state
    assert repair["preserveCompletedStages"] is True,repair
    requests=repair["requests"]
    assert len(requests)==2 and {row["domain"] for row in requests}=={"ENVELOPE_THERMAL","ENVELOPE_ORIENTATION"},repair
    assert {row["code"] for row in requests}=={"G99.1"},repair

    # The attached real review package failed official COMcheck on missing VT. Prove the current
    # filing boundary serializes every glazed opening, preserves actual VT, and leaves opaque doors alone.
    cxl=root/"vt-test.cxl"
    cxl.write_text("""<?xml version='1.0' encoding='utf-8'?>
<comcheck><envelope><useVltDetails>false</useVltDetails><agWall>
<window><assemblyType>G11.5</assemblyType><glazingType>DOUBLE</glazingType><propUvalue>0.300</propUvalue><propShgc>0.300</propShgc></window>
<window><assemblyType>G1.1</assemblyType><glazingType>DOUBLE</glazingType><propUvalue>0.300</propUvalue><propShgc>0.300</propShgc><propVt>0.370</propVt></window>
<door><assemblyType>D4.1</assemblyType><description>Glass Door</description><glazingType>DOUBLE</glazingType><propUvalue>0.300</propUvalue><propShgc>0.300</propShgc></door>
<door><assemblyType>D2.1</assemblyType><description>Insulated metal door</description><propUvalue>0.500</propUvalue></door>
</agWall></envelope></comcheck>""",encoding="utf-8")
    va=filing.enforce_comcheck_vt(cxl)
    assert va["status"]=="PASSED" and va["glazedOpeningCount"]==3 and va["filledCount"]==2 and va["preservedCount"]==1,va
    tree=ET.parse(cxl);rt=tree.getroot();nodes=[n for n in rt.iter() if n.tag.rsplit('}',1)[-1] in {"window","door"}]
    def child_text(node,name):
        ch=next((x for x in list(node) if x.tag.rsplit('}',1)[-1]==name),None);return str(ch.text or '').strip() if ch is not None else ''
    by_code={child_text(n,"assemblyType"):n for n in nodes}
    assert child_text(by_code["G11.5"],"propVt")=="0.450"
    assert child_text(by_code["G1.1"],"propVt")=="0.370"
    assert child_text(by_code["D4.1"],"propVt")=="0.450"
    assert child_text(by_code["D2.1"],"propVt")==""
    envelope=next(n for n in rt.iter() if n.tag.rsplit('}',1)[-1]=="envelope")
    assert child_text(envelope,"useVltDetails")=="true"

    # Prove the filing wrapper preserves raw orientation/VT before canonicalization and stamps
    # the user-visible GEOMETRY.osm through the same current-project identity boundary.
    calls=[]
    class FilingModule:
        _comcheck_row_code=staticmethod(M._comcheck_row_code)
        @staticmethod
        def canonicalize_comcheck_envelope_rows(pages):return (pages[0]["envelope"],{})
        @staticmethod
        def stamp_compiled_project_identity(model_path,identity,role,log):calls.append((Path(model_path).name,role));return None
        @staticmethod
        def prepare_project_comcheck(facts,identity,folder,log):return (cxl,None,{})
    filing.install(FilingModule)
    pre_rows,pre_audit=FilingModule.canonicalize_comcheck_envelope_rows([{"envelope":[{"kind":"window","assemblyType":"G2.1","uFactor":.3,"shgc":.3,"surfaceNormal":{"x":-1,"y":0}}]}])
    assert pre_rows[0]["orientation"]=="W" and pre_rows[0]["vt"]==.45,(pre_rows,pre_audit)
    original_dir=root/"01_ORIGINAL_MODELS";compiled_dir=root/"02_COMPILED_MODELS";original_dir.mkdir();compiled_dir.mkdir()
    geometry=original_dir/"REVIT_GEOMETRY_ORIGINAL.osm";geometry.write_text("geometry",encoding="utf-8")
    baseline=compiled_dir/"BASELINE_UPDATED_GEOMETRY.osm";baseline.write_text("baseline",encoding="utf-8")
    class Log:
        @staticmethod
        def write(*args,**kwargs):pass
    FilingModule.stamp_compiled_project_identity(baseline,{"title":"250 MIDWOOD STREET"},"BASELINE",Log())
    assert calls[0]==("REVIT_GEOMETRY_ORIGINAL.osm","GEOMETRY") and calls[1]==("BASELINE_UPDATED_GEOMETRY.osm","BASELINE"),calls

print(json.dumps({"schema":"liber.revex.energy-agent-verification.v1","status":"PASSED","activeController":True,"actualFailureUniqueCodes":len(codes),"nativeScheduleResolved":len(codes),"missingVt":.45,"allGlazedVtSerialized":True,"actualVtPreserved":True,"orientationFromNormal":True,"revisionClarification":True,"earlyWaitingUser":True,"resumableRevitRepairRequest":True,"reviewGeometryIdentityStamped":True},separators=(",",":")))
