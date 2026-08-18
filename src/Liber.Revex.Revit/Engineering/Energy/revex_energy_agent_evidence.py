#!/usr/bin/env python3
"""Typed current-project evidence tools used by WALLT Energy."""
from __future__ import annotations
import json, math, re
from pathlib import Path
from typing import Any

MISSING_VT=0.45

def text(v): return str(v or "").strip()
def norm(v): return re.sub(r"[^a-z0-9]+"," ",text(v).lower()).strip()
def num(v,signed=False):
    if v in (None,""): return None
    try:
        x=float(v) if isinstance(v,(int,float)) and not isinstance(v,bool) else float(re.search(r"-?\d+(?:\.\d+)?",text(v).replace(","," ")).group())
    except Exception:return None
    return x if math.isfinite(x) and (signed or x>=0) else None

def code(module,row):
    try:
        a,b=module._comcheck_row_code(row);return text(a),text(b)
    except Exception:
        m=re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])"," ".join(text(row.get(k)) for k in ("assemblyType","description","evidence")).upper())
        return (m.group(1),m.group(1).split(".",1)[0]) if m else ("","")
def signature(row):
    k=text(row.get("kind")).lower()
    if k=="window":return num(row.get("uFactor")),num(row.get("shgc"))
    if k=="door":return (num(row.get("uFactor")),)
    return num(row.get("cavityR")),num(row.get("continuousR")),num(row.get("uFactor"))
def has_thermal(row):
    k=text(row.get("kind")).lower();s=signature(row)
    return (s[0] is not None and s[1] is not None) if k=="window" else s[0] is not None if k=="door" else any(x is not None for x in s) if k in {"wall","roof","floor"} else False
def actual_vt(row):
    if text(row.get("visibleTransmittanceAuthority")).upper() in {"CODE_FALLBACK_TINTED","CODE_FALLBACK_CLEAR","REVEX_FIXED_MISSING_VT_0_45"}:return None
    for k in ("vt","vlt","visibleTransmittance"):
        x=num(row.get(k))
        if x is not None and x<=1:return x
    m=re.search(r"\bV(?:T|LT)\s*[:=]?\s*(0?(?:\.\d+)|1(?:\.0+)?)"," ".join(text(row.get(k)) for k in ("evidence","description","assemblyType")),re.I)
    return float(m.group(1)) if m else None

def best_candidate(module,diagram,rows):
    k=text(diagram.get("kind")).lower();c,b=code(module,diagram);valid=[r for r in rows if text(r.get("kind")).lower()==k and has_thermal(r) and float(r.get("confidence") or 0)>=.70]
    for pool,why in (([r for r in valid if c and code(module,r)[0].upper()==c.upper()],"CURRENT_EN_EXACT_CODE"),([r for r in valid if b and code(module,r)[1].upper()==b.upper()],"CURRENT_EN_BASE_CODE")):
        if pool and len({signature(r) for r in pool})==1:return pool[0],why
    if valid and len({signature(r) for r in valid})==1:return valid[0],"CURRENT_EN_UNIQUE_KIND_THERMAL_SIGNATURE"
    return None,""
def copy_thermal(diagram,source,why):
    r=dict(diagram)
    for k in ("uFactor","shgc","cavityR","continuousR"):
        if source.get(k) not in (None,""):r[k]=source[k]
    if not text(r.get("orientation")) and text(source.get("orientation")):r["orientation"]=text(source.get("orientation")).upper()[0];r["orientationAuthority"]=text(source.get("orientationAuthority") or why)
    vt=actual_vt(diagram);vt=actual_vt(source) if vt is None else vt
    if vt is not None:r["vt"]=round(vt,3);r["visibleTransmittanceAuthority"]="ACTIVE_PROJECT_EVIDENCE_VT"
    elif text(r.get("kind")).lower() in {"window","door"}:r["vt"]=MISSING_VT;r["visibleTransmittanceAuthority"]="REVEX_FIXED_MISSING_VT_0_45"
    r["confidence"]=max(float(r.get("confidence") or 0),.999);r["_walltRepairAuthority"]=why;return r

def _artifact_map(request):
    out={}
    for raw in request.get("sourceArtifacts") or []:
        p=Path(text(raw))
        if p.is_file():out[p.name.casefold()]=p
    return out
def _schedule_path(request):
    a=_artifact_map(request);m=text(request.get("engineeringManifestPath"))
    if m and Path(m).is_file():
        try:
            man=json.loads(Path(m).read_text(encoding="utf-8"));row=next((r for r in man.get("artifacts",[]) if text(r.get("role")).casefold()=="revit-schedule-evidence"),None)
            if row:
                k=Path(text(row.get("name"))).name.casefold()
                if k in a:return a[k]
        except Exception:pass
    return next((p for n,p in a.items() if n.endswith("revit-schedule-evidence.json")),None)
def _headings(s):
    f=[r for r in s.get("fields",[]) if not r.get("hidden")];fh=[text(r.get("columnHeading") or r.get("name")) for r in f];hs=[[text(v) for v in r] for r in s.get("headerRows",[])];body=s.get("bodyRows",[]);w=max([len(fh),*(len(r) for r in hs),*(len(r) for r in body),0]);out=[]
    for i in range(w):out.append(" / ".join(dict.fromkeys([*(r[i] for r in hs if i<len(r) and r[i]),*([fh[i]] if i<len(fh) and fh[i] else [])])))
    return out
def _col(row,heads,tokens):
    for i,h in enumerate(heads):
        if any(t in norm(h) for t in tokens) and i<len(row):
            x=num(row[i])
            if x is not None:return x
    return None
def _has_code(c,blob):return bool(c and re.search(rf"(?<![A-Z0-9.]){re.escape(c.upper())}(?![A-Z0-9.])",blob.upper()))

def schedule_rows(request,wanted):
    p=_schedule_path(request);out=[];audit=[]
    if not p:return out,audit
    try:e=json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:return out,audit
    for t in wanted:
        k=text(t.get("kind")).lower();c=text(t.get("code")).upper();b=c.split(".",1)[0];found=[]
        for s in e.get("schedules",[]):
            hs=_headings(s)
            for i,row in enumerate(s.get("bodyRows",[])):
                blob=" | ".join(text(v) for v in row)
                if not _has_code(c,blob) and not _has_code(b,blob):continue
                u=_col(row,hs,("u factor","u value","thermal transmittance"));sh=_col(row,hs,("shgc","solar heat gain"));vt=_col(row,hs,("visible light trans","visible transmittance","vlt"));cav=_col(row,hs,("cavity r","cavity insulation","r cavity"));ci=_col(row,hs,("continuous r","continuous insulation","ci r","r ci"));rv=_col(row,hs,("r value","thermal resistance"));ci=rv if k in {"wall","roof","floor"} and cav is None and ci is None else ci
                r={"kind":k,"assemblyType":c,"description":blob[:500],"uFactor":u,"shgc":sh,"cavityR":cav,"continuousR":ci,"vt":vt,"confidence":.999 if _has_code(c,blob) else .96,"evidence":f"Native Revit schedule {s.get('name') or ''} row {i+1}: {blob[:700]}"}
                if has_thermal(r):found.append(r)
        if found and len({signature(r) for r in found})==1:out.append(found[0]);audit.append({"kind":k,"code":c,"status":"RESOLVED","authority":"ACTIVE_REVIT_NATIVE_SCHEDULE"})
        elif found:audit.append({"kind":k,"code":c,"status":"CONFLICT","authority":"ACTIVE_REVIT_NATIVE_SCHEDULE"})
    return out,audit

def clarification_rows(request,wanted):
    raw=request.get("maintainerClarification");txt=text(raw) if not isinstance(raw,(dict,list)) else "";structured=(raw.get("rows") or raw.get("envelope") or []) if isinstance(raw,dict) else raw if isinstance(raw,list) else [];out=[];audit=[]
    for t in wanted:
        k=text(t.get("kind")).lower();c=text(t.get("code")).upper();cand=[]
        for r0 in structured:
            if isinstance(r0,dict) and _has_code(c," ".join(text(r0.get(x)) for x in ("assemblyType","code","description","evidence"))):r=dict(r0);r.update(kind=k,assemblyType=c,confidence=1.0);cand.append(r)
        for ch in [x.strip() for x in re.split(r"[\r\n;]+",txt) if x.strip()] if txt else []:
            if not _has_code(c,ch):continue
            def grab(pat):
                m=re.search(pat,ch,re.I);return num(m.group(1)) if m else None
            u=grab(r"\bU(?:[- ]?FACTOR|[- ]?VALUE)?(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)");sh=grab(r"\bSHGC(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)");vt=grab(r"\bV(?:T|LT)(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)");rv=grab(r"\bR(?:[- ]?VALUE)?(?:\s*[:=]\s*|\s+)(\d+(?:\.\d+)?)");m=re.search(r"\b(NORTH|SOUTH|EAST|WEST|N|S|E|W)\b",ch,re.I);ori=m.group(1).upper()[0] if m else None
            cand.append({"kind":k,"assemblyType":c,"description":ch[:500],"uFactor":u,"shgc":sh,"continuousR":rv,"vt":vt,"orientation":ori,"orientationAuthority":"REVISION_SCOPED_USER_CLARIFICATION" if ori else None,"confidence":1.0,"evidence":"Revision-scoped user clarification: "+ch[:700]})
        valid=[r for r in cand if has_thermal(r)]
        if valid and len({signature(r) for r in valid})==1:out.append(valid[0]);audit.append({"kind":k,"code":c,"status":"RESOLVED","authority":"REVISION_SCOPED_USER_CLARIFICATION"})
        elif valid:audit.append({"kind":k,"code":c,"status":"CONFLICT","authority":"REVISION_SCOPED_USER_CLARIFICATION"})
    return out,audit

def cardinal(az):
    az=az%360;return "N" if az>=315 or az<45 else "E" if az<135 else "S" if az<225 else "W"
def orientation(row):
    for k in ("orientation","cardinalOrientation","direction","facing"):
        m=re.search(r"\b(NORTH|SOUTH|EAST|WEST|N|S|E|W)\b",text(row.get(k)).upper())
        if m:return m.group(1)[0],"FIELD_"+k.upper()
    for k in ("azimuth","azimuthDeg","orientationDegrees","surfaceAzimuth"):
        x=num(row.get(k))
        if x is not None:return cardinal(x),"AZIMUTH_"+k.upper()
    for k in ("normal","surfaceNormal","outwardNormal"):
        v=row.get(k);x=y=None
        if isinstance(v,dict):x,y=num(v.get("x"),True),num(v.get("y"),True)
        elif isinstance(v,(list,tuple)) and len(v)>=2:x,y=num(v[0],True),num(v[1],True)
        if x is not None and y is not None and (abs(x)>1e-9 or abs(y)>1e-9):return cardinal(math.degrees(math.atan2(x,y))),"NORMAL_"+k.upper()
    m=re.search(r"\b(NORTH|SOUTH|EAST|WEST)\b"," ".join(text(row.get(k)) for k in ("evidence","description","assemblyType")),re.I);return (m.group(1).upper()[0],"EVIDENCE_TEXT") if m else (None,None)

def normalize_rows(module,rows):
    out=[];rep=[];missing=[]
    for i,r0 in enumerate(rows):
        r=dict(r0);k=text(r.get("kind")).lower();c,_=code(module,r)
        if k in {"window","door"} and actual_vt(r) is None:r["vt"]=MISSING_VT;r["visibleTransmittanceAuthority"]="REVEX_FIXED_MISSING_VT_0_45";rep.append({"tool":"APPLY_MISSING_VT_0_45","kind":k,"code":c or str(i+1),"vt":MISSING_VT})
        if k=="window" and not text(r.get("orientation")):
            o,a=orientation(r)
            if o:r["orientation"]=o;r["orientationAuthority"]="WALLT_"+a;rep.append({"tool":"DERIVE_CARDINAL_ORIENTATION","kind":k,"code":c or str(i+1),"orientation":o})
            else:missing.append({"kind":k,"code":c or str(i+1),"rowIndex":i+1})
        out.append(r)
    return out,rep,missing
