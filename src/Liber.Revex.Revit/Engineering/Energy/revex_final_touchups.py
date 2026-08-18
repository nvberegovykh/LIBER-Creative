#!/usr/bin/env python3
"""Current REVEX Energy publication policy.

Versioned implementations remain preserved as shadow files. This canonical module owns
current runtime behavior and delegates only proven mechanics to the r125 shadow.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
from typing import Any

import revex_final_touchups_r125 as _shadow
import revex_native_schedule_envelope as _native_envelope

VERSION = "20260818-current-energy6"
MISSING_VT = 0.45

_shadow_patch_pipeline = _shadow.patch_pipeline
_shadow_schedule_path = _shadow._schedule_path
_MISSING_VT_SHADOW_AUTHORITIES = {"CODE_FALLBACK_TINTED", "CODE_FALLBACK_CLEAR"}
_NON_ACTUAL_VT_AUTHORITIES = {
    "CODE_FALLBACK_TINTED",
    "CODE_FALLBACK_CLEAR",
    "REVEX_FIXED_MISSING_VT_0_45",
    "APPROVED_SAME_ENVELOPE_REFERENCE_VT",
}


def _actual_vt(row: dict) -> float | None:
    """Read only project-evidenced VT; never reinterpret a derived fallback as actual."""
    authority = str(row.get("visibleTransmittanceAuthority") or "").strip().upper()
    if authority in _NON_ACTUAL_VT_AUTHORITIES:
        return None
    for key in ("vt", "vlt", "visibleTransmittance"):
        value = row.get(key)
        if value not in (None, ""):
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if 0.0 <= number <= 1.0:
                return number
    text = " ".join(str(row.get(key) or "") for key in ("evidence", "description", "assemblyType", "product"))
    match = re.search(r"\bV(?:T|LT)\s*[:=]?\s*(0?(?:\.\d+)|1(?:\.0+)?)", text, re.I)
    if not match:
        return None
    number = float(match.group(1))
    return number if 0.0 <= number <= 1.0 else None


def _artifact_by_role(request: dict, role: str) -> Path | None:
    """Resolve current immutable evidence by manifest role; filename is only a transfer locator."""
    manifest_raw = str(request.get("engineeringManifestPath") or "").strip()
    if not manifest_raw:
        return None
    manifest_path = Path(manifest_raw).resolve()
    if not manifest_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    wanted = next((row for row in list(manifest.get("artifacts") or [])
                   if str(row.get("role") or "").strip().casefold() == role.casefold()), None)
    if not wanted:
        return None
    declared_name = Path(str(wanted.get("name") or "")).name.casefold()
    for raw in list(request.get("sourceArtifacts") or []):
        path = Path(str(raw)).resolve()
        if path.is_file() and path.name.casefold() == declared_name:
            return path
    return None


def _current_schedule_path(request: dict) -> Path | None:
    current = _artifact_by_role(request, "revit-schedule-evidence")
    if current is not None:
        return current
    # Compatibility adapter only for previously-published revisions lacking role metadata.
    return _shadow_schedule_path(request)


def _apply_current_policy() -> None:
    _shadow.VT_CLEAR_FALLBACK = MISSING_VT
    _shadow.VT_TINTED_FALLBACK = MISSING_VT
    _shadow._schedule_path = _current_schedule_path


def _normalize_touchup_outputs(request_out: Path) -> None:
    """Relabel only rows that the shadow explicitly filled as missing VT."""
    try:
        request = json.loads(Path(request_out).read_text(encoding="utf-8"))
    except Exception:
        return
    facts_path = Path(str(request.get("pageFactsPath") or ""))
    if facts_path.is_file():
        facts = json.loads(facts_path.read_text(encoding="utf-8"))
        changed = False
        for page in list(facts.get("pages") or []):
            for row in list(page.get("envelope") or []):
                authority = str(row.get("visibleTransmittanceAuthority") or "")
                if authority in _MISSING_VT_SHADOW_AUTHORITIES and str(row.get("kind") or "").lower() in {"window", "door"}:
                    row["vt"] = MISSING_VT
                    row["visibleTransmittanceAuthority"] = "REVEX_FIXED_MISSING_VT_0_45"
                    changed = True
        if changed:
            facts_path.write_text(json.dumps(facts, ensure_ascii=True, indent=2), encoding="utf-8")

    touch = dict(request.get("finalTouchupsR125") or {})
    audit_path = Path(request_out).parent / str(touch.get("auditFile") or "")
    if audit_path.is_file():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        rows = []
        for row in list(audit.get("vtFallbacks") or []):
            updated = dict(row)
            updated["vt"] = MISSING_VT
            updated["authority"] = "REVEX_FIXED_MISSING_VT_0_45"
            rows.append(updated)
        audit["vtFallbacks"] = rows
        audit["policy"] = "NATIVE_SCHEDULE_TOTAL_OVER_REGION_RESUM; ACTUAL_VT_ELSE_FIXED_0_45"
        audit["currentPolicyVersion"] = VERSION
        audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")


def _apply_native_schedule_orientation(request_out: Path) -> None:
    """Restore exact current EN-schedule orientation before the COMcheck preflight.

    The active Revit schedule snapshot is the authority. PDF/page scan geometry remains lower
    authority and model surfaces are deliberately not consulted for filing orientation.
    """
    try:
        request = json.loads(Path(request_out).read_text(encoding="utf-8"))
    except Exception:
        return
    schedule_path = _current_schedule_path(request)
    audit = _native_envelope.apply_missing_orientations(request_out, schedule_path)
    audit_path = Path(request_out).parent / "NATIVE_EN_SCHEDULE_ORIENTATION_CURRENT.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")
    request = json.loads(Path(request_out).read_text(encoding="utf-8"))
    request["nativeEnScheduleOrientation"] = {
        "schema": audit.get("schema"),
        "version": audit.get("version"),
        "status": audit.get("status"),
        "authority": audit.get("authority"),
        "auditFile": audit_path.name,
        "filledCount": len(list(audit.get("filled") or [])),
        "unresolvedCount": len(list(audit.get("unresolved") or [])),
    }
    Path(request_out).write_text(json.dumps(request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "NATIVE_EN_SCHEDULE_ORIENTATION_CURRENT",
        "status": audit.get("status"),
        "filled": audit.get("filled") or [],
        "unresolved": audit.get("unresolved") or [],
        "sourceEvidenceMutated": False,
    }, ensure_ascii=True), flush=True)


def apply_request_touchups(request_path: Path, output_root: Path, reference_envelope) -> Path:
    _apply_current_policy()
    # Actual VT wins. For absent VT, current policy bypasses the old reference-VT branch and
    # inserts exactly 0.45 in a derived page-facts copy; immutable Engineering evidence is untouched.
    original_profiles = getattr(reference_envelope, "_approved_profiles", None) if reference_envelope is not None else None
    if reference_envelope is not None and original_profiles is not None:
        reference_envelope._approved_profiles = lambda _path: {}
    try:
        result = Path(_shadow.apply_request_touchups(request_path, output_root, reference_envelope))
    finally:
        if reference_envelope is not None and original_profiles is not None:
            reference_envelope._approved_profiles = original_profiles
    if result.is_file():
        _normalize_touchup_outputs(result)
        _apply_native_schedule_orientation(result)
    return result


def patch_pipeline(module, reference_envelope=None) -> None:
    if getattr(module, "__revex_current_patched__", False):
        return
    _apply_current_policy()
    # The r125 shadow retains proven merge/COMcheck/EN-1 mechanics. Passing no reference
    # disables the retired reference-VT fallback while leaving all non-VT mechanics intact.
    _shadow_patch_pipeline(module, None)
    shadow_merge = module._merge_diagram_geometry_with_thermal

    def merge(diagram_row, thermal_rows):
        merged, error = shadow_merge(diagram_row, thermal_rows)
        if merged is None:
            return merged, error
        actual = _actual_vt(diagram_row)
        if actual is None:
            kind = str(merged.get("kind") or diagram_row.get("kind") or "").lower()
            code, base_code = module._comcheck_row_code(diagram_row)
            same = [r for r in thermal_rows if str(r.get("kind") or "").lower() == kind]
            exact = [r for r in same if code and module._comcheck_row_code(r)[0] == code]
            base = [r for r in same if base_code and module._comcheck_row_code(r)[1] == base_code]
            for candidate in exact or base or same:
                actual = _actual_vt(candidate)
                if actual is not None:
                    break
        if actual is not None:
            merged["vt"] = round(float(actual), 3)
            merged["visibleTransmittanceAuthority"] = "ACTIVE_ENVELOPE_EVIDENCE_VT"
        return merged, error

    module._merge_diagram_geometry_with_thermal = merge
    module.__revex_current_patched__ = True


def _bind_shadow_runtime() -> None:
    _apply_current_policy()
    _shadow.patch_pipeline = patch_pipeline


def install_guard_touchups(r116_module, reference_envelope) -> None:
    _bind_shadow_runtime()
    return _shadow.install_guard_touchups(r116_module, reference_envelope)


def install_worker_touchups() -> None:
    _bind_shadow_runtime()
    return _shadow.install_worker_touchups()


native_roof_schedule_total = _shadow.native_roof_schedule_total
strict_en1_pdf = _shadow.strict_en1_pdf
patch_en1_and_resume = _shadow.patch_en1_and_resume
_compact_label = _shadow._compact_label
_row_has_vt = _shadow._row_has_vt
_tinted = _shadow._tinted
_number = _shadow._number
_text = _shadow._text


def __getattr__(name: str) -> Any:
    return getattr(_shadow, name)
