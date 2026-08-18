#!/usr/bin/env python3
"""Final filing guards owned by the active WALLT Energy controller.

This module is deliberately narrow. It does not model energy. It makes the proven pipeline's
filing boundary deterministic for two failures observed in the real review package:
- every glazed COMcheck opening has valid VT; missing VT is exactly 0.45;
- the review GEOMETRY.osm carries current-project identity, never the approved-reference identity.
It also normalizes raw EN orientation/VT before canonicalization so current azimuth/normal evidence
is not lost at the filing-row projection boundary.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import revex_energy_agent_evidence as ev

VERSION = "20260818-wallt-filing2"
MISSING_VT = 0.45


def _text(value):
    return str(value or "").strip()


def _local(node):
    return node.tag.rsplit("}", 1)[-1]


def _child(node, name):
    return next((child for child in list(node) if _local(child) == name), None)


def _child_text(node, name):
    child = _child(node, name)
    return _text(child.text) if child is not None else ""


def _valid_vt(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if 0.0 <= number <= 1.0 else None


def _is_glazed(node):
    kind = _local(node)
    if kind == "window":
        return True
    if kind != "door":
        return False
    if _child(node, "glazingType") is not None or _child(node, "propShgc") is not None:
        return True
    text = " ".join(_child_text(node, key) for key in ("assemblyType", "description", "doorType")).lower()
    return "glass" in text or "glaz" in text


def _set_vt(node, value):
    vt = _child(node, "propVt")
    if vt is None:
        ns_uri = node.tag.split("}")[0].strip("{") if "}" in node.tag else ""
        tag = f"{{{ns_uri}}}propVt" if ns_uri else "propVt"
        vt = ET.Element(tag)
        children = list(node)
        insert_at = len(children)
        for index, existing in enumerate(children):
            if _local(existing) in {"propUvalue", "propShgc"}:
                insert_at = index + 1
        node.insert(insert_at, vt)
    vt.text = f"{float(value):.3f}"


def enforce_comcheck_vt(cxl: Path) -> dict:
    """Preserve actual VT and fill every genuinely missing glazed-opening VT with 0.45."""
    cxl = Path(cxl)
    tree = ET.parse(cxl)
    root = tree.getroot()
    glazed = []
    filled = []
    preserved = []
    for node in root.iter():
        if _local(node) not in {"window", "door"} or not _is_glazed(node):
            continue
        label = _child_text(node, "assemblyType") or _child_text(node, "description") or _local(node)
        current = _valid_vt(_child_text(node, "propVt"))
        if current is None:
            _set_vt(node, MISSING_VT)
            current = MISSING_VT
            filled.append({"kind": _local(node), "assemblyType": label, "vt": MISSING_VT,
                           "authority": "REVEX_FIXED_MISSING_VT_0_45"})
        else:
            preserved.append({"kind": _local(node), "assemblyType": label, "vt": round(current, 3),
                              "authority": "ACTIVE_PROJECT_OR_ALREADY_SERIALIZED_VT"})
        glazed.append((node, current))

    envelope = next((node for node in root.iter() if _local(node) == "envelope"), None)
    if glazed and envelope is not None:
        use = _child(envelope, "useVltDetails")
        if use is not None:
            use.text = "true"

    unresolved = []
    for node, _ in glazed:
        current = _valid_vt(_child_text(node, "propVt"))
        if current is None:
            unresolved.append(_child_text(node, "assemblyType") or _local(node))
    if unresolved:
        raise ValueError("WALLT could not serialize valid VT for glazed COMcheck openings: " + ", ".join(unresolved))

    if "}" in root.tag:
        ET.register_namespace("", root.tag.split("}")[0].strip("{"))
    tree.write(cxl, encoding="utf-8", xml_declaration=True)
    return {
        "schema": "liber.revex.wallt-comcheck-vt.v1",
        "version": VERSION,
        "status": "PASSED",
        "missingVtPolicy": MISSING_VT,
        "glazedOpeningCount": len(glazed),
        "filledCount": len(filled),
        "preservedCount": len(preserved),
        "filled": filled,
        "preserved": preserved,
        "useVltDetails": bool(glazed),
        "sourceEvidenceMutated": False,
    }


def _precanonical_pages(module, pages):
    derived = copy.deepcopy(list(pages or []))
    repairs = []
    unresolved = []
    for page in derived:
        rows = [dict(row) for row in list(page.get("envelope") or [])]
        if not rows:
            continue
        normalized, row_repairs, row_unresolved = ev.normalize_rows(module, rows)
        page["envelope"] = normalized
        repairs.extend(row_repairs)
        unresolved.extend(row_unresolved)
    return derived, repairs, unresolved


def install(module) -> None:
    if getattr(module, "__revex_wallt_filing_installed__", False):
        return

    # Preserve raw current-project orientation/VT evidence before the canonical filing projection.
    original_canonicalize = module.canonicalize_comcheck_envelope_rows
    def canonicalize(en_pages):
        pages, repairs, unresolved = _precanonical_pages(module, en_pages)
        rows, audit = original_canonicalize(pages)
        audit = dict(audit or {})
        audit["walltPrecanonicalFiling"] = {
            "version": VERSION,
            "repairs": repairs,
            "unresolvedOrientation": unresolved,
            "missingVtPolicy": MISSING_VT,
            "sourceEvidenceMutated": False,
        }
        return rows, audit
    module.canonicalize_comcheck_envelope_rows = canonicalize

    # The original geometry OSM is user-visible in the review package. Stamp it at the same
    # identity boundary as Baseline/Proposed so no approved-reference project name can leak.
    original_stamp = getattr(module, "stamp_compiled_project_identity", None)
    stamped_geometry = set()
    if original_stamp is not None:
        def stamp(model_path, project_identity, role, log):
            path = Path(model_path)
            if _text(role).upper() in {"BASELINE", "PROPOSED"}:
                geometry = path.parent.parent / "01_ORIGINAL_MODELS" / "REVIT_GEOMETRY_ORIGINAL.osm"
                key = str(geometry.resolve()) if geometry.exists() else ""
                if key and key not in stamped_geometry:
                    original_stamp(geometry, project_identity, "GEOMETRY", log)
                    stamped_geometry.add(key)
                    try:
                        log.write("WALLT_GEOMETRY_REVIEW_IDENTITY", "PASSED", geometry=geometry.name,
                                  identitySource="ACTIVE_REVIT_PROJECT_IDENTITY")
                    except Exception:
                        pass
            return original_stamp(model_path, project_identity, role, log)
        module.stamp_compiled_project_identity = stamp

    # Last filing boundary: regardless of upstream extractor history, an actual VT is preserved
    # and an absent VT is serialized as exactly 0.45 before official COMcheck sees the CXL.
    original_prepare = module.prepare_project_comcheck
    def prepare(facts, project_identity, filing_dir, log):
        cxl, audit_pdf, audit = original_prepare(facts, project_identity, filing_dir, log)
        if cxl is None or not Path(cxl).is_file():
            return cxl, audit_pdf, audit
        vt_audit = enforce_comcheck_vt(Path(cxl))
        audit = dict(audit or {})
        structure = dict(audit.get("cxlStructure") or {})
        structure["walltVt"] = vt_audit
        structure["useVltDetails"] = vt_audit["useVltDetails"]
        audit["cxlStructure"] = structure
        audit["missingVtPolicy"] = MISSING_VT
        audit_json = Path(filing_dir) / "COMcheck_INPUT_AUDIT.json"
        if audit_json.is_file():
            try:
                persisted = json.loads(audit_json.read_text(encoding="utf-8"))
            except Exception:
                persisted = {}
            persisted["cxlStructure"] = structure
            persisted["missingVtPolicy"] = MISSING_VT
            audit_json.write_text(json.dumps(persisted, ensure_ascii=True, indent=2), encoding="utf-8")
        try:
            log.write("WALLT_COMCHECK_VT", "PASSED", **vt_audit)
        except Exception:
            pass
        return cxl, audit_pdf, audit
    module.prepare_project_comcheck = prepare

    module.__revex_wallt_filing_installed__ = True
