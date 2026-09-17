#!/usr/bin/env python3
"""REVEX current-project COMcheck evidence recovery.

Repairs only missing COMcheck inputs in a derived page-facts copy using immutable
active-Revit T/Z/EN evidence from the same Engineering Sync revision.

Authority rules:
- native structured Revit schedules run before this fallback and remain higher authority;
- PDF text may fill only still-missing deterministic T/Z facts;
- building height means the PROVIDED/PROPOSED value in the visible
  "Building Height/Hight above grade plane" code-analysis row, never a value inferred
  from a made-up "MAX BUILDING HEIGHT" label;
- EN envelope rows may be recovered by bounded multimodal reading, with visible numeric
  evidence and the existing 0.90 filing-confidence floor;
- source Engineering evidence is never mutated and reference-project quantities are never used.
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
VERSION = "20260817r116-comcheck-evidence2"
MIN_CONFIDENCE = 0.90
MAX_AGENT_PDFS = 8


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
    """Return the PROVIDED/PROPOSED building height above grade plane.

    NYC code-analysis schedules commonly present the row as:
      Building Hight above grade plane | 85' | 65'
    where the first value is the code/allowable value and the last value is the
    provided/proposed project value. The visible row semantics own the fact; no
    fabricated MAX BUILDING HEIGHT row is required.
    """
    row_pattern = re.compile(r"\bBUILDING\s+(?:HEIGHT|HIGHT)\s+ABOVE\s+GRADE\s+PLANE\b", re.I)

    # Prefer an intact extracted row. The last feet value in that row is the
    # provided/proposed column, matching the native structured-schedule rule.
    for raw in str(text or "").splitlines():
        row = _flat(raw)
        if not row_pattern.search(row):
            continue
        values = _feet_tokens(row)
        if values:
            return values[-1]

    # PDF extraction may collapse table cells into one flat stream. Read only a
    # short window after the exact row label and again take the final visible feet value.
    source = _flat(text)
    for match in row_pattern.finditer(source):
        values = _feet_tokens(source[match.start():match.start() + 180])
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
    return _number(match.group(2)) if match else None


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

    missing: list[str] = []
    if not (semantic.get("energyCode") or best(en, "project", "energyCode")):
        missing.append("energyCode")
    if not best(tz or pages, "bulk", "stories"):
        missing.append("stories")
    if not best(tz or pages, "bulk", "buildingHeightFt"):
        missing.append("buildingHeightFt")
    if not (semantic.get("floorAreaFt2") or best(en or pages, "lighting", "floorAreaFt2") or best(tz or pages, "bulk", "conditionedFloorAreaFt2") or best(tz or pages, "bulk", "grossFloorAreaFt2")):
        missing.append("floorAreaFt2")
    envelope = [row for page in en for row in list(page.get("envelope") or []) if float(row.get("confidence") or 0) >= MIN_CONFIDENCE]
    joinable, _ = _retain_joinable_envelope_evidence(envelope)
    if not any(_row_has_geometry(row) for row in joinable):
        missing.append("envelope")
    return missing


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
        "Every row must name the exact source PDF and include a short visible evidence string containing the row label and relevant numeric facts. "
        "If a value is not visible set it null. Confidence must reflect visible evidence, not general inference."
    )
    contents = [types.Part.from_bytes(data=row["path"].read_bytes(), mime_type="application/pdf") for row in selected]
    contents.append(prompt)
    client = genai.Client(vertexai=True, project=project, location=location,
                          http_options=types.HttpOptions(api_version="v1", timeout=120000))
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


def _row_code(row: dict) -> tuple[str, str]:
    """Return an exact EN assembly tag and its base tag without fuzzy matching."""
    source = " ".join(_text(row.get(key)) for key in ("assemblyType", "description", "evidence"))
    match = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", source.upper())
    if not match:
        return "", ""
    code = match.group(1)
    return code, code.split(".", 1)[0]


def _row_has_geometry(row: dict) -> bool:
    kind = _text(row.get("kind")).lower()
    if _number(row.get("grossAreaFt2")) is None:
        return False
    return kind not in {"wall", "window", "door"} or bool(_text(row.get("orientation")))


def _row_has_thermal(row: dict) -> bool:
    kind = _text(row.get("kind")).lower()
    if kind == "window":
        return row.get("uFactor") not in (None, "") and row.get("shgc") not in (None, "")
    if kind == "door":
        return row.get("uFactor") not in (None, "")
    if kind in {"wall", "roof", "floor"}:
        return row.get("cavityR") not in (None, "") or row.get("continuousR") not in (None, "")
    return False


def _row_thermal_signature(row: dict) -> tuple:
    kind = _text(row.get("kind")).lower()
    if kind in {"window", "door"}:
        return (row.get("uFactor"), row.get("shgc"))
    return (row.get("cavityR"), row.get("continuousR"))


def _retain_joinable_envelope_evidence(rows: list[dict]) -> tuple[list[dict], list[str]]:
    """Keep only current EN row halves that can form an unambiguous filing row.

    Diagram rows own area/orientation and schedule rows own thermal properties. They
    may be separate records and separate sheets, but must join by exact/base assembly
    tag. Roof/floor use the existing bounded exception: one unique same-kind thermal
    signature may serve tagged regions. Conflicting signatures fail closed.
    """
    geometry = [row for row in rows if _row_has_geometry(row)]
    thermal = [row for row in rows if _row_has_thermal(row)]
    kept_ids: set[int] = set()
    rejected: list[str] = []

    for diagram in geometry:
        kind = _text(diagram.get("kind")).lower()
        code, base = _row_code(diagram)
        same_kind = [row for row in thermal if _text(row.get("kind")).lower() == kind]
        exact = [row for row in same_kind if code and _row_code(row)[0] == code]
        base_matches = [row for row in same_kind if base and _row_code(row)[1] == base]
        candidates = exact or base_matches
        if not candidates and kind in {"roof", "floor"}:
            signatures = {_row_thermal_signature(row) for row in same_kind}
            if len(signatures) == 1:
                candidates = same_kind
        if not code and kind in {"wall", "window", "door"}:
            rejected.append(f"EN {kind} geometry row has no exact assembly tag")
            continue
        if not candidates:
            rejected.append(f"EN {kind or 'envelope'} geometry row {code or '<unlabeled>'} has no thermal-property match")
            continue
        signatures = {_row_thermal_signature(row) for row in candidates}
        if len(signatures) != 1:
            rejected.append(f"EN {kind or 'envelope'} geometry row {code or '<unlabeled>'} has conflicting thermal-property matches")
            continue
        kept_ids.add(id(diagram))
        kept_ids.update(id(row) for row in candidates)

    return [row for row in rows if id(row) in kept_ids], rejected


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
        if not _text(row.get("assemblyType")) and not _text(row.get("description")):
            rejected.append(f"row {index}: no assembly label")
            continue
        has_geometry = _row_has_geometry(row)
        has_thermal = _row_has_thermal(row)
        if not has_geometry and not has_thermal:
            rejected.append(f"row {index}: neither complete geometry nor required thermal evidence")
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
    joinable, join_rejected = _retain_joinable_envelope_evidence(accepted)
    rejected.extend(join_rejected)
    return joinable, rejected


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
        "deterministic": {},
        "envelope": {},
    }
    if not before_missing:
        audit["status"] = "ALREADY_COMPLETE"
        (output_root / "COMCHECK_EVIDENCE_RESOLUTION_R100.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
        return request_path

    artifacts = _artifact_paths(request)
    rows = _source_pages(facts, artifacts)
    if not rows:
        audit.update(status="NO_BOUND_T_Z_EN_PDFS", afterMissing=before_missing)
        (output_root / "COMCHECK_EVIDENCE_RESOLUTION_R100.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
        return request_path

    loader = pdf_text_loader or _pdf_text
    text_by_source = {row["source"]: loader(row["path"]) for row in rows}
    derived = copy.deepcopy(facts)
    semantic = dict(derived.get("comcheckSemantic") or {})

    tz_rows = [row for row in rows if row["pageType"] in {"T", "Z"}]
    en_rows = [row for row in rows if row["pageType"] == "EN"]
    all_text = "\n".join(text_by_source[row["source"]] for row in rows)
    tz_text = "\n".join(text_by_source[row["source"]] for row in tz_rows)

    if "energyCode" in before_missing:
        code = _extract_energy_code(all_text)
        if code:
            semantic["energyCode"] = code
            audit["deterministic"]["energyCode"] = code
    if "stories" in before_missing:
        stories = _extract_stories(tz_text)
        if stories is not None and tz_rows:
            target = _find_page_row(derived, tz_rows[0]["source"])
            if target is not None:
                _set_page_value(target, "bulk", "stories", stories)
                audit["deterministic"]["stories"] = stories
    if "buildingHeightFt" in before_missing:
        height = _extract_height(tz_text)
        if height is not None and tz_rows:
            target = _find_page_row(derived, tz_rows[0]["source"])
            if target is not None:
                _set_page_value(target, "bulk", "buildingHeightFt", round(height, 3))
                audit["deterministic"]["buildingHeightFt"] = round(height, 3)
    if "floorAreaFt2" in before_missing:
        floor_area = None
        floor_source = ""
        ranked = sorted(
            tz_rows,
            key=lambda row: (
                0 if ("z-001" in _flat(row["page"].get("sheetNumber")).lower()
                      or "zoning analysis" in _flat(row["page"].get("sheetName")).lower()) else 1,
                row["source"],
            ),
        )
        for row in ranked:
            candidate = _extract_zoning_gross_area(text_by_source[row["source"]])
            if candidate is not None:
                floor_area, floor_source = candidate, row["path"].name
                break
        if floor_area is not None:
            semantic["floorAreaFt2"] = round(floor_area, 3)
            audit["deterministic"]["floorAreaFt2"] = {
                "value": round(floor_area, 3),
                "sourceFile": floor_source,
                "column": "Gross Area",
                "scope": "Zoning analysis Area Calculation / Totals",
            }
    if not semantic.get("wholeBuildingType") and _extract_multifamily(tz_text):
        semantic["wholeBuildingType"] = "MULTIFAMILY"
        audit["deterministic"]["wholeBuildingType"] = "MULTIFAMILY"
    if semantic:
        derived["comcheckSemantic"] = semantic
        derived["comcheckSemanticVersion"] = VERSION

    if "envelope" in before_missing and en_rows:
        ranked_en = sorted(
            en_rows,
            key=lambda row: (
                0 if re.search(r"thermal|fenestr|comcheck|envelope", _flat(row["page"].get("sheetName")), re.I) else 1,
                row["source"],
            ),
        )[:MAX_AGENT_PDFS]
        agent = envelope_agent or _run_envelope_agent
        try:
            candidate = agent(ranked_en)
            accepted, rejected = _validate_envelope_rows(candidate, ranked_en, text_by_source)
        except Exception as exc:
            accepted, rejected = [], [f"{type(exc).__name__}: {exc}"]
        audit["envelope"] = {
            "selectedSources": [row["path"].name for row in ranked_en],
            "acceptedRows": len(accepted),
            "rejected": rejected,
        }
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
    audit["status"] = "RESOLVED" if not after_missing else "PARTIAL"
    audit_path = output_root / "COMCHECK_EVIDENCE_RESOLUTION_R100.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")

    if after_missing == before_missing:
        return request_path
    facts_path = output_root / "00_PAGE_FACTS_COMCHECK_EVIDENCE_R100.json"
    facts_path.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_path)
    derived_request["comcheckEvidenceResolution"] = {
        "schema": SCHEMA,
        "version": VERSION,
        "auditFile": audit_path.name,
        "afterMissing": after_missing,
    }
    request_copy = output_root / "00_PIPELINE_REQUEST_COMCHECK_EVIDENCE_R100.json"
    request_copy.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "COMCHECK_EVIDENCE_R100",
        "status": audit["status"],
        "beforeMissing": before_missing,
        "afterMissing": after_missing,
    }, ensure_ascii=True), flush=True)
    return request_copy
