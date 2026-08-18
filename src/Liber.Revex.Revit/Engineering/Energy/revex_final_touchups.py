#!/usr/bin/env python3
"""Current REVEX Energy publication policy.

Versioned implementations remain preserved as shadow files. This canonical module owns
current runtime behavior and delegates only proven mechanics to the r125 shadow.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import revex_final_touchups_r125 as _shadow

VERSION = "20260817r127-current-energy2"
MISSING_VT = 0.45

_shadow_patch_pipeline = _shadow.patch_pipeline
_MISSING_VT_SHADOW_AUTHORITIES = {"CODE_FALLBACK_TINTED", "CODE_FALLBACK_CLEAR"}


def _apply_current_policy() -> None:
    # Preserve actual VT from evidence. The shadow reaches these constants only when VT is missing.
    _shadow.VT_CLEAR_FALLBACK = MISSING_VT
    _shadow.VT_TINTED_FALLBACK = MISSING_VT


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


def apply_request_touchups(request_path: Path, output_root: Path, reference_envelope) -> Path:
    _apply_current_policy()
    # Current filing policy: actual VT wins; if absent, insert exactly 0.45. Disable the
    # old approved-reference VT lookup while retaining every other r125 touch-up.
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
    return result


def patch_pipeline(module, reference_envelope=None) -> None:
    _apply_current_policy()
    # Passing no reference is intentional: actual VT is already carried by the proven
    # merge logic; only the missing-VT branch reaches the fixed 0.45 fallback.
    _shadow_patch_pipeline(module, None)


def _bind_shadow_runtime() -> None:
    _apply_current_policy()
    # r125's resume/install helpers resolve this global at runtime. Redirect them to the
    # canonical current policy while keeping the historical shadow file unchanged.
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
