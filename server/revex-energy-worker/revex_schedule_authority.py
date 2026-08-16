#!/usr/bin/env python3
"""Exact structured-schedule authority rules for managed REVEX Energy.

This module is deliberately narrow. It does not infer project facts from arbitrary schedule text.
For building height, the authority is exactly the current native Revit schedule named
"BC CODE ANALYSIS", row "MAX BUILDING HEIGHT" (or the fully spelled equivalent), column
"PROVIDED / PROPOSED". Any other source is removed at the worker boundary.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
from typing import Any

SCHEDULE_SCHEMA = "liber.revex.engineering-schedule-evidence.v1"
SCHEDULE_AUTHORITY = "active-revit-document-native-schedules"
SCHEMA = "liber.revex.schedule-authority.v1"
VERSION = "20260816r101-bc-code-analysis1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _safe_name(value: Any) -> str:
    name = Path(_text(value) or "artifact").name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def _schedule_artifact(request: dict) -> Path | None:
    for raw in list(request.get("sourceArtifacts") or []):
        path = Path(_text(raw))
        if path.is_file() and _safe_name(path.name).lower().endswith("revit-schedule-evidence.json"):
            return path
    return None


def _load_schedule(path: Path | None) -> dict:
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    if _text(data.get("schema")) != SCHEDULE_SCHEMA or _text(data.get("authority")) != SCHEDULE_AUTHORITY:
        return {}
    return data


def _headings(schedule: dict) -> list[str]:
    fields = [row for row in list(schedule.get("fields") or []) if not bool(row.get("hidden"))]
    values = [_text(row.get("columnHeading") or row.get("name")) for row in fields]
    if any(values):
        return values
    rows = list(schedule.get("headerRows") or [])
    return [_text(value) for value in list(rows[-1] or [])] if rows else []


def _feet(value: Any) -> float | None:
    text = _text(value)
    if not text:
        return None
    match = re.search(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*'\s*(?:-\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*\")?", text)
    if match:
        feet = float(match.group(1))
        inches = float(match.group(2)) if match.group(2) else 0.0
        if 0 <= inches < 12 and 1 <= feet <= 1000:
            return feet + inches / 12.0
    match = re.search(r"(?<![A-Za-z0-9])(\d{1,3}(?:\.\d+)?)\s*(?:FT|FEET)\b", text, re.I)
    if match:
        feet = float(match.group(1))
        return feet if 1 <= feet <= 1000 else None
    return None


def exact_bc_code_analysis_height(evidence: dict) -> dict | None:
    """Return exactly one BC CODE ANALYSIS / MAX BUILDING HEIGHT / PROVIDED-PROPOSED fact."""
    matches: list[dict] = []
    for schedule in list(evidence.get("schedules") or []):
        if _norm(schedule.get("name")) != "bc code analysis":
            continue
        headings = _headings(schedule)
        provided = [index for index, heading in enumerate(headings) if _norm(heading) == "provided proposed"]
        if len(provided) != 1:
            continue
        provided_index = provided[0]
        for raw_row in list(schedule.get("bodyRows") or []):
            row = [_text(value) for value in list(raw_row or [])]
            labels = [index for index, value in enumerate(row) if _norm(value) in {"max building height", "maximum building height"}]
            if len(labels) != 1 or provided_index >= len(row):
                continue
            height = _feet(row[provided_index])
            if height is None:
                continue
            matches.append({
                "value": round(height, 6),
                "scheduleName": _text(schedule.get("name")),
                "scheduleUniqueId": _text(schedule.get("uniqueId")),
                "rowLabel": row[labels[0]],
                "columnHeading": headings[provided_index],
                "cellText": row[provided_index],
            })
    if not matches:
        return None
    distinct = {round(float(row["value"]), 6) for row in matches}
    if len(distinct) != 1 or len(matches) != 1:
        return None
    return matches[0]


def _remove_height(facts: dict) -> int:
    removed = 0
    for page in list(facts.get("pages") or []):
        bulk = page.get("bulk")
        if isinstance(bulk, dict) and bulk.get("buildingHeightFt") not in (None, ""):
            bulk["buildingHeightFt"] = None
            removed += 1
    return removed


def _authority_page(facts: dict, source_file: str) -> dict:
    pages = facts.setdefault("pages", [])
    for page in pages:
        if page.get("sourceAuthority") == SCHEDULE_AUTHORITY and _safe_name(page.get("sourceFile")).lower() == _safe_name(source_file).lower():
            return page
    page = {
        "pageType": "Z",
        "sheetNumber": "REVIT-SCHEDULES",
        "sheetName": "BC CODE ANALYSIS",
        "sourceFile": source_file,
        "confidence": 1.0,
        "project": {},
        "bulk": {},
        "envelope": [],
        "sourceAuthority": SCHEDULE_AUTHORITY,
    }
    pages.append(page)
    return page


def enforce_request(request_path: Path, output_root: Path, *, phase: str) -> Path:
    request_path = Path(request_path).resolve()
    output_root = Path(output_root).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(_text(request.get("pageFactsPath")))
    if not page_path.is_file():
        return request_path
    source_facts = json.loads(page_path.read_text(encoding="utf-8"))
    facts = copy.deepcopy(source_facts)
    schedule_path = _schedule_artifact(request)
    schedule = _load_schedule(schedule_path)
    exact = exact_bc_code_analysis_height(schedule) if schedule else None
    removed = _remove_height(facts)
    if exact is not None and schedule_path is not None:
        page = _authority_page(facts, schedule_path.name)
        page.setdefault("bulk", {})["buildingHeightFt"] = exact["value"]
        page["scheduleAuthority"] = {
            "scheduleName": exact["scheduleName"],
            "scheduleUniqueId": exact["scheduleUniqueId"],
            "rowLabel": exact["rowLabel"],
            "columnHeading": exact["columnHeading"],
            "cellText": exact["cellText"],
        }

    audit = {
        "schema": SCHEMA,
        "version": VERSION,
        "phase": phase,
        "sourceEngineeringRevision": _text(request.get("revision")),
        "scheduleArtifact": schedule_path.name if schedule_path else None,
        "requiredAuthority": {
            "schedule": "BC CODE ANALYSIS",
            "row": "MAX BUILDING HEIGHT",
            "column": "PROVIDED / PROPOSED",
        },
        "priorHeightValuesRemoved": removed,
        "buildingHeight": exact,
        "status": "PASSED" if exact is not None else "MISSING_EXACT_BC_CODE_ANALYSIS_HEIGHT",
        "sourceEvidenceMutated": False,
    }
    audit_path = output_root / f"SCHEDULE_AUTHORITY_R101_{phase.upper()}.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")

    changed = facts != source_facts
    if not changed:
        print(json.dumps({"stage":"SCHEDULE_AUTHORITY_R101","phase":phase,"status":audit["status"]}), flush=True)
        return request_path

    facts_path = output_root / f"00_PAGE_FACTS_SCHEDULE_AUTHORITY_R101_{phase.upper()}.json"
    facts_path.write_text(json.dumps(facts, ensure_ascii=True, indent=2), encoding="utf-8")
    derived = dict(request)
    derived["pageFactsPath"] = str(facts_path)
    derived["scheduleAuthorityR101"] = {
        "phase": phase,
        "auditFile": audit_path.name,
        "buildingHeightAuthoritySatisfied": exact is not None,
    }
    request_copy = output_root / f"00_PIPELINE_REQUEST_SCHEDULE_AUTHORITY_R101_{phase.upper()}.json"
    request_copy.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage":"SCHEDULE_AUTHORITY_R101",
        "phase":phase,
        "status":audit["status"],
        "heightFt": exact["value"] if exact else None,
    }), flush=True)
    return request_copy
