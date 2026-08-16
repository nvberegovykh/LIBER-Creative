#!/usr/bin/env python3
"""REVEX current-project COMcheck evidence resolution.

r101 keeps the r100 immutable T/Z/EN PDF recovery, but puts a stronger source in front of it:
the native Revit schedule snapshot captured during the same fresh Engineering Sync as gbXML.
Reference-project files remain structure/templates only; current values always come from the
current immutable Engineering revision.

Rules:
- never mutate source artifacts or original page facts;
- never use template/project-reference identity or quantities;
- structured native Revit schedules are deterministic current-project evidence and are consumed
  before PDF/AI recovery;
- PDF/AI remains a bounded fallback only for facts not proven by structured schedules;
- COMcheck whole-building floor area prefers the current Zoning Analysis Area Calculation
  table's Gross Area total, never BC Gross, deductions, zoning floor area, modeled area or a
  reference-project value;
- every structured envelope row must carry an exact schedule source, area, assembly label and the
  thermal/orientation fields required by its kind;
- the pinned r49 pipeline remains the final semantic/schema validator.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
from typing import Any, Callable

from revex_cloud_project import resolve_vertex_project

SCHEMA = "liber.revex.comcheck-evidence-resolution.v1"
VERSION = "20260816r101-structured-schedule1"
MIN_CONFIDENCE = 0.90
MAX_AGENT_PDFS = 8
SCHEDULE_SCHEMA = "liber.revex.engineering-schedule-evidence.v1"
SCHEDULE_AUTHORITY = "active-revit-document-native-schedules"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _flat(value: Any) -> str:
    return re.sub(r"\s+", " ", _text(value)).strip()


def _safe_name(value: Any) -> str:
    name = Path(_text(value) or "artifact").name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _first_number(value: Any) -> float | None:
    match = re.search(r"(?<![A-Za-z0-9])(-?\d[\d,]*(?:\.\d+)?)", _text(value))
    if not match:
        return None
    try:
        number = float(match.group(1).replace(",", ""))
    except ValueError:
        return None
    return number if number > 0 else None


def _pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
        return "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
    except Exception:
        return ""


def _artifact_paths(request: dict) -> dict[str, Path]:
    output: dict[str, Path] = {}
    for raw in list(request.get("sourceArtifacts") or []):
        path = Path(_text(raw))
        if path.is_file():
            output[_safe_name(path.name).lower()] = path
    return output


def _source_pages(facts: dict, artifacts: dict[str, Path]) -> list[dict]:
    rows: list[dict] = []
    for page in list(facts.get("pages") or []):
        page_type = _text(page.get("pageType")).upper()
        if page_type not in {"T", "Z", "EN"}:
            continue
        source = _safe_name(page.get("sourceFile") or "").lower()
        path = artifacts.get(source)
        if not path or path.suffix.lower() != ".pdf":
            continue
        rows.append({"page": page, "path": path, "source": source, "pageType": page_type})
    return rows


def _find_page_row(facts: dict, source: str) -> dict | None:
    target = _safe_name(source).lower()
    for page in list(facts.get("pages") or []):
        if _safe_name(page.get("sourceFile") or "").lower() == target:
            return page
    return None


def _set_page_value(page: dict, section: str, key: str, value: Any) -> None:
    current = dict(page.get(section) or {})
    if current.get(key) in (None, "", []):
        current[key] = value
        page[section] = current


def _extract_energy_code(text: str) -> str:
    source = _flat(text)
    patterns = (
        r"\b2020\s+(?:NEW\s+YORK\s+CITY|NYC)\s+ENERGY\s+CONSERVATION\s+CODE\b",
        r"\b2020\s+NYCECC\b(?:\s+APPENDIX\s+CA)?",
        r"\b2020\s+NYC\s+ENERGY\s+CODE\b",
    )
    for pattern in patterns:
        match = re.search(pattern, source, re.I)
        if match:
            return _flat(match.group(0))
    return ""


def _extract_stories(text: str) -> int | None:
    source = _flat(text)
    candidates: list[int] = []
    for pattern in (
        r"\bPROPOSED\s+(\d{1,2})\s+STOR(?:Y|IES)\b",
        r"\b(\d{1,2})\s+STOR(?:Y|IES)\s+(?:WITH|W/)\s+PENTHOUSE\b",
    ):
        for match in re.finditer(pattern, source, re.I):
            value = int(match.group(1))
            if 1 <= value <= 100:
                candidates.append(value)
    return candidates[0] if candidates else None


def _feet_tokens(value: str) -> list[float]:
    values: list[float] = []
    for match in re.finditer(r"(?<!\d)(\d{1,3}(?:\.\d+)?)\s*'", value):
        number = float(match.group(1))
        inches_match = re.match(r"\s*-?\s*(\d{1,2}(?:\.\d+)?)\s*\"", value[match.end():])
        if inches_match:
            number += float(inches_match.group(1)) / 12.0
        if 1 <= number <= 1000:
            values.append(number)
    return values


def _extract_height(text: str) -> float | None:
    lines = [line for line in str(text or "").splitlines() if line.strip()]
    preferred = []
    for line in lines:
        upper = _flat(line).upper()
        if "MAX BUILDING HEIGHT" in upper or "MAXIMUM BUILDING HEIGHT" in upper:
            preferred.append(line)
    source = _flat(text)
    for match in re.finditer(r"MAX(?:IMUM)?\s+BUILDING\s+HEIGHT", source, re.I):
        preferred.append(source[match.start():match.start() + 120])
    for row in preferred:
        values = _feet_tokens(row)
        if values:
            return values[-1]
    return None


def _extract_zoning_gross_area(text: str) -> float | None:
    source = _flat(text)
    heading = re.search(r"ZONING\s+ANALYSIS\s+AREA\s+CALCULATION", source, re.I)
    if not heading:
        return None
    section = source[heading.start():heading.start() + 3500]
    if not re.search(r"BC\s+GROSS\s+AREA", section, re.I):
        return None
    if not re.search(r"GROSS\s+AREA\s+DEDUCTION\s+AREA", section, re.I):
        return None
    match = re.search(
        r"TOTALS?\s*:?\s*([0-9][0-9,]*(?:\.\d+)?)\s*SF\s+([0-9][0-9,]*(?:\.\d+)?)\s*SF",
        section, re.I,
    )
    if not match:
        return None
    return _number(match.group(2))


def _extract_multifamily(text: str) -> bool:
    source = _flat(text).lower()
    r2 = bool(re.search(r"\boccupancy\s+group\s*:?\s*r\s*-?\s*2\b", source, re.I))
    residential = any(token in source for token in ("residential building", "multiple dwelling", "dwelling units", "d.u."))
    return r2 and residential


def _missing_core(facts: dict) -> list[str]:
    pages = list(facts.get("pages") or [])
    tz = [p for p in pages if _text(p.get("pageType")).upper() in {"T", "Z"}]
    en = [p for p in pages if _text(p.get("pageType")).upper() == "EN"]
    semantic = dict(facts.get("comcheckSemantic") or {})

    def best(rows: list[dict], section: str, key: str):
        candidates = []
        for page in rows:
            value = (page.get(section) or {}).get(key)
            if value not in (None, "", []):
                candidates.append((float(page.get("confidence") or 0), value))
        candidates.sort(reverse=True, key=lambda row: row[0])
        return candidates[0][1] if candidates else None

    missing = []
    if not (semantic.get("energyCode") or best(en, "project", "energyCode")):
        missing.append("energyCode")
    if not best(tz or pages, "bulk", "stories"):
        missing.append("stories")
    if not best(tz or pages, "bulk", "buildingHeightFt"):
        missing.append("buildingHeightFt")
    if not (semantic.get("floorAreaFt2") or best(en or pages, "lighting", "floorAreaFt2") or best(tz or pages, "bulk", "conditionedFloorAreaFt2") or best(tz or pages, "bulk", "grossFloorAreaFt2")):
        missing.append("floorAreaFt2")
    envelope = [row for page in en for row in list(page.get("envelope") or []) if float(row.get("confidence") or 0) >= MIN_CONFIDENCE]
    if not envelope:
        missing.append("envelope")
    return missing


def _schedule_artifact(artifacts: dict[str, Path]) -> Path | None:
    for name, path in artifacts.items():
        if name.endswith("revit-schedule-evidence.json"):
            return path
    return None


def _load_schedule_evidence(path: Path | None) -> dict:
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    if _text(data.get("schema")) != SCHEDULE_SCHEMA or _text(data.get("authority")) != SCHEDULE_AUTHORITY:
        return {}
    return data


def _schedule_headings(schedule: dict) -> list[str]:
    fields = [field for field in list(schedule.get("fields") or []) if not bool(field.get("hidden"))]
    headings = [_text(field.get("columnHeading") or field.get("name")) for field in fields]
    if any(headings):
        return headings
    header_rows = list(schedule.get("headerRows") or [])
    if header_rows:
        return [_text(value) for value in list(header_rows[-1] or [])]
    return []


def _schedule_text(evidence: dict) -> str:
    parts: list[str] = []
    for schedule in list(evidence.get("schedules") or []):
        parts.append(_text(schedule.get("name")))
        parts.extend(_schedule_headings(schedule))
        for row in list(schedule.get("headerRows") or []):
            parts.extend(_text(value) for value in list(row or []))
        for row in list(schedule.get("bodyRows") or []):
            parts.extend(_text(value) for value in list(row or []))
    return "\n".join(part for part in parts if part)


def _norm_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _schedule_gross_area(evidence: dict) -> dict | None:
    candidates: list[dict] = []
    for schedule in list(evidence.get("schedules") or []):
        name = _text(schedule.get("name"))
        headings = _schedule_headings(schedule)
        if not headings:
            continue
        gross_indices = []
        for index, heading in enumerate(headings):
            norm = _norm_header(heading)
            if "gross area" not in norm:
                continue
            if any(token in norm for token in ("bc gross area", "deduction", "zoning floor area")):
                continue
            gross_indices.append(index)
        if not gross_indices:
            continue
        for row in list(schedule.get("bodyRows") or []):
            values = [_text(value) for value in list(row or [])]
            row_text = " ".join(values)
            if not re.search(r"\btotal(?:s)?\b", row_text, re.I):
                continue
            for index in gross_indices:
                if index >= len(values):
                    continue
                area = _first_number(values[index])
                if area is None:
                    continue
                score = 0
                name_lower = name.lower()
                if "zoning" in name_lower: score += 3
                if "area" in name_lower: score += 2
                if "calculation" in name_lower: score += 1
                candidates.append({"value": area, "schedule": name, "column": headings[index], "score": score})
    if not candidates:
        return None
    best_score = max(row["score"] for row in candidates)
    best = [row for row in candidates if row["score"] == best_score]
    distinct = {round(float(row["value"]), 3) for row in best}
    if len(distinct) != 1:
        return None
    return best[0]


def _schedule_kind(schedule_name: str, row_text: str) -> str:
    source = f"{schedule_name} {row_text}".lower()
    if re.search(r"\b(fenestration|window|glazing)\b", source): return "window"
    if re.search(r"\bdoor\b", source): return "door"
    if re.search(r"\broof\b", source): return "roof"
    if re.search(r"\b(floor|slab)\b", source): return "floor"
    if re.search(r"\bwall\b", source): return "wall"
    return ""


def _orientation_text(value: Any) -> str:
    source = _text(value).upper()
    for word in ("NORTH", "SOUTH", "EAST", "WEST"):
        if re.search(rf"\b{word}\b", source):
            return word
    for short, word in (("N", "NORTH"), ("S", "SOUTH"), ("E", "EAST"), ("W", "WEST")):
        if re.fullmatch(rf"\s*{short}\s*", source):
            return word
    return ""


def _first_index(headings: list[str], predicate: Callable[[str], bool]) -> int | None:
    for index, heading in enumerate(headings):
        if predicate(_norm_header(heading)):
            return index
    return None


def _schedule_envelope_rows(evidence: dict, source_name: str) -> list[dict]:
    output: list[dict] = []
    for schedule in list(evidence.get("schedules") or []):
        name = _text(schedule.get("name"))
        headings = _schedule_headings(schedule)
        if not headings:
            continue
        contextual = _norm_header(name + " " + " ".join(headings))
        if not re.search(r"\b(envelope|thermal|fenestration|window|glazing|door|roof|floor|slab|wall)\b", contextual):
            continue

        area_i = _first_index(headings, lambda h: h == "area" or "gross area" in h or h.startswith("area "))
        orientation_i = _first_index(headings, lambda h: "orientation" in h or h in {"facing", "exposure", "facade"})
        u_i = _first_index(headings, lambda h: h in {"u", "u value", "u factor", "ufactor"} or "u factor" in h)
        shgc_i = _first_index(headings, lambda h: "shgc" in h or "solar heat gain coefficient" in h)
        cavity_i = _first_index(headings, lambda h: "cavity" in h and ("r" in h or "resistance" in h))
        continuous_i = _first_index(headings, lambda h: ("continuous" in h or h in {"ci", "ci r"}) and ("r" in h or "insulation" in h or "resistance" in h))
        assembly_i = _first_index(headings, lambda h: h in {"assembly", "assembly type", "type", "type mark", "mark"} or "assembly type" in h)
        description_i = _first_index(headings, lambda h: h in {"description", "construction", "material", "assembly description"})
        kind_i = _first_index(headings, lambda h: h in {"kind", "category", "element type", "envelope type"})
        if area_i is None:
            continue

        for raw_row in list(schedule.get("bodyRows") or []):
            values = [_text(value) for value in list(raw_row or [])]
            if area_i >= len(values):
                continue
            row_text = " ".join(values)
            kind_source = values[kind_i] if kind_i is not None and kind_i < len(values) else row_text
            kind = _schedule_kind(name, kind_source)
            if not kind:
                continue
            area = _first_number(values[area_i])
            if area is None:
                continue
            orientation_source = values[orientation_i] if orientation_i is not None and orientation_i < len(values) else row_text
            orientation = _orientation_text(orientation_source) or None
            if kind in {"wall", "window", "door"} and not orientation:
                continue

            assembly = values[assembly_i] if assembly_i is not None and assembly_i < len(values) else ""
            description = values[description_i] if description_i is not None and description_i < len(values) else ""
            if not assembly and not description:
                code = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", row_text.upper())
                assembly = code.group(1) if code else ""
            if not assembly and not description:
                continue

            def numeric(index: int | None) -> float | None:
                return _first_number(values[index]) if index is not None and index < len(values) else None

            u_factor = numeric(u_i)
            shgc = numeric(shgc_i)
            cavity_r = numeric(cavity_i)
            continuous_r = numeric(continuous_i)
            if kind in {"window", "door"} and u_factor is None:
                continue
            if kind == "window" and shgc is None:
                continue
            if kind in {"wall", "roof", "floor"} and cavity_r is None and continuous_r is None:
                continue

            evidence_text = "; ".join(
                f"{headings[index]}={value}" for index, value in enumerate(values[:len(headings)]) if value
            )
            output.append({
                "sourceFile": source_name,
                "sourceScheduleId": _text(schedule.get("uniqueId")),
                "sourceScheduleName": name,
                "kind": kind,
                "assemblyType": assembly or None,
                "description": description or None,
                "orientation": orientation,
                "grossAreaFt2": area,
                "uFactor": u_factor,
                "shgc": shgc,
                "cavityR": cavity_r,
                "continuousR": continuous_r,
                "confidence": 1.0,
                "evidence": f"Native Revit schedule {name}: {evidence_text}",
                "structuredRevitSchedule": True,
            })
    return output


def _ensure_structured_page(facts: dict, page_type: str, source_name: str, sheet_name: str) -> dict:
    pages = facts.setdefault("pages", [])
    for page in pages:
        if _text(page.get("pageType")).upper() == page_type and _safe_name(page.get("sourceFile")).lower() == _safe_name(source_name).lower():
            return page
    page = {
        "pageType": page_type,
        "sheetNumber": "REVIT-SCHEDULES",
        "sheetName": sheet_name,
        "sourceFile": source_name,
        "confidence": 1.0,
        "project": {},
        "bulk": {},
        "envelope": [],
        "sourceAuthority": SCHEDULE_AUTHORITY,
    }
    pages.append(page)
    return page


def _apply_schedule_evidence(derived: dict, evidence: dict, source_name: str, audit: dict) -> None:
    if not evidence:
        audit.update(status="UNAVAILABLE", sourceFile=source_name or None)
        return
    text = _schedule_text(evidence)
    semantic = dict(derived.get("comcheckSemantic") or {})
    resolved: dict[str, Any] = {}
    before = set(_missing_core(derived))
    bulk_page = _ensure_structured_page(derived, "Z", source_name, "STRUCTURED NATIVE REVIT SCHEDULE FACTS")

    if "energyCode" in before:
        code = _extract_energy_code(text)
        if code:
            semantic["energyCode"] = code
            resolved["energyCode"] = code
    if "stories" in before:
        stories = _extract_stories(text)
        if stories is not None:
            _set_page_value(bulk_page, "bulk", "stories", stories)
            resolved["stories"] = stories
    if "buildingHeightFt" in before:
        height = _extract_height(text)
        if height is not None:
            _set_page_value(bulk_page, "bulk", "buildingHeightFt", round(height, 3))
            resolved["buildingHeightFt"] = round(height, 3)
    if "floorAreaFt2" in before:
        area = _schedule_gross_area(evidence)
        if area is not None:
            semantic["floorAreaFt2"] = round(float(area["value"]), 3)
            resolved["floorAreaFt2"] = area
    if not semantic.get("wholeBuildingType") and _extract_multifamily(text):
        semantic["wholeBuildingType"] = "MULTIFAMILY"
        resolved["wholeBuildingType"] = "MULTIFAMILY"

    if "envelope" in before:
        envelope = _schedule_envelope_rows(evidence, source_name)
        if envelope:
            page = _ensure_structured_page(derived, "EN", source_name, "STRUCTURED NATIVE REVIT ENVELOPE SCHEDULES")
            page["envelope"] = envelope
            resolved["envelopeRows"] = len(envelope)

    sources = list(semantic.get("sources") or [])
    if source_name and source_name not in sources:
        sources.append(source_name)
    if sources:
        semantic["sources"] = sources
    semantic["scheduleNamesAuthoritative"] = True
    derived["comcheckSemantic"] = semantic
    derived["comcheckSemanticVersion"] = VERSION
    after = _missing_core(derived)
    audit.update(
        status="APPLIED",
        sourceFile=source_name,
        scheduleCount=int(evidence.get("scheduleCount") or len(list(evidence.get("schedules") or []))),
        capturedScheduleCount=int(evidence.get("capturedScheduleCount") or len(list(evidence.get("schedules") or []))),
        resolved=resolved,
        afterMissing=after,
    )


ENVELOPE_SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sourceFile": {"type": "string"},
                    "kind": {"type": "string", "enum": ["wall", "window", "door", "roof", "floor"]},
                    "assemblyType": {"type": ["string", "null"]},
                    "description": {"type": ["string", "null"]},
                    "orientation": {"type": ["string", "null"]},
                    "grossAreaFt2": {"type": ["number", "null"]},
                    "uFactor": {"type": ["number", "null"]},
                    "shgc": {"type": ["number", "null"]},
                    "cavityR": {"type": ["number", "null"]},
                    "continuousR": {"type": ["number", "null"]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence": {"type": "string"},
                },
                "required": ["sourceFile", "kind", "assemblyType", "description", "orientation", "grossAreaFt2", "uFactor", "shgc", "cavityR", "continuousR", "confidence", "evidence"],
            },
        }
    },
    "required": ["rows"],
}


def _run_envelope_agent(selected: list[dict]) -> dict:
    from google import genai
    from google.genai import types

    project = resolve_vertex_project()
    location = os.environ.get("REVEX_VERTEX_LOCATION", "global")
    model = os.environ.get("REVEX_PAGE_SCAN_MODEL", "gemini-2.5-flash")
    prompt = (
        "Read ONLY current-project envelope facts visible in these immutable Revit EN sheets. "
        "Recover the envelope rows needed to rebuild the current COMcheck input. Prefer EN thermal-boundary diagrams for geometry/orientation/area and EN envelope/COMcheck schedules for thermal properties. "
        "Do not import any prior-project/template values and do not invent missing values. "
        "Kinds are wall/window/door/roof/floor. For wall/window/door rows include orientation when visible. "
        "For windows/doors return U-factor; windows also SHGC. For wall/roof/floor return cavityR and/or continuousR exactly as shown. "
        "Merge matching geometry and thermal schedule evidence into complete rows when the same current assembly can be proven across the supplied EN sheets. "
        "Keep distinct geometry regions distinct; do not silently total different orientations. "
        "Every row must name the exact source PDF and include a short visible evidence string containing the row label and the relevant numeric facts. "
        "If a value is not visible set it null. Confidence must reflect the visible row, not general inference."
    )
    contents = [types.Part.from_bytes(data=row["path"].read_bytes(), mime_type="application/pdf") for row in selected]
    contents.append(prompt)
    client = genai.Client(vertexai=True, project=project, location=location, http_options=types.HttpOptions(api_version="v1", timeout=120000))
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config={"temperature": 0, "response_mime_type": "application/json", "response_json_schema": ENVELOPE_SCHEMA},
    )
    return json.loads(_text(response.text) or "{}")


def _visible_number(text: str, value: float) -> bool:
    normalized = str(text or "").replace(",", "")
    candidates = {f"{value:g}", f"{value:.1f}", f"{value:.2f}", f"{value:.3f}"}
    return any(token in normalized for token in candidates)


def _validate_envelope_rows(candidate: dict, selected: list[dict], pdf_text_by_source: dict[str, str]) -> tuple[list[dict], list[str]]:
    allowed = {row["source"]: row for row in selected}
    accepted: list[dict] = []
    rejected: list[str] = []
    for index, raw in enumerate(list(candidate.get("rows") or []), start=1):
        row = dict(raw)
        source = _safe_name(row.get("sourceFile") or "").lower()
        kind = _text(row.get("kind")).lower()
        confidence = float(row.get("confidence") or 0)
        evidence = _flat(row.get("evidence"))
        if source not in allowed:
            rejected.append(f"row {index}: source is not an immutable selected EN PDF")
            continue
        if kind not in {"wall", "window", "door", "roof", "floor"}:
            rejected.append(f"row {index}: unsupported kind")
            continue
        if confidence < MIN_CONFIDENCE:
            rejected.append(f"row {index}: confidence {confidence:.3f} below {MIN_CONFIDENCE:.2f}")
            continue
        if not evidence:
            rejected.append(f"row {index}: no visible evidence")
            continue
        numeric_keys = ("grossAreaFt2", "uFactor", "shgc", "cavityR", "continuousR")
        values = [(_number(row.get(key)) if key == "grossAreaFt2" else (float(row[key]) if row.get(key) not in (None, "") else None)) for key in numeric_keys]
        if kind in {"wall", "window", "door"} and not _text(row.get("orientation")):
            rejected.append(f"row {index}: oriented envelope row has no orientation")
            continue
        if _number(row.get("grossAreaFt2")) is None:
            rejected.append(f"row {index}: no positive gross area")
            continue
        if kind in {"window", "door"} and row.get("uFactor") in (None, ""):
            rejected.append(f"row {index}: fenestration/door has no U-factor")
            continue
        if kind == "window" and row.get("shgc") in (None, ""):
            rejected.append(f"row {index}: window has no SHGC")
            continue
        if kind in {"wall", "roof", "floor"} and row.get("cavityR") in (None, "") and row.get("continuousR") in (None, ""):
            rejected.append(f"row {index}: opaque assembly has no R-value")
            continue
        if not _text(row.get("assemblyType")) and not _text(row.get("description")):
            rejected.append(f"row {index}: no assembly label")
            continue
        visible = _flat(pdf_text_by_source.get(source, ""))
        proof = visible if len(visible) >= 20 else evidence
        requested_numbers = [value for value in values if value is not None]
        if any(not _visible_number(proof, float(value)) for value in requested_numbers):
            rejected.append(f"row {index}: one or more numeric facts are absent from its source-visible evidence")
            continue
        row["sourceFile"] = allowed[source]["path"].name
        row["kind"] = kind
        row["confidence"] = confidence
        accepted.append(row)
    return accepted, rejected


def resolve_request(
    request_path: Path,
    output_root: Path,
    *,
    envelope_agent: Callable[[list[dict]], dict] | None = None,
    pdf_text_loader: Callable[[Path], str] | None = None,
) -> Path:
    request_path = Path(request_path).resolve()
    output_root = Path(output_root).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(_text(request.get("pageFactsPath")))
    if not page_path.is_file():
        return request_path
    facts = json.loads(page_path.read_text(encoding="utf-8"))
    before_missing = _missing_core(facts)
    audit: dict[str, Any] = {
        "schema": SCHEMA,
        "version": VERSION,
        "sourceEngineeringRevision": _text(request.get("revision")),
        "beforeMissing": before_missing,
        "sourceEvidenceMutated": False,
        "structuredSchedules": {},
        "deterministicPdf": {},
        "envelopePdfFallback": {},
    }
    if not before_missing:
        audit["status"] = "ALREADY_COMPLETE"
        (output_root / "COMCHECK_EVIDENCE_RESOLUTION_R100.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
        return request_path

    artifacts = _artifact_paths(request)
    derived = copy.deepcopy(facts)

    schedule_path = _schedule_artifact(artifacts)
    schedule_evidence = _load_schedule_evidence(schedule_path)
    _apply_schedule_evidence(derived, schedule_evidence, schedule_path.name if schedule_path else "", audit["structuredSchedules"])
    remaining = _missing_core(derived)

    rows = _source_pages(derived, artifacts)
    loader = pdf_text_loader or _pdf_text
    text_by_source = {row["source"]: loader(row["path"]) for row in rows}
    tz_rows = [row for row in rows if row["pageType"] in {"T", "Z"}]
    en_rows = [row for row in rows if row["pageType"] == "EN"]
    all_text = "\n".join(text_by_source[row["source"]] for row in rows)
    tz_text = "\n".join(text_by_source[row["source"]] for row in tz_rows)
    semantic = dict(derived.get("comcheckSemantic") or {})

    if "energyCode" in remaining:
        code = _extract_energy_code(all_text)
        if code:
            semantic["energyCode"] = code
            audit["deterministicPdf"]["energyCode"] = code
    if "stories" in remaining:
        stories = _extract_stories(tz_text)
        if stories is not None and tz_rows:
            target = _find_page_row(derived, tz_rows[0]["source"])
            if target is not None:
                _set_page_value(target, "bulk", "stories", stories)
                audit["deterministicPdf"]["stories"] = stories
    if "buildingHeightFt" in remaining:
        height = _extract_height(tz_text)
        if height is not None and tz_rows:
            target = _find_page_row(derived, tz_rows[0]["source"])
            if target is not None:
                _set_page_value(target, "bulk", "buildingHeightFt", round(height, 3))
                audit["deterministicPdf"]["buildingHeightFt"] = round(height, 3)
    if "floorAreaFt2" in remaining:
        floor_area = None
        floor_source = ""
        ranked = sorted(tz_rows, key=lambda row: (0 if ("z-001" in _flat(row["page"].get("sheetNumber")).lower() or "zoning analysis" in _flat(row["page"].get("sheetName")).lower()) else 1, row["source"]))
        for row in ranked:
            candidate = _extract_zoning_gross_area(text_by_source[row["source"]])
            if candidate is not None:
                floor_area, floor_source = candidate, row["path"].name
                break
        if floor_area is not None:
            semantic["floorAreaFt2"] = round(floor_area, 3)
            audit["deterministicPdf"]["floorAreaFt2"] = {"value": round(floor_area, 3), "sourceFile": floor_source, "column": "Gross Area", "scope": "Zoning analysis Area Calculation / Totals"}
    if not semantic.get("wholeBuildingType") and _extract_multifamily(tz_text):
        semantic["wholeBuildingType"] = "MULTIFAMILY"
        audit["deterministicPdf"]["wholeBuildingType"] = "MULTIFAMILY"
    if semantic:
        derived["comcheckSemantic"] = semantic
        derived["comcheckSemanticVersion"] = VERSION

    remaining = _missing_core(derived)
    if "envelope" in remaining and en_rows:
        ranked_en = sorted(en_rows, key=lambda row: (0 if re.search(r"thermal|fenestr|comcheck|envelope", _flat(row["page"].get("sheetName")), re.I) else 1, row["source"]))[:MAX_AGENT_PDFS]
        agent = envelope_agent or _run_envelope_agent
        try:
            candidate = agent(ranked_en)
            accepted, rejected = _validate_envelope_rows(candidate, ranked_en, text_by_source)
        except Exception as exc:
            accepted, rejected = [], [f"{type(exc).__name__}: {exc}"]
        audit["envelopePdfFallback"] = {"selectedSources": [row["path"].name for row in ranked_en], "acceptedRows": len(accepted), "rejected": rejected}
        if accepted:
            by_source: dict[str, list[dict]] = {}
            for row in accepted:
                by_source.setdefault(_safe_name(row["sourceFile"]).lower(), []).append(row)
            for source, envelope_rows in by_source.items():
                page = _find_page_row(derived, source)
                if page is not None:
                    existing = [dict(item) for item in list(page.get("envelope") or []) if float(item.get("confidence") or 0) >= MIN_CONFIDENCE]
                    if not existing:
                        page["envelope"] = envelope_rows

    after_missing = _missing_core(derived)
    audit["afterMissing"] = after_missing
    if not rows and not schedule_evidence:
        audit["status"] = "NO_BOUND_CURRENT_PROJECT_EVIDENCE"
    else:
        audit["status"] = "RESOLVED" if not after_missing else "PARTIAL"
    audit_path = output_root / "COMCHECK_EVIDENCE_RESOLUTION_R100.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")

    if derived == facts:
        return request_path
    facts_path = output_root / "00_PAGE_FACTS_COMCHECK_EVIDENCE_R100.json"
    facts_path.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_path)
    derived_request["comcheckEvidenceResolution"] = {"schema": SCHEMA, "version": VERSION, "auditFile": audit_path.name, "afterMissing": after_missing}
    request_copy = output_root / "00_PIPELINE_REQUEST_COMCHECK_EVIDENCE_R100.json"
    request_copy.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "COMCHECK_EVIDENCE_R101",
        "status": audit["status"],
        "beforeMissing": before_missing,
        "afterStructuredSchedules": audit["structuredSchedules"].get("afterMissing", before_missing),
        "afterMissing": after_missing,
    }, ensure_ascii=True), flush=True)
    return request_copy
