#!/usr/bin/env python3
"""Project exact native Revit EN schedules into missing COMcheck envelope orientation.

This is a narrow current-runtime repair. The immutable Engineering schedule snapshot is
already captured from the active Revit document with exact visible cells and sheet
placements. This module consumes only schedules placed on EN sheets and fills only a
missing wall/window/door orientation in the derived Energy facts when one unambiguous
current-schedule row matches the existing current EN envelope row.

It never reads model surfaces, never imports reference-project orientation/geometry, and
never mutates the immutable Engineering evidence artifact.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

SCHEMA = "liber.revex.native-en-schedule-orientation.v1"
VERSION = "20260818-current-orientation1"
SCHEDULE_SCHEMA = "liber.revex.engineering-schedule-evidence.v1"
SCHEDULE_AUTHORITY = "active-revit-document-native-schedules"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    match = re.search(r"(?<![A-Za-z0-9])-?\d[\d,]*(?:\.\d+)?", _text(value))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _code(value: Any) -> str:
    match = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", _text(value).upper())
    return match.group(1) if match else ""


def _orientation(value: Any) -> str:
    token = re.sub(r"[^A-Z]", "", _text(value).upper())
    return {
        "N": "NORTH", "NORTH": "NORTH",
        "S": "SOUTH", "SOUTH": "SOUTH",
        "E": "EAST", "EAST": "EAST",
        "W": "WEST", "WEST": "WEST",
    }.get(token, "")


def _headings(schedule: dict) -> list[str]:
    fields = [row for row in list(schedule.get("fields") or []) if not bool(row.get("hidden"))]
    field_headings = [_text(row.get("columnHeading") or row.get("name")) for row in fields]
    header_rows = [[_text(v) for v in list(row or [])] for row in list(schedule.get("headerRows") or [])]
    body_rows = [list(row or []) for row in list(schedule.get("bodyRows") or [])]
    width = max([len(field_headings), *(len(row) for row in header_rows), *(len(row) for row in body_rows), 0])
    out: list[str] = []
    for col in range(width):
        tokens: list[str] = []
        for row in header_rows:
            value = _text(row[col]) if col < len(row) else ""
            if value and _norm(value) not in {_norm(existing) for existing in tokens}:
                tokens.append(value)
        if col < len(field_headings):
            value = field_headings[col]
            if value and _norm(value) not in {_norm(existing) for existing in tokens}:
                tokens.append(value)
        out.append(" / ".join(tokens))
    return out


def _columns(headings: list[str], predicate) -> list[int]:
    return [i for i, heading in enumerate(headings) if predicate(_norm(heading))]


def _first_number(row: list[str], cols: list[int]) -> float | None:
    for col in cols:
        if col < len(row):
            value = _number(row[col])
            if value is not None:
                return value
    return None


def _first_text(row: list[str], cols: list[int]) -> str:
    for col in cols:
        if col < len(row) and _text(row[col]):
            return _text(row[col])
    return ""


def _en_placements(schedule: dict) -> list[dict]:
    return [
        dict(row) for row in list(schedule.get("placedOnSheets") or [])
        if _text(row.get("sheetNumber")).upper().startswith("EN")
    ]


def _schedule_kind(schedule: dict, headings: list[str]) -> str:
    placement_text = " ".join(
        f"{_text(row.get('sheetNumber'))} {_text(row.get('sheetName'))}"
        for row in _en_placements(schedule)
    )
    context = _norm(f"{_text(schedule.get('name'))} {' '.join(headings)} {placement_text}")
    if "shgc" in context or "fenestration" in context or "window" in context:
        return "window"
    if "door" in context:
        return "door"
    if "wall" in context:
        return "wall"
    return ""


def _schedule_candidates(evidence: dict) -> list[dict]:
    rows: list[dict] = []
    for schedule in list(evidence.get("schedules") or []):
        placements = _en_placements(schedule)
        if not placements:
            continue
        headings = _headings(schedule)
        orientation_cols = _columns(headings, lambda h: any(token in h for token in ("orientation", "direction", "exposure")))
        if not orientation_cols:
            continue
        area_cols = _columns(headings, lambda h: "area" in h and not any(token in h for token in ("percent", "%")))
        u_cols = _columns(headings, lambda h: "u factor" in h or "u value" in h or "ufactor" in h or "uvalue" in h)
        shgc_cols = _columns(headings, lambda h: "shgc" in h)
        code_cols = _columns(headings, lambda h: any(token in h for token in ("type mark", "assembly type", "assembly", "mark", "tag", "type")))
        kind = _schedule_kind(schedule, headings)
        for row_index, raw in enumerate(list(schedule.get("bodyRows") or [])):
            row = [_text(value) for value in list(raw or [])]
            orientation = _orientation(_first_text(row, orientation_cols))
            if not orientation:
                continue
            row_text = " | ".join(value for value in row if value)
            if re.search(r"\bgrand\s+total\b|^\s*total(?:s)?\s*$", row_text, re.I):
                continue
            label = _first_text(row, code_cols) or row_text
            rows.append({
                "kind": kind,
                "orientation": orientation,
                "code": _code(label) or _code(row_text),
                "area": _first_number(row, area_cols),
                "uFactor": _first_number(row, u_cols),
                "shgc": _first_number(row, shgc_cols),
                "scheduleName": _text(schedule.get("name")),
                "scheduleUniqueId": _text(schedule.get("uniqueId")),
                "rowIndex": row_index,
                "label": label,
                "cellText": row_text,
                "placements": placements,
            })
    return rows


def _close(actual: float | None, expected: float | None, *, absolute: float, relative: float = 0.0) -> bool:
    if actual is None or expected is None:
        return True
    return abs(float(actual) - float(expected)) <= max(absolute, abs(float(expected)) * relative)


def _match(row: dict, candidates: list[dict]) -> tuple[str, dict | None]:
    kind = _text(row.get("kind")).lower()
    source_text = " ".join(_text(row.get(key)) for key in ("assemblyType", "description", "evidence", "product"))
    code = _code(source_text)
    area = _number(row.get("grossAreaFt2"))
    u_factor = _number(row.get("uFactor"))
    shgc = _number(row.get("shgc"))

    pool = [candidate for candidate in candidates if not candidate.get("kind") or candidate.get("kind") == kind]
    if code:
        same_code = [candidate for candidate in pool if candidate.get("code") == code]
        if same_code:
            pool = same_code
    pool = [candidate for candidate in pool
            if _close(candidate.get("area"), area, absolute=0.75, relative=0.015)
            and _close(candidate.get("uFactor"), u_factor, absolute=0.01)
            and _close(candidate.get("shgc"), shgc, absolute=0.015)]
    orientations = sorted({candidate.get("orientation") for candidate in pool if candidate.get("orientation")})
    if len(orientations) != 1:
        return "", None
    orientation = orientations[0]
    proof_rows = [candidate for candidate in pool if candidate.get("orientation") == orientation]
    proof = proof_rows[0] if proof_rows else None
    return orientation, proof


def apply_missing_orientations(request_path: Path, schedule_path: Path | None) -> dict:
    request_path = Path(request_path).resolve()
    audit = {
        "schema": SCHEMA,
        "version": VERSION,
        "status": "NO_CHANGE",
        "sourceEvidenceMutated": False,
        "authority": SCHEDULE_AUTHORITY,
        "scheduleArtifact": schedule_path.name if schedule_path else None,
        "filled": [],
        "unresolved": [],
    }
    if schedule_path is None or not Path(schedule_path).is_file() or not request_path.is_file():
        return audit
    try:
        evidence = json.loads(Path(schedule_path).read_text(encoding="utf-8-sig"))
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except Exception:
        return audit
    if _text(evidence.get("schema")) != SCHEDULE_SCHEMA or _text(evidence.get("authority")) != SCHEDULE_AUTHORITY:
        return audit
    facts_path = Path(_text(request.get("pageFactsPath")))
    if not facts_path.is_file():
        return audit
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    candidates = _schedule_candidates(evidence)
    audit["candidateRows"] = len(candidates)
    changed = False
    for page in list(facts.get("pages") or []):
        if _text(page.get("pageType")).upper() != "EN":
            continue
        for row_index, row in enumerate(list(page.get("envelope") or []), start=1):
            kind = _text(row.get("kind")).lower()
            if kind not in {"wall", "window", "door"} or _orientation(row.get("orientation")):
                continue
            orientation, proof = _match(row, candidates)
            label = _code(" ".join(_text(row.get(key)) for key in ("assemblyType", "description", "evidence"))) or f"{kind} row {row_index}"
            if not orientation or proof is None:
                audit["unresolved"].append({"sheetNumber": page.get("sheetNumber"), "kind": kind, "row": row_index, "label": label})
                continue
            row["orientation"] = orientation
            row["orientationAuthority"] = SCHEDULE_AUTHORITY
            row["orientationEvidence"] = {
                "scheduleName": proof.get("scheduleName"),
                "scheduleUniqueId": proof.get("scheduleUniqueId"),
                "rowIndex": proof.get("rowIndex"),
                "label": proof.get("label"),
                "placements": proof.get("placements"),
            }
            audit["filled"].append({
                "sheetNumber": page.get("sheetNumber"), "kind": kind, "row": row_index,
                "label": label, "orientation": orientation,
                "scheduleName": proof.get("scheduleName"), "scheduleRow": proof.get("rowIndex"),
            })
            changed = True
    if changed:
        facts_path.write_text(json.dumps(facts, ensure_ascii=True, indent=2), encoding="utf-8")
        audit["status"] = "APPLIED"
    elif audit["unresolved"]:
        audit["status"] = "UNRESOLVED"
    return audit
