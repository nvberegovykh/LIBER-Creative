#!/usr/bin/env python3
"""REVEX r118 approved-envelope thermal projection.

The immutable current project remains the authority for identity, tag, geometry,
area and orientation. When a current EN thermal-boundary geometry row has no
matching thermal-property row, REVEX may inherit only thermal performance from
the approved 79 Winthrop proposed envelope reference after the current EN facts
corroborate that same envelope signature.

No current Engineering evidence is mutated. No prior-project identity, quantity,
area, orientation or CXL is copied into the current project.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any

SCHEMA = "liber.revex.reference-envelope-projection.v1"
VERSION = "20260817r118-reference-envelope1"
REFERENCE_NAME = "79_WINTHROP_APPROVED_PROPOSED.osm"
MIN_CONFIDENCE = 0.90
U_TOLERANCE = 0.015
SHGC_TOLERANCE = 0.03
W_M2K_TO_BTU_H_FT2_F = 0.1761101838


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _reference_path() -> Path:
    configured = _text(os.environ.get("REVEX_APPROVED_ENVELOPE_REFERENCE"))
    if configured:
        return Path(configured).resolve()
    impl = _text(os.environ.get("REVEX_PIPELINE_IMPL"))
    if impl:
        candidate = Path(impl).resolve().parent / "References" / REFERENCE_NAME
        if candidate.is_file():
            return candidate
    return (
        Path(__file__).resolve().parents[2]
        / "src/Liber.Revex.Revit/Engineering/Energy/References"
        / REFERENCE_NAME
    ).resolve()


def _osm_fields(block: str) -> list[str]:
    return [line.strip().rstrip(",;").strip() for line in block.splitlines() if line.strip()]


def _approved_profiles(path: Path) -> dict[str, dict]:
    if not path.is_file():
        raise RuntimeError(f"Approved envelope reference is unavailable: {path}")
    source = path.read_text(encoding="utf-8", errors="replace")
    glazing: dict[str, dict] = {}
    for match in re.finditer(r"OS:WindowMaterial:SimpleGlazingSystem,\s*(.*?);", source, re.S):
        fields = _osm_fields(match.group(1))
        if len(fields) < 5:
            continue
        handle = fields[0].strip("{}")
        u_si = _number(fields[2])
        shgc = _number(fields[3])
        vt = _number(fields[4])
        if u_si is None or shgc is None:
            continue
        glazing[handle] = {
            "material": fields[1],
            # Exact approved OSM value 1.7 W/m2-K converts to the 0.30 IP filing value.
            "uFactor": round(u_si * W_M2K_TO_BTU_H_FT2_F, 2),
            "uFactorSI": u_si,
            "shgc": shgc,
            "vt": vt,
            "handle": handle,
        }

    constructions: list[dict] = []
    for match in re.finditer(r"OS:Construction,\s*(.*?);", source, re.S):
        fields = _osm_fields(match.group(1))
        if len(fields) < 3:
            continue
        constructions.append({
            "handle": fields[0].strip("{}"),
            "name": fields[1],
            "layers": [field.strip("{}") for field in fields[2:]],
        })

    def profile_for(pattern: str) -> dict:
        candidates = [row for row in constructions if re.search(pattern, row["name"], re.I)]
        for construction in candidates:
            for layer in construction["layers"]:
                if layer in glazing:
                    return {**glazing[layer], "construction": construction["name"]}
        raise RuntimeError(f"Approved proposed reference has no glazing profile for construction /{pattern}/")

    window = profile_for(r"\bWIN_EXT(?:_|\b)")
    door = profile_for(r"\bDOOR_EXT(?:_|\b)")
    return {
        "window": window,
        "door": door,
        "reference": str(path),
        "referenceSha256": _sha256(path),
    }


def _row_code(row: dict) -> tuple[str, str]:
    source = " ".join(_text(row.get(key)) for key in ("evidence", "assemblyType", "description"))
    match = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", source.upper())
    if not match:
        return "", ""
    code = match.group(1)
    return code, code.split(".", 1)[0]


def _thermal_signature(row: dict) -> tuple[float | None, float | None]:
    return _number(row.get("uFactor")), _number(row.get("shgc"))


def _profile_matches_row(profile: dict, row: dict, *, require_shgc: bool) -> bool:
    u, shgc = _thermal_signature(row)
    if u is None or abs(u - float(profile["uFactor"])) > U_TOLERANCE:
        return False
    if require_shgc:
        return shgc is not None and abs(shgc - float(profile["shgc"])) <= SHGC_TOLERANCE
    if shgc is not None and abs(shgc - float(profile["shgc"])) > SHGC_TOLERANCE:
        return False
    return True


def _is_glazed_door(row: dict) -> bool:
    source = " ".join(_text(row.get(key)) for key in ("evidence", "assemblyType", "description")).lower()
    return "glass" in source or "glaz" in source


def _has_existing_match(geometry: dict, thermal_rows: list[dict]) -> bool:
    kind = _text(geometry.get("kind")).lower()
    code, base = _row_code(geometry)
    same = [row for row in thermal_rows if _text(row.get("kind")).lower() == kind]
    if code and any(_row_code(row)[0] == code for row in same):
        return True
    if base and any(_row_code(row)[1] == base for row in same):
        return True
    return False


def _find_target_page(pages: list[dict], geometry: dict) -> dict | None:
    source = _text(geometry.get("_sourceFile") or geometry.get("sourceFile")).lower()
    if source:
        for page in pages:
            if _text(page.get("sourceFile")).lower() == source:
                return page
    for page in pages:
        if geometry in list(page.get("envelope") or []):
            return page
    return pages[0] if pages else None


def resolve_request(request_path: Path, output_root: Path) -> Path:
    request_path = Path(request_path).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    facts_path = Path(_text(request.get("pageFactsPath"))).resolve()
    if not facts_path.is_file():
        return request_path
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    derived = json.loads(json.dumps(facts))
    en_pages = [page for page in list(derived.get("pages") or []) if _text(page.get("pageType")).upper() == "EN"]
    if not en_pages:
        return request_path

    rows: list[dict] = []
    for page in en_pages:
        for row in list(page.get("envelope") or []):
            if float(row.get("confidence") or 0) < MIN_CONFIDENCE:
                continue
            row["_sourceFile"] = page.get("sourceFile")
            rows.append(row)
    # Freeze the original current-revision thermal set. Reference projections never become
    # corroboration for another projection and never hide an exact missing tag in the audit.
    current_thermal_rows = [row for row in rows if _number(row.get("uFactor")) is not None]
    geometry_rows = [
        row for row in rows
        if _number(row.get("grossAreaFt2")) is not None
        and _number(row.get("uFactor")) is None
        and _text(row.get("kind")).lower() in {"window", "door"}
        and _row_code(row)[0]
    ]
    if not geometry_rows:
        return request_path

    profiles = _approved_profiles(_reference_path())
    window_corroboration = [
        row for row in current_thermal_rows
        if _text(row.get("kind")).lower() == "window"
        and _profile_matches_row(profiles["window"], row, require_shgc=True)
    ]
    door_corroboration = [
        row for row in current_thermal_rows
        if _text(row.get("kind")).lower() == "door"
        and _is_glazed_door(row)
        and _profile_matches_row(profiles["door"], row, require_shgc=False)
    ]
    same_reference_glazing = profiles["window"].get("handle") == profiles["door"].get("handle")
    window_proven = bool(window_corroboration)
    # The approved reference itself proves WIN_EXT and DOOR_EXT use the same glazing layer.
    # A current matching window signature may therefore corroborate a missing *glazed* door
    # subtype, but never an opaque door.
    door_proven = bool(door_corroboration) or (window_proven and same_reference_glazing)

    filled: list[dict] = []
    skipped: list[dict] = []
    for geometry in geometry_rows:
        if _has_existing_match(geometry, current_thermal_rows):
            continue
        kind = _text(geometry.get("kind")).lower()
        code, _ = _row_code(geometry)
        profile = profiles.get(kind)
        allowed = window_proven if kind == "window" else door_proven and _is_glazed_door(geometry)
        if not profile or not allowed:
            skipped.append({"code": code, "kind": kind, "reason": "same-envelope signature not corroborated"})
            continue

        # VT lives on the current geometry row so r49 preserves it when it merges the
        # exact-code reference thermal row. Geometry/area/orientation are untouched.
        if profile.get("vt") is not None and geometry.get("vt") in (None, ""):
            geometry["vt"] = profile["vt"]

        thermal = {
            "kind": kind,
            "assemblyType": code,
            "description": _text(geometry.get("description")) or ("Approved-reference window" if kind == "window" else "Approved-reference glazed door"),
            "orientation": None,
            "grossAreaFt2": None,
            "uFactor": profile["uFactor"],
            "shgc": profile["shgc"],
            "vt": profile.get("vt"),
            "cavityR": None,
            "continuousR": None,
            "product": None,
            "confidence": 1.0,
            "evidence": (
                f"{code} thermal performance from approved 79 Winthrop proposed envelope "
                f"reference construction {profile['construction']}; same-envelope signature "
                "corroborated by current EN thermal facts"
            ),
            "sourceFile": REFERENCE_NAME,
            "referenceEnvelopeAuthority": "APPROVED_79_WINTHROP_PROPOSED_ENVELOPE",
            "referenceEnvelopeSha256": profiles["referenceSha256"],
        }
        target = _find_target_page(en_pages, geometry)
        if target is None:
            skipped.append({"code": code, "kind": kind, "reason": "no EN page container"})
            continue
        target.setdefault("envelope", []).append(thermal)
        filled.append({
            "code": code,
            "kind": kind,
            "uFactor": profile["uFactor"],
            "shgc": profile["shgc"],
            "vt": profile.get("vt"),
            "referenceConstruction": profile["construction"],
        })

    audit = {
        "schema": SCHEMA,
        "version": VERSION,
        "sourceEngineeringRevision": _text(request.get("revision")),
        "policy": "CURRENT_PROJECT_GEOMETRY_PLUS_APPROVED_REFERENCE_THERMAL_PERFORMANCE",
        "currentProjectAuthority": ["project identity", "tag", "kind", "geometry", "gross area", "orientation"],
        "referenceAuthority": ["U-factor", "SHGC", "VT", "fenestration performance class"],
        "reference": REFERENCE_NAME,
        "referenceSha256": profiles["referenceSha256"],
        "referenceProfiles": {
            "window": {key: profiles["window"].get(key) for key in ("construction", "material", "uFactor", "uFactorSI", "shgc", "vt")},
            "door": {key: profiles["door"].get(key) for key in ("construction", "material", "uFactor", "uFactorSI", "shgc", "vt")},
        },
        "corroboration": {
            "window": [_row_code(row)[0] for row in window_corroboration],
            "door": [_row_code(row)[0] for row in door_corroboration],
            "sameApprovedGlazingLayerForWindowAndDoor": same_reference_glazing,
        },
        "filled": filled,
        "skipped": skipped,
        "sourceEvidenceMutated": False,
        "referenceProjectIdentityCopied": False,
        "referenceProjectQuantitiesCopied": False,
        "currentProjectCxlUsedAsThermalAuthority": False,
    }
    output_root.mkdir(parents=True, exist_ok=True)
    audit_path = output_root / "REFERENCE_ENVELOPE_PROJECTION_R118.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")
    if not filled:
        print(json.dumps({"stage": "REFERENCE_ENVELOPE_R118", "status": "NO_PROJECTION", "skipped": skipped}, ensure_ascii=True), flush=True)
        return request_path

    facts_out = output_root / "00_PAGE_FACTS_REFERENCE_ENVELOPE_R118.json"
    facts_out.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_out)
    derived_request["referenceEnvelopeProjection"] = {
        "schema": SCHEMA,
        "version": VERSION,
        "auditFile": audit_path.name,
        "reference": REFERENCE_NAME,
        "referenceSha256": profiles["referenceSha256"],
        "filledCodes": [row["code"] for row in filled],
    }
    request_out = output_root / "00_PIPELINE_REQUEST_REFERENCE_ENVELOPE_R118.json"
    request_out.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "REFERENCE_ENVELOPE_R118",
        "status": "PROJECTED",
        "filledCodes": [row["code"] for row in filled],
        "referenceSha256": profiles["referenceSha256"],
        "sourceEvidenceMutated": False,
    }, ensure_ascii=True), flush=True)
    return request_out
