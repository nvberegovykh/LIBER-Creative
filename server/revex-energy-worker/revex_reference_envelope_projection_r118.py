#!/usr/bin/env python3
"""REVEX approved-envelope thermal projection.

Current immutable Engineering evidence always owns project identity, EN row identity,
kind, geometry, area and orientation.  When a high-confidence current EN geometry row
has no usable thermal-property row, REVEX may project only thermal performance from
the approved 79 Winthrop proposed-envelope reference.

The fallback is class based, not project/tag based:
- roof -> approved roof assembly
- floor -> approved exposed-floor or cellar-slab assembly
- wall -> approved above-grade or cellar/foundation wall assembly
- window -> approved exterior fenestration
- door -> approved exterior door

Existing exact current thermal rows always win.  No prior-project quantity, geometry,
identity or CXL is copied.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any

SCHEMA = "liber.revex.reference-envelope-projection.v2"
VERSION = "20260817r121-envelope-class1"
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
        path = Path(configured).resolve()
        if path.is_file():
            return path
        raise RuntimeError(f"Configured approved envelope reference is unavailable: {path}")
    packaged = Path(__file__).resolve().parents[1] / "energy" / "References" / REFERENCE_NAME
    if packaged.is_file():
        return packaged
    impl = _text(os.environ.get("REVEX_PIPELINE_IMPL"))
    if impl:
        candidate = Path(impl).resolve().parent / "References" / REFERENCE_NAME
        if candidate.is_file():
            return candidate
    source = (Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy/References" / REFERENCE_NAME).resolve()
    if source.is_file():
        return source
    raise RuntimeError("Approved envelope reference is unavailable in all supported layouts: " + ", ".join(str(p) for p in (packaged, source)))


def _osm_fields(block: str) -> list[str]:
    return [line.strip().rstrip(",;").strip() for line in block.splitlines() if line.strip()]


def _nominal_r(name: str) -> float | None:
    token = _text(name).upper()
    # Material naming in the approved model encodes the intended filing R-value.
    # R26_4_6I -> R26.4 with 6-inch thickness; R15_3IN -> R15 with 3-inch thickness.
    m = re.search(r"(?:^|_)R(\d+)_([0-9]+)_([0-9]+)I(?:N)?(?:_|$)", token)
    if m:
        return float(f"{m.group(1)}.{m.group(2)}")
    m = re.search(r"(?:^|_)R(\d+)_([0-9]+)IN(?:_|$)", token)
    if m:
        return float(m.group(1))
    m = re.search(r"(?:^|_)R(\d+(?:\.\d+)?)(?:_|$)", token)
    return float(m.group(1)) if m else None


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
        u_si, shgc, vt = _number(fields[2]), _number(fields[3]), _number(fields[4])
        if u_si is None or shgc is None:
            continue
        glazing[handle] = {"material": fields[1], "uFactor": round(u_si * W_M2K_TO_BTU_H_FT2_F, 2), "uFactorSI": u_si, "shgc": shgc, "vt": vt, "handle": handle}

    material_names: dict[str, str] = {}
    for object_type in ("Material", "Material:NoMass", "Material:AirGap"):
        for match in re.finditer(rf"OS:{re.escape(object_type)},\s*(.*?);", source, re.S):
            fields = _osm_fields(match.group(1))
            if len(fields) >= 2:
                material_names[fields[0].strip("{}")] = fields[1]

    constructions: list[dict] = []
    for match in re.finditer(r"OS:Construction,\s*(.*?);", source, re.S):
        fields = _osm_fields(match.group(1))
        if len(fields) < 3:
            continue
        constructions.append({"handle": fields[0].strip("{}"), "name": fields[1], "layers": [field.strip("{}") for field in fields[2:]]})

    def construction(pattern: str) -> dict:
        matches = [row for row in constructions if re.search(pattern, row["name"], re.I)]
        if not matches:
            raise RuntimeError(f"Approved proposed reference has no construction /{pattern}/")
        return matches[0]

    def fenestration(pattern: str) -> dict:
        c = construction(pattern)
        for layer in c["layers"]:
            if layer in glazing:
                return {**glazing[layer], "construction": c["name"]}
        raise RuntimeError(f"Approved proposed reference has no glazing profile for construction {c['name']}")

    def opaque(pattern: str, profile_class: str) -> dict:
        c = construction(pattern)
        layers = [material_names.get(handle, "") for handle in c["layers"]]
        r_layers = [(name, _nominal_r(name)) for name in layers]
        r_layers = [(name, value) for name, value in r_layers if value is not None]
        continuous = [value for name, value in r_layers if any(t in name.upper() for t in ("EIFS", "RIGID", "CONT", "_CI_", "MINERAL_WOOL"))]
        cavity = [value for name, value in r_layers if any(t in name.upper() for t in ("SPRAY", "BATT", "CAVITY"))]
        return {
            "class": profile_class,
            "construction": c["name"],
            "materials": layers,
            "cavityR": max(cavity) if cavity else 0.0,
            "continuousR": max(continuous) if continuous else 0.0,
            "uFactor": None, "shgc": None, "vt": None,
        }

    profiles = {
        "window": fenestration(r"\bWIN_EXT(?:_|\b)"),
        "door": fenestration(r"\bDOOR_EXT(?:_|\b)"),
        "roof": opaque(r"\bR1_ROOF_PROPOSED\b", "roof"),
        "wall_above": opaque(r"\bMAT_WALL_SPRAYFOAM_R13_2IN\b", "wall_above"),
        "wall_cellar": opaque(r"\bF1_WALL_CELLAR_12INCONC_R8_R13\b", "wall_cellar"),
        "floor_exposed": opaque(r"\bF1_EXT_FLOOR_JOIST\b", "floor_exposed"),
        "floor_slab": opaque(r"\bG_FLOOR_CELLAR_SLAB_6IN\b", "floor_slab"),
    }
    profiles["reference"] = str(path)
    profiles["referenceSha256"] = _sha256(path)
    return profiles


def _row_code(row: dict) -> tuple[str, str]:
    source = " ".join(_text(row.get(key)) for key in ("evidence", "assemblyType", "description"))
    match = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", source.upper())
    if not match:
        return "", ""
    code = match.group(1)
    return code, code.split(".", 1)[0]


def _row_text(row: dict) -> str:
    return " ".join(_text(row.get(k)) for k in ("assemblyType", "description", "evidence")).lower()


def _has_any_thermal(row: dict) -> bool:
    kind = _text(row.get("kind")).lower()
    if kind in {"window", "door"}:
        return _number(row.get("uFactor")) is not None
    return any(row.get(k) not in (None, "") for k in ("cavityR", "continuousR"))


def _thermal_signature(row: dict) -> tuple:
    kind = _text(row.get("kind")).lower()
    if kind in {"window", "door"}:
        return (_number(row.get("uFactor")), _number(row.get("shgc")))
    return (_number(row.get("cavityR")) or 0.0, _number(row.get("continuousR")) or 0.0)


def _profile_signature(profile: dict, kind: str) -> tuple:
    if kind in {"window", "door"}:
        return (_number(profile.get("uFactor")), _number(profile.get("shgc")))
    return (_number(profile.get("cavityR")) or 0.0, _number(profile.get("continuousR")) or 0.0)


def _profile_matches_row(profile: dict, row: dict) -> bool:
    kind = _text(row.get("kind")).lower()
    actual = _thermal_signature(row)
    expected = _profile_signature(profile, kind)
    if kind in {"window", "door"}:
        u, shgc = actual
        eu, eshgc = expected
        return u is not None and eu is not None and abs(u-eu) <= U_TOLERANCE and (shgc is None or eshgc is None or abs(shgc-eshgc) <= SHGC_TOLERANCE)
    return abs(actual[0]-expected[0]) <= 0.25 and abs(actual[1]-expected[1]) <= 0.25


def _has_existing_match(geometry: dict, thermal_rows: list[dict]) -> bool:
    kind = _text(geometry.get("kind")).lower()
    code, base = _row_code(geometry)
    same = [row for row in thermal_rows if _text(row.get("kind")).lower() == kind]
    if code and any(_row_code(row)[0] == code for row in same):
        return True
    if base and any(_row_code(row)[1] == base for row in same):
        return True
    return False


def _class_for_row(row: dict) -> str:
    kind = _text(row.get("kind")).lower()
    code, _ = _row_code(row)
    text = _row_text(row)
    if kind == "window": return "window"
    if kind == "door": return "door"
    if kind == "roof": return "roof"
    if kind == "wall":
        if code.startswith("F") or any(t in text for t in ("cellar", "foundation", "below grade", "below-grade", "basement", "12in conc", "12 in conc", "cast concrete")):
            return "wall_cellar"
        return "wall_above"
    if kind == "floor":
        if any(t in text for t in ("slab", "cellar", "on grade", "on-grade", "ground", "soil")):
            return "floor_slab"
        return "floor_exposed"
    return ""


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
    if not facts_path.is_file(): return request_path
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    derived = json.loads(json.dumps(facts))
    en_pages = [p for p in list(derived.get("pages") or []) if _text(p.get("pageType")).upper() == "EN"]
    if not en_pages: return request_path

    rows: list[dict] = []
    for page in en_pages:
        for row in list(page.get("envelope") or []):
            if float(row.get("confidence") or 0) < MIN_CONFIDENCE: continue
            row["_sourceFile"] = page.get("sourceFile")
            rows.append(row)

    thermal_rows = [row for row in rows if _has_any_thermal(row)]
    geometry_rows = [row for row in rows if _number(row.get("grossAreaFt2")) is not None and not _has_any_thermal(row) and _text(row.get("kind")).lower() in {"roof", "floor", "wall", "window", "door"} and _row_code(row)[0]]
    if not geometry_rows: return request_path

    profiles = _approved_profiles(_reference_path())
    # A same-envelope anchor in any class proves the selected approved-envelope family.
    # This avoids requiring every drawing class to repeat its thermal schedule while still
    # rejecting unrelated references that share no current thermal signature at all.
    corroboration: list[dict] = []
    for row in thermal_rows:
        cls = _class_for_row(row)
        profile = profiles.get(cls)
        if profile and _profile_matches_row(profile, row):
            corroboration.append({"code": _row_code(row)[0], "kind": _text(row.get("kind")).lower(), "class": cls})
    reference_proven = bool(corroboration)

    filled: list[dict] = []
    skipped: list[dict] = []
    for geometry in geometry_rows:
        if _has_existing_match(geometry, thermal_rows): continue
        kind = _text(geometry.get("kind")).lower()
        code, _ = _row_code(geometry)
        cls = _class_for_row(geometry)
        profile = profiles.get(cls)
        if not profile or not reference_proven:
            skipped.append({"code": code, "kind": kind, "class": cls, "reason": "approved same-envelope family not corroborated by current EN thermal facts"})
            continue
        if kind == "window" and profile.get("vt") is not None and geometry.get("vt") in (None, ""):
            geometry["vt"] = profile["vt"]
        thermal = {
            "kind": kind,
            "assemblyType": code,
            # Keep the current row semantics so COMcheck exemplar selection (CMU/concrete,
            # fixed/operable, entrance/non-entrance) still comes from the current project.
            "description": _text(geometry.get("description")) or _text(geometry.get("assemblyType")) or f"Approved-reference {kind}",
            "orientation": None, "grossAreaFt2": None,
            "uFactor": profile.get("uFactor"), "shgc": profile.get("shgc"), "vt": profile.get("vt"),
            "cavityR": profile.get("cavityR"), "continuousR": profile.get("continuousR"),
            "product": None, "confidence": 1.0,
            "evidence": f"{code} thermal class {cls} from approved 79 Winthrop proposed envelope construction {profile['construction']}; current-project geometry retained",
            "sourceFile": REFERENCE_NAME,
            "referenceEnvelopeAuthority": "APPROVED_79_WINTHROP_PROPOSED_ENVELOPE",
            "referenceEnvelopeClass": cls,
            "referenceEnvelopeSha256": profiles["referenceSha256"],
        }
        target = _find_target_page(en_pages, geometry)
        if target is None:
            skipped.append({"code": code, "kind": kind, "class": cls, "reason": "no EN page container"}); continue
        target.setdefault("envelope", []).append(thermal)
        filled.append({"code": code, "kind": kind, "class": cls, "uFactor": profile.get("uFactor"), "shgc": profile.get("shgc"), "vt": profile.get("vt"), "cavityR": profile.get("cavityR"), "continuousR": profile.get("continuousR"), "referenceConstruction": profile["construction"]})

    audit = {
        "schema": SCHEMA, "version": VERSION, "sourceEngineeringRevision": _text(request.get("revision")),
        "policy": "CURRENT_PROJECT_GEOMETRY_PLUS_APPROVED_REFERENCE_THERMAL_CLASS",
        "currentProjectAuthority": ["project identity", "EN row/tag", "kind", "geometry", "gross area", "orientation", "current assembly semantics"],
        "referenceAuthority": ["thermal envelope class", "U-factor", "SHGC", "VT", "cavity R", "continuous R"],
        "reference": REFERENCE_NAME, "referenceSha256": profiles["referenceSha256"],
        "referenceFamilyCorroborated": reference_proven, "corroboration": corroboration,
        "referenceProfiles": {key: {k: value.get(k) for k in ("class", "construction", "material", "uFactor", "shgc", "vt", "cavityR", "continuousR")} for key, value in profiles.items() if isinstance(value, dict)},
        "filled": filled, "skipped": skipped,
        "sourceEvidenceMutated": False, "referenceProjectIdentityCopied": False, "referenceProjectQuantitiesCopied": False, "currentProjectCxlUsedAsThermalAuthority": False,
    }
    output_root.mkdir(parents=True, exist_ok=True)
    audit_path = output_root / "REFERENCE_ENVELOPE_PROJECTION_R118.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")
    if not filled:
        print(json.dumps({"stage": "REFERENCE_ENVELOPE_R121", "status": "NO_PROJECTION", "skipped": skipped}, ensure_ascii=True), flush=True)
        return request_path

    facts_out = output_root / "00_PAGE_FACTS_REFERENCE_ENVELOPE_R118.json"
    facts_out.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_out)
    derived_request["referenceEnvelopeProjection"] = {"schema": SCHEMA, "version": VERSION, "auditFile": audit_path.name, "reference": REFERENCE_NAME, "referenceSha256": profiles["referenceSha256"], "filledCodes": [row["code"] for row in filled]}
    request_out = output_root / "00_PIPELINE_REQUEST_REFERENCE_ENVELOPE_R118.json"
    request_out.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({"stage": "REFERENCE_ENVELOPE_R121", "status": "PROJECTED", "filledCodes": [row["code"] for row in filled], "filledClasses": sorted(set(row["class"] for row in filled)), "referenceSha256": profiles["referenceSha256"], "sourceEvidenceMutated": False}, ensure_ascii=True), flush=True)
    return request_out
