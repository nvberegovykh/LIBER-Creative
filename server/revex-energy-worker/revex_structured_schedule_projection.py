#!/usr/bin/env python3
"""Project reconciled native Revit schedule facts into a derived Energy request.

This stage runs before PDF recovery. It never edits source Engineering artifacts. Resolved current
schedule facts replace lower-authority page-scan versions in the derived copy. A structured conflict
removes that fact from the derived copy and is carried forward as a hard conflict marker so no later
PDF fallback can silently choose a side.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import revex_structured_schedule_facts as graph

SCHEMA = "liber.revex.structured-schedule-projection.v1"
VERSION = "20260816r101-projection1"
SCHEDULE_SCHEMA = "liber.revex.engineering-schedule-evidence.v1"
SCHEDULE_AUTHORITY = "active-revit-document-native-schedules"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _safe_name(value: Any) -> str:
    name = Path(_text(value) or "artifact").name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def _schedule_artifact(request: dict) -> Path | None:
    for raw in list(request.get("sourceArtifacts") or []):
        path = Path(_text(raw))
        if path.is_file() and _safe_name(path.name).lower().endswith("revit-schedule-evidence.json"):
            return path
    return None


def _load(path: Path | None) -> dict:
    if path is None or not path.is_file(): return {}
    try: data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception: return {}
    if _text(data.get("schema")) != SCHEDULE_SCHEMA or _text(data.get("authority")) != SCHEDULE_AUTHORITY:
        return {}
    return data


def _remove_bulk(facts: dict, key: str) -> int:
    removed = 0
    for page in list(facts.get("pages") or []):
        bulk = page.get("bulk")
        if isinstance(bulk, dict) and bulk.get(key) not in (None, ""):
            bulk[key] = None; removed += 1
    return removed


def _remove_floor_area(facts: dict) -> int:
    removed = 0
    semantic = facts.get("comcheckSemantic")
    if isinstance(semantic, dict) and semantic.get("floorAreaFt2") not in (None, ""):
        semantic["floorAreaFt2"] = None; removed += 1
    for page in list(facts.get("pages") or []):
        lighting = page.get("lighting")
        if isinstance(lighting, dict) and lighting.get("floorAreaFt2") not in (None, ""):
            lighting["floorAreaFt2"] = None; removed += 1
        bulk = page.get("bulk")
        if isinstance(bulk, dict):
            for key in ("conditionedFloorAreaFt2", "grossFloorAreaFt2"):
                if bulk.get(key) not in (None, ""):
                    bulk[key] = None; removed += 1
    return removed


def _page(facts: dict, source_file: str) -> dict:
    pages = facts.setdefault("pages", [])
    for page in pages:
        if page.get("sourceAuthority") == SCHEDULE_AUTHORITY and _safe_name(page.get("sourceFile")).lower() == _safe_name(source_file).lower():
            return page
    page = {
        "pageType": "Z", "sheetNumber": "REVIT-SCHEDULES", "sheetName": "NATIVE REVIT SCHEDULE FACT GRAPH",
        "sourceFile": source_file, "confidence": 1.0, "project": {}, "bulk": {}, "envelope": [],
        "sourceAuthority": SCHEDULE_AUTHORITY,
    }
    pages.append(page)
    return page


def resolve_request(request_path: Path, output_root: Path) -> Path:
    request_path = Path(request_path).resolve(); output_root = Path(output_root).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(_text(request.get("pageFactsPath")))
    if not page_path.is_file(): return request_path
    source = json.loads(page_path.read_text(encoding="utf-8")); facts = copy.deepcopy(source)
    schedule_path = _schedule_artifact(request); evidence = _load(schedule_path)
    if not evidence:
        return request_path

    resolved = graph.resolve_core(evidence)
    removed: dict[str, int] = {}
    conflicts = list(resolved.get("conflicts") or [])
    results = dict(resolved.get("facts") or {})

    for fact in ("buildingHeightFt", "stories"):
        row = dict(results.get(fact) or {})
        if row.get("status") not in {"RESOLVED", "CONFLICT"}: continue
        removed[fact] = _remove_bulk(facts, fact)
        if row.get("status") == "RESOLVED" and schedule_path is not None:
            target = _page(facts, schedule_path.name)
            target.setdefault("bulk", {})[fact] = row.get("value")
            target.setdefault("structuredScheduleFacts", {})[fact] = row

    floor = dict(results.get("floorAreaFt2") or {})
    if floor.get("status") in {"RESOLVED", "CONFLICT"}:
        removed["floorAreaFt2"] = _remove_floor_area(facts)
        if floor.get("status") == "RESOLVED":
            semantic = dict(facts.get("comcheckSemantic") or {})
            semantic["floorAreaFt2"] = floor.get("value")
            semantic["scheduleNamesAuthoritative"] = False
            sources = list(semantic.get("sources") or [])
            sources.append({"semanticType":"floorAreaFt2","method":"STRUCTURED_NATIVE_REVIT_SCHEDULE_RECONCILIATION","candidates":floor.get("candidates") or []})
            semantic["sources"] = sources
            facts["comcheckSemantic"] = semantic

    audit = {
        "schema": SCHEMA, "version": VERSION, "sourceEngineeringRevision": _text(request.get("revision")),
        "scheduleArtifact": schedule_path.name if schedule_path else None,
        "factGraph": resolved, "removedLowerAuthorityValues": removed,
        "conflicts": conflicts, "status": "CONFLICT" if conflicts else "APPLIED",
        "sourceEvidenceMutated": False,
    }
    audit_path = output_root / "STRUCTURED_SCHEDULE_PROJECTION_R101.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")

    if facts == source and not conflicts:
        return request_path
    facts_path = output_root / "00_PAGE_FACTS_STRUCTURED_SCHEDULE_R101.json"
    facts_path.write_text(json.dumps(facts, ensure_ascii=True, indent=2), encoding="utf-8")
    derived = dict(request)
    derived["pageFactsPath"] = str(facts_path)
    derived["structuredScheduleProjection"] = {
        "schema": SCHEMA, "version": VERSION, "auditFile": audit_path.name,
        "conflicts": conflicts, "scheduleArtifact": schedule_path.name if schedule_path else None,
    }
    path = output_root / "00_PIPELINE_REQUEST_STRUCTURED_SCHEDULE_R101.json"
    path.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({"stage":"STRUCTURED_SCHEDULE_R101","status":audit["status"],"conflicts":conflicts,
                      "resolved":[name for name,row in results.items() if row.get("status")=="RESOLVED"]}), flush=True)
    return path
