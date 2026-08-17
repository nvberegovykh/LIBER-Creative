#!/usr/bin/env python3
"""Structured current-Revit schedule fact graph for REVEX Energy.

The input is REVIT-SCHEDULE-EVIDENCE.json captured during the same Engineering Sync as gbXML.
No schedule name, sheet number, or project value is globally authoritative. Facts are recognized
from row/column semantics, retain exact sheet/schedule/cell provenance, and are accepted only when
all equally valid current-revision candidates agree. Conflicts remain unresolved and are surfaced.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any
import re

SCHEMA = "liber.revex.structured-schedule-facts.v1"
VERSION = "20260816r102-fact-graph2"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _feet(value: Any) -> float | None:
    text = _text(value)
    match = re.search(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*'\s*(?:-\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*\")?", text)
    if match:
        feet = float(match.group(1)); inches = float(match.group(2)) if match.group(2) else 0.0
        if 1 <= feet <= 1000 and 0 <= inches < 12:
            return feet + inches / 12.0
    match = re.search(r"(?<![A-Za-z0-9])(\d{1,3}(?:\.\d+)?)\s*(?:FT|FEET)\b", text, re.I)
    if match:
        value = float(match.group(1))
        return value if 1 <= value <= 1000 else None
    return None


def _positive_number(value: Any) -> float | None:
    match = re.search(r"(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)", _text(value))
    if not match:
        return None
    try: number = float(match.group(1).replace(",", ""))
    except ValueError: return None
    return number if number > 0 else None


def _int(value: Any) -> int | None:
    match = re.search(r"(?<!\d)(\d{1,3})(?!\d)", _text(value))
    if not match:
        return None
    number = int(match.group(1))
    return number if 1 <= number <= 200 else None


def _column_headings(schedule: dict) -> list[str]:
    """Reconstruct native Revit headings across fields + all visible header rows.

    Revit schedules frequently use generic ScheduleField names while the user-visible semantic
    labels (for example PROPOSED/PROVIDED) live in merged/multi-row headers. Energy must follow
    the visible table, not assume field names are the presentation header.
    """
    fields = [row for row in list(schedule.get("fields") or []) if not bool(row.get("hidden"))]
    field_headings = [_text(row.get("columnHeading") or row.get("name")) for row in fields]
    header_rows = [[_text(value) for value in list(raw or [])] for raw in list(schedule.get("headerRows") or [])]
    body_rows = [list(raw or []) for raw in list(schedule.get("bodyRows") or [])]
    width = max([len(field_headings), *(len(row) for row in header_rows), *(len(row) for row in body_rows), 0])
    headings: list[str] = []
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
        headings.append(" / ".join(tokens))
    return headings


def _placements(schedule: dict) -> list[dict]:
    rows = []
    for raw in list(schedule.get("placedOnSheets") or []):
        rows.append({
            "sheetNumber": _text(raw.get("sheetNumber")),
            "sheetName": _text(raw.get("sheetName")),
            "sheetUniqueId": _text(raw.get("sheetUniqueId")),
            "instanceUniqueId": _text(raw.get("instanceUniqueId")),
        })
    return rows


def _proposed_columns(headings: list[str]) -> list[int]:
    indexes = []
    for i, heading in enumerate(headings):
        h = _norm(heading)
        if not re.search(r"\b(?:proposed|provided)\b", h):
            continue
        if re.search(r"\b(?:permitted|required|allowable|maximum|max)\b", h):
            continue
        indexes.append(i)
    return indexes


@dataclass(frozen=True)
class Candidate:
    fact: str
    value: Any
    unit: str
    scheduleName: str
    scheduleUniqueId: str
    rowIndex: int
    rowLabel: str
    columnIndex: int
    columnHeading: str
    cellText: str
    placements: tuple
    semanticRule: str

    def json(self) -> dict:
        row = asdict(self)
        row["placements"] = [dict(item) for item in self.placements]
        return row


def _candidate(schedule: dict, *, fact: str, value: Any, unit: str, row_index: int,
               row_label: str, column_index: int, column_heading: str, cell_text: str,
               semantic_rule: str) -> Candidate:
    placements = tuple(tuple(sorted(item.items())) for item in _placements(schedule))
    return Candidate(
        fact=fact, value=value, unit=unit,
        scheduleName=_text(schedule.get("name")), scheduleUniqueId=_text(schedule.get("uniqueId")),
        rowIndex=row_index, rowLabel=row_label, columnIndex=column_index,
        columnHeading=column_heading, cellText=cell_text, placements=placements,
        semanticRule=semantic_rule,
    )


def _row_label(row: list[str], proposed_indexes: list[int]) -> str:
    # Prefer descriptive cells to code/table-number cells. Keep exact source text in provenance.
    non_values = [value for i, value in enumerate(row) if i not in proposed_indexes and _text(value)]
    if not non_values:
        return ""
    descriptive = [value for value in non_values if re.search(r"[A-Za-z]{3,}", value) and not re.fullmatch(r"(?:BC\s*)?\d+(?:\.\d+)*(?:/\d+(?:\.\d+)*)?", _text(value), re.I)]
    return max(descriptive or non_values, key=lambda value: len(_text(value)))


def building_height_candidates(evidence: dict) -> list[Candidate]:
    """Current building height above grade plane, never base height or occupied-floor height."""
    out: list[Candidate] = []
    for schedule in list(evidence.get("schedules") or []):
        headings = _column_headings(schedule); proposed = _proposed_columns(headings)
        if not proposed:
            continue
        for r_index, raw in enumerate(list(schedule.get("bodyRows") or [])):
            row = [_text(value) for value in list(raw or [])]
            label = _row_label(row, proposed)
            semantic = _norm(label)
            # Accept exact building-height-above-grade semantics, including the common "hight" typo.
            # Exclude base height, highest occupied floor, story height, parapet, penthouse and bulkhead.
            if not re.search(r"\bbuilding (?:height|hight) above grade plane\b", semantic):
                continue
            if any(token in semantic for token in ("base height", "occupied floor", "story height", "parapet", "penthouse", "bulkhead")):
                continue
            for col in proposed:
                if col >= len(row):
                    continue
                value = _feet(row[col])
                if value is None:
                    continue
                out.append(_candidate(schedule, fact="buildingHeightFt", value=round(value, 6), unit="ft",
                                      row_index=r_index, row_label=label, column_index=col,
                                      column_heading=headings[col], cell_text=row[col],
                                      semantic_rule="BUILDING_HEIGHT_ABOVE_GRADE_PLANE + PROPOSED/PROVIDED"))
    return out


def stories_candidates(evidence: dict) -> list[Candidate]:
    out: list[Candidate] = []
    for schedule in list(evidence.get("schedules") or []):
        headings = _column_headings(schedule); proposed = _proposed_columns(headings)
        if not proposed:
            continue
        for r_index, raw in enumerate(list(schedule.get("bodyRows") or [])):
            row = [_text(value) for value in list(raw or [])]
            label = _row_label(row, proposed); semantic = _norm(label)
            if not re.search(r"\bnumber of stor(?:y|ies) above grade plane\b", semantic):
                continue
            for col in proposed:
                if col >= len(row):
                    continue
                value = _int(row[col])
                if value is None:
                    continue
                out.append(_candidate(schedule, fact="stories", value=value, unit="count", row_index=r_index,
                                      row_label=label, column_index=col, column_heading=headings[col], cell_text=row[col],
                                      semantic_rule="NUMBER_OF_STORIES_ABOVE_GRADE_PLANE + PROPOSED/PROVIDED"))
    return out


def zoning_gross_area_candidates(evidence: dict) -> list[Candidate]:
    """Gross Area total from a current zoning/area-calculation schedule; excludes BC Gross and ZFA."""
    out: list[Candidate] = []
    for schedule in list(evidence.get("schedules") or []):
        headings = _column_headings(schedule)
        gross_cols = [i for i, heading in enumerate(headings)
                      if "gross area" in _norm(heading)
                      and not any(token in _norm(heading) for token in ("bc gross area", "deduction", "zoning floor area"))]
        if not gross_cols: continue
        context = _norm(_text(schedule.get("name")) + " " + " ".join(headings))
        if not any(token in context for token in ("zoning", "area calculation", "area calc")): continue
        for r_index, raw in enumerate(list(schedule.get("bodyRows") or [])):
            row = [_text(value) for value in list(raw or [])]
            if not any(re.search(r"\btotal(?:s)?\b", value, re.I) for value in row): continue
            for col in gross_cols:
                if col >= len(row): continue
                value = _positive_number(row[col])
                if value is None: continue
                out.append(_candidate(schedule, fact="floorAreaFt2", value=round(value, 6), unit="ft2",
                                      row_index=r_index, row_label="Totals", column_index=col,
                                      column_heading=headings[col], cell_text=row[col],
                                      semantic_rule="ZONING_AREA_CALCULATION_TOTAL + GROSS_AREA_COLUMN"))
    return out


def _energy_code_value(value: Any) -> str | None:
    source = _text(value)
    patterns = (
        r"\b(20\d{2})\s+(?:NEW\s+YORK\s+CITY|NYC)\s+ENERGY\s+CONSERVATION\s+CODE\b",
        r"\b(20\d{2})\s+NYCECC\b(?:\s+APPENDIX\s+CA)?",
        r"\b(20\d{2})\s+NYC\s+ENERGY\s+CODE\b",
    )
    for pattern in patterns:
        match = re.search(pattern, source, re.I)
        if match:
            return f"{match.group(1)} NYCECC"
    return None


def energy_code_candidates(evidence: dict) -> list[Candidate]:
    """Explicit current-project NYC Energy Conservation Code text from native Revit schedules."""
    out: list[Candidate] = []
    for schedule in list(evidence.get("schedules") or []):
        headings = _column_headings(schedule)
        rows = [[_text(value) for value in list(raw or [])] for raw in list(schedule.get("headerRows") or [])]
        rows += [[_text(value) for value in list(raw or [])] for raw in list(schedule.get("bodyRows") or [])]
        header_count = len(list(schedule.get("headerRows") or []))
        for index, row in enumerate(rows):
            for col, cell in enumerate(row):
                value = _energy_code_value(cell)
                if value is None:
                    continue
                row_index = index - header_count if index >= header_count else -1 - index
                out.append(_candidate(schedule, fact="energyCode", value=value, unit="code",
                                      row_index=row_index, row_label="Explicit energy-code text",
                                      column_index=col, column_heading=headings[col] if col < len(headings) else "",
                                      cell_text=cell,
                                      semantic_rule="EXPLICIT_CURRENT_REVIT_NYCECC_TEXT"))
    return out


def _resolve(fact: str, candidates: list[Candidate], tolerance: float = 1e-6) -> dict:
    rows = [row.json() for row in candidates]
    if not candidates:
        return {"fact": fact, "status": "MISSING", "value": None, "candidates": []}
    numeric = all(isinstance(row.value, (int, float)) for row in candidates)
    if numeric:
        groups: list[list[Candidate]] = []
        for row in candidates:
            placed = False
            for group in groups:
                if abs(float(group[0].value) - float(row.value)) <= tolerance:
                    group.append(row); placed = True; break
            if not placed: groups.append([row])
    else:
        by: dict[str, list[Candidate]] = {}
        for row in candidates: by.setdefault(str(row.value), []).append(row)
        groups = list(by.values())
    if len(groups) != 1:
        return {"fact": fact, "status": "CONFLICT", "value": None, "candidates": rows,
                "distinctValues": [group[0].value for group in groups]}
    return {"fact": fact, "status": "RESOLVED", "value": groups[0][0].value,
            "candidates": rows, "corroboratingCandidateCount": len(candidates)}


def resolve_core(evidence: dict) -> dict:
    results = {
        "energyCode": _resolve("energyCode", energy_code_candidates(evidence)),
        "buildingHeightFt": _resolve("buildingHeightFt", building_height_candidates(evidence), tolerance=0.01),
        "stories": _resolve("stories", stories_candidates(evidence), tolerance=0),
        "floorAreaFt2": _resolve("floorAreaFt2", zoning_gross_area_candidates(evidence), tolerance=0.1),
    }
    return {"schema": SCHEMA, "version": VERSION, "facts": results,
            "conflicts": [name for name, row in results.items() if row["status"] == "CONFLICT"],
            "missing": [name for name, row in results.items() if row["status"] == "MISSING"]}
