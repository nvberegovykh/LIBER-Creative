#!/usr/bin/env python3
"""WALLT active runtime owner around the proven REVEX Energy engine."""
from __future__ import annotations
import copy,json,time
from pathlib import Path
import revex_energy_maintainer as legacy_tools
import revex_energy_agent_evidence as ev

# The canonical server imports revex_user_identity_en1 before importing WALLT. When that
# parent module is available, install the current user-confirmed 17-sheet / 63% EN-1 PDF
# contract immediately. Standalone Revit-side/unit-test imports remain independent.
try:
    import revex_user_identity_en1 as _en1
    import revex_en1_print_contract as _en1_print
    _en1_print.install(_en1)
except ImportError:
    pass

SCHEMA="liber.revex.energy-agent.v1";VERSION="20260818-wallt-active1"
STATE_NAME="REVEX_ENERGY_MAINTAINER_STATE.json";EVENTS_NAME="REVEX_ENERGY_MAINTAINER_EVENTS.jsonl";REPAIR_REQUEST_NAME="REVEX_ENERGY_REVIT_REPAIR_REQUEST.json";MISSING_VT=ev.MISSING_VT
_req={};_root=None;_pages=None;_repairs=[];_preflight=False;_busy=False

def _text(v):return str(v or "").strip()
def _dedupe(values):
    out=[];seen=set()
    for raw in values:
        v=_text(raw);k=" ".join(v.split()).casefold()
        if v and k not in seen:seen.add(k);out.append(v)
    return out
def _path(name):return (_root/name) if _root else None
def record(stage,status,detail=None):
    p=_path(EVENTS_NAME)
    if not p:return
    try:
        with p.open("a",encoding="utf-8") as f:f.write(json.dumps({"schema":SCHEMA,"version":VERSION,"atEpoch":time.time(),"stage":stage,"status":status,"detail":detail or {}},ensure_ascii=True)+"\n")
    except Exception:pass
def state(status,stage,message,**detail):
    p=_path(STATE_NAME)
    if not p:return
    old={}
    try:old=json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
    except Exception:pass
    row={"schema":SCHEMA,"version":VERSION,"status":status,"stage":stage,"message":message,"updatedAtEpoch":time.time(),"sourceEngineeringRevision":_req.get("revision") or _req.get("sourceEngineeringRevision"),"controllerMode":"ACTIVE_REPAIR","shadowOnly":False,"sourceEvidenceMutated":False,"pipelineSourceMutated":False,"eventsFile":EVENTS_NAME,"repairRequestFile":REPAIR_REQUEST_NAME,"agentTools":["CURRENT_EN_MATCH","CURRENT_REVIT_SCHEDULE","CURRENT_EN_AI_SCAN","CURRENT_EVIDENCE_RELATION","USER_CLARIFICATION","ORIENTATION","MISSING_VT_0_45","REVIT_REPAIR","EARLY_PREFLIGHT"],**{k:v for k,v in old.items() if k in {"repairs","questions","agentRuns","reviewModels"}},**detail};p.write_text(json.dumps(row,ensure_ascii=True,indent=2),encoding="utf-8")
def bind_request(request_path):
    global _req,_root,_pages,_repairs,_preflight
    _req={};_root=None;_pages=None;_repairs=[];_preflight=False;p=Path(request_path).resolve() if request_path else None
    if p and p.is_file():
        try:_req=json.loads(p.read_text(encoding="utf-8"))
        except Exception:pass
    raw=_text(_req.get("outputFolder"));_root=Path(raw).resolve() if raw else (p.parent.parent if p and p.parent.name.lower() in {"work","input","_input"} else p.parent if p else None)
    if _root:_root.mkdir(parents=True,exist_ok=True)
    legacy_tools.bind_request(p);state("RUNNING","BIND_REQUEST","WALLT active Energy controller attached.")
def _unresolved(errors):return legacy_tools._unresolved_codes(_dedupe(errors))
def _inject(pages,rows):
    if not rows:return pages
    p=copy.deepcopy(pages);target=next((x for x in p if _text(x.get("pageType")).upper()=="EN"),None)
    if target is None:target={"pageType":"EN","envelope":[]};p.append(target)
    target.setdefault("envelope",[]).extend(rows);return p
def _request_pages():
    p=Path(_text(_req.get("pageFactsPath")))
    try:f=json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}
    except Exception:f={}
    return [dict(x) for x in f.get("pages",[]) if _text(x.get("pageType")).upper()=="EN"]
def _repair_request(tm,om,q):
    rows=[]
    for r in tm:
        k=r.get("kind");rows.append({"domain":"ENVELOPE_THERMAL","kind":k,"code":r.get("code"),"required":["uFactor","shgc"] if k=="window" else ["uFactor"] if k=="door" else ["cavityR|continuousR|uFactor"],"action":"refresh-energy-evidence"})
    for r in om:rows.append({"domain":"ENVELOPE_ORIENTATION","kind":"window","code":r.get("code"),"required":["orientation|azimuth|surfaceNormal"],"action":"refresh-energy-evidence"})
    rr={"schema":"liber.revex.energy-revit-repair-request.v1","version":VERSION,"status":"WAITING_USER" if rows else "NO_ACTION","projectId":_req.get("projectId"),"sourceEngineeringRevision":_req.get("revision") or _req.get("sourceEngineeringRevision"),"resumeFromStage":"WALLT_FILING_PREFLIGHT","preserveCompletedStages":True,"question":q,"requests":rows};p=_path(REPAIR_REQUEST_NAME)
    if p:p.write_text(json.dumps(rr,ensure_ascii=True,indent=2),encoding="utf-8")
    return rr
def _preflight_run(module):
    global _preflight,_busy
    if _preflight or _busy:return
    _busy=True;started=time.monotonic()
    try:
        p=_pages if _pages is not None else _request_pages()
        if not p:record("WALLT_FILING_PREFLIGHT","NO_EN_PAGES",{});_preflight=True;return
        rows,a=module.canonicalize_comcheck_envelope_rows(p);errs=_dedupe((a or {}).get("thermalPropertyMergeErrors") or []);rows,nr,om=ev.normalize_rows(module,rows);tm=_unresolved(errs)
        if tm or om:
            parts=[]
            if tm:parts.append("thermal relation: "+", ".join(f"{r['kind']} {r['code']}" for r in tm))
            if om:parts.append("orientation: "+", ".join(f"window {r['code']}" for r in om))
            q="Current immutable Revit evidence still needs "+"; ".join(parts)+". Refresh/correct current Revit evidence or clarify the exact fact; WALLT will resume from this block.";rr=_repair_request(tm,om,q);state("WAITING_USER","WALLT_FILING_PREFLIGHT",q,repairs=_repairs+nr,questions=[{"id":"energy-evidence-repair","message":q,"acceptsFreeText":True,"revitActionAvailable":"refresh-energy-evidence","repairRequestFile":REPAIR_REQUEST_NAME}],unresolvedThermal=tm,unresolvedOrientation=om,revitRepairRequest=rr);record("WALLT_FILING_PREFLIGHT","WAITING_USER",{"thermalErrors":errs,"unresolvedOrientation":om});raise RuntimeError("WALLT_WAITING_USER: "+q)
        _repair_request([],[],None);state("RUNNING","WALLT_FILING_PREFLIGHT","WALLT cleared all derivable filing fields before expensive Energy work.",repairs=_repairs+nr,questions=[],missingVtPolicy=MISSING_VT,elapsedSeconds=round(time.monotonic()-started,2));record("WALLT_FILING_PREFLIGHT","PASSED",{"canonicalRows":len(rows),"repairCount":len(_repairs)+len(nr)});_preflight=True
    finally:_busy=False
def install(module):
    global _pages,_repairs
    if getattr(module,"__revex_energy_agent_installed__",False):return
    rl=getattr(module,"RunLog",None)
    if rl is not None and hasattr(rl,"write"):
        ow=rl.write
        def write(self,stage,status,**detail):record(stage,status,detail);return ow(self,stage,status,**detail)
        rl.write=write
    old_merge=getattr(module,"_merge_diagram_geometry_with_thermal",None)
    if old_merge:
        def merge(d,trs):
            merged,err=old_merge(d,trs)
            if merged is not None:return ev.normalize_rows(module,[merged])[0][0],err
            c,why=ev.best_candidate(module,dict(d),[dict(x) for x in list(trs or [])])
            if c is None:return merged,err
            r=ev.copy_thermal(dict(d),c,why);cc,_=ev.code(module,r);info={"tool":why,"kind":r.get("kind"),"code":cc,"thermalSignature":list(ev.signature(r))};_repairs.append(info);record("WALLT_THERMAL_MERGE","REPAIRED",info);return r,None
        module._merge_diagram_geometry_with_thermal=merge
    old_canon=module.canonicalize_comcheck_envelope_rows
    def canonicalize(en_pages):
        global _pages,_repairs
        p=copy.deepcopy(_pages if _pages is not None else list(en_pages or []));rows,a=old_canon(p);errs=_dedupe((a or {}).get("thermalPropertyMergeErrors") or []);rep=[];q=None
        if errs:
            want=_unresolved(errs);sr,sa=ev.schedule_rows(_req,want);p=_inject(p,sr);rep+=sa;record("WALLT_NATIVE_SCHEDULE_SCAN","PASSED",{"resolved":len(sr),"audit":sa});rows,a=old_canon(p);errs=_dedupe((a or {}).get("thermalPropertyMergeErrors") or [])
        if errs:
            want=_unresolved(errs);cr,ca=ev.clarification_rows(_req,want);p=_inject(p,cr);rep+=ca;record("WALLT_USER_CLARIFICATION","PASSED",{"resolved":len(cr),"audit":ca});rows,a=old_canon(p);errs=_dedupe((a or {}).get("thermalPropertyMergeErrors") or [])
        if errs:
            p,ar,q=legacy_tools._maintain_en_pages(module,p,errs);rep+=ar;rows,a=old_canon(p);errs=_dedupe((a or {}).get("thermalPropertyMergeErrors") or [])
        _pages=p;_repairs+=rep;rows,nr,om=ev.normalize_rows(module,rows);_repairs+=nr;a=dict(a or {});a["thermalPropertyMergeErrors"]=errs;a["wallt"]={"schema":SCHEMA,"version":VERSION,"controllerMode":"ACTIVE_REPAIR","shadowOnly":False,"repairs":rep+nr,"remainingThermalErrors":errs,"unresolvedOrientation":om,"missingVtPolicy":MISSING_VT,"sourceEvidenceMutated":False};a["wallt"].update({"question":q} if q else {});record("WALLT_EN_RECONCILIATION","PASSED" if not errs and not om else "UNRESOLVED",{"canonicalRows":len(rows),"remainingThermalErrors":errs,"unresolvedOrientation":om});state("RUNNING","WALLT_EN_RECONCILIATION","WALLT finished current evidence repair." if not errs and not om else "WALLT exhausted automatic current-evidence repair tools.",repairs=_repairs,questions=[]);return rows,a
    module.canonicalize_comcheck_envelope_rows=canonicalize
    if hasattr(module,"run_command"):
        old_run=module.run_command
        def run_command(command,cwd,log_path,log,stage):
            if any(x in _text(stage).upper() for x in ("GEOMETRYCO","ENERGYPLUS","SIMULATION")):_preflight_run(module)
            return old_run(command,cwd,log_path,log,stage)
        module.run_command=run_command
    old_prepare=module.prepare_project_comcheck
    def prepare(facts,identity,folder,log):
        _preflight_run(module);res=old_prepare(facts,identity,folder,log);cxl=res[0]
        if cxl is not None and Path(cxl).is_file():state("RUNNING","COMCHECK_INPUT_READY","WALLT validated the current-project COMcheck input.",repairs=_repairs,questions=[],missingVtPolicy=MISSING_VT);record("WALLT_COMCHECK_ALIGNMENT","PASSED",{"cxl":Path(cxl).name})
        return res
    module.prepare_project_comcheck=prepare;module.__revex_energy_agent_installed__=True;record("WALLT_INSTALL","PASSED",{"version":VERSION,"controllerMode":"ACTIVE_REPAIR"})
def public_state():
    p=_path(STATE_NAME)
    try:return json.loads(p.read_text(encoding="utf-8")) if p and p.is_file() else None
    except Exception:return None
