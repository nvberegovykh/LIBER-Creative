#!/usr/bin/env python3
"""REVEX r91 GeometryCo source-condition resolver.

This module wraps the existing GeometryCo compiler without weakening any gate.
It only resolves an otherwise ambiguous new-space assignment when all of the
following are true:

1. the space is ambiguous in GeometryCo preflight;
2. the exact authoritative gbXML source can be bound back to that OS:Space;
3. gbXML carries an explicit conditionType (conditioned or unconditioned);
4. the approved template has >=3 already-resolved examples for that same
   conditioning family;
5. >=75% of those resolved examples agree on one anonymous behavior profile.

The generated mapping is role-specific (Baseline/Proposed), auditable, and is
then sent back through the unchanged GeometryCo 75% mapping gate, schedule lock,
exact-coordinate lock, native OpenStudio translation, and EnergyPlus smoke test.
No threshold is lowered and allow_ambiguous is never enabled.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
CORE_CANDIDATES = [
    HERE / "OpenStudio_Energy_Model_Geometry_Compiler_core.py",
    Path("/opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py"),
    HERE.parents[1] / "src" / "Liber.Revex.Revit" / "Engineering" / "Energy" / "GeometryCo" / "OpenStudio_Energy_Model_Geometry_Compiler.py",
]
CORE_PATH = next((p.resolve() for p in CORE_CANDIDATES if p.is_file()), None)
if CORE_PATH is None:
    raise RuntimeError("REVEX r91 could not locate the preserved GeometryCo core implementation.")

_spec = importlib.util.spec_from_file_location("revex_geometryco_core_r91", CORE_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Cannot import GeometryCo core from {CORE_PATH}")
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)

# Re-export the original API so existing QA/importers continue to exercise the
# same compiler surface. Only compile_baseline_proposed_pair is wrapped below.
for _name in dir(core):
    if _name.startswith("__"):
        continue
    globals().setdefault(_name, getattr(core, _name))

_ORIGINAL_COMPILE_PAIR = core.compile_baseline_proposed_pair


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", _clean(value).lower())


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _condition_family(value: Any) -> str | None:
    token = _norm(value)
    if token in {"heatedandcooled", "heated", "cooled", "conditioned"}:
        return "occupied_or_accessory"
    if token in {"unconditioned", "semiheated", "semiconditioned"}:
        return "unconditioned_core"
    return None


def _source_xml_candidates(outdir: Path) -> list[Path]:
    root = outdir.resolve().parent
    preferred = root / "00_SOURCE_EVIDENCE"
    candidates: list[Path] = []
    if preferred.is_dir():
        candidates.extend(sorted(preferred.rglob("*.xml")))
    # Fallback stays inside this immutable run folder only.
    candidates.extend(path for path in sorted(root.rglob("*.xml")) if path not in candidates)
    return candidates


def _xml_space_index(path: Path) -> dict[str, dict]:
    try:
        tree = ET.parse(path)
    except Exception:
        return {}
    root = tree.getroot()
    if _local(root.tag).lower() != "gbxml":
        return {}
    rows: dict[str, dict] = {}
    for space in root.iter():
        if _local(space.tag) != "Space":
            continue
        sid = _clean(space.attrib.get("id"))
        name = ""
        for child in list(space):
            if _local(child.tag) == "Name":
                name = _clean(child.text)
                break
        row = {
            "id": sid,
            "name": name,
            "conditionType": _clean(space.attrib.get("conditionType")),
            "zoneIdRef": _clean(space.attrib.get("zoneIdRef")),
            "source": str(path),
        }
        for token in {_norm(sid), _norm(name)}:
            if token:
                rows.setdefault(token, row)
    return rows


def _geometry_space_tokens(model, properties: dict[str, dict[str, str]], handle: str) -> set[str]:
    space = model.by_handle.get(handle)
    if not space or space.obj_type != "OS:Space":
        return set()
    props = properties.get(handle, {})
    values = [
        props.get("gbXMLId"), props.get("gbxmlid"), props.get("CADObjectId"),
        props.get("displayName"), space.name,
    ]
    return {token for token in (_norm(value) for value in values) if token}


def _select_source_xml(geometry, outdir: Path) -> tuple[Path, dict[str, dict], dict[str, set[str]]]:
    properties = core.additional_properties(geometry)
    tokens_by_handle = {
        space.handle: _geometry_space_tokens(geometry, properties, space.handle)
        for space in geometry.by_type.get("OS:Space", []) if space.handle
    }
    best: tuple[int, Path | None, dict[str, dict]] = (-1, None, {})
    for candidate in _source_xml_candidates(outdir):
        index = _xml_space_index(candidate)
        if not index:
            continue
        overlap = sum(1 for tokens in tokens_by_handle.values() if any(token in index for token in tokens))
        if overlap > best[0]:
            best = (overlap, candidate, index)
    overlap, path, index = best
    required = max(3, int(round(len(tokens_by_handle) * 0.75)))
    if path is None or overlap < required:
        raise core.CompileError(
            f"GeometryCo source-condition resolver could not bind the exact gbXML source: overlap={max(overlap,0)}/{len(tokens_by_handle)}, required>={required}."
        )
    return path, index, tokens_by_handle


def _row_profile_key(row: dict) -> str:
    return json.dumps(row.get("profile") or {}, sort_keys=True, separators=(",", ":"))


def _dominant_reference(mapping: dict, family: str) -> dict:
    threshold = float(core.MINIMUM_MAPPING_CONFIDENCE)
    rows = [
        row for row in (mapping.get("rows") or [])
        if not row.get("ambiguous")
        and float(row.get("score") or 0.0) >= threshold
        and _clean(row.get("conditioning_family")) == family
        and _clean(row.get("old_handle"))
    ]
    if len(rows) < 3:
        raise core.CompileError(
            f"GeometryCo source-condition resolver has only {len(rows)} verified {family} template examples; at least 3 are required."
        )
    counts = Counter(_row_profile_key(row) for row in rows)
    profile_key, count = counts.most_common(1)[0]
    consensus = count / len(rows)
    if consensus < core.MINIMUM_MAPPING_CONFIDENCE:
        raise core.CompileError(
            f"GeometryCo {family} behavior-profile consensus is {consensus:.1%}; unchanged {core.MINIMUM_MAPPING_CONFIDENCE:.0%} minimum is required."
        )
    candidates = [row for row in rows if _row_profile_key(row) == profile_key]
    candidates.sort(
        key=lambda row: (
            float(row.get("score") or 0.0),
            float(row.get("source_match_score") or 0.0),
            float(row.get("architectural_label_confidence") or 0.0),
        ),
        reverse=True,
    )
    chosen = candidates[0]
    return {
        "old_handle": _clean(chosen.get("old_handle")),
        "old_space": _clean(chosen.get("old_space")),
        "profile": chosen.get("profile") or {},
        "support": len(rows),
        "profileSupport": count,
        "consensus": consensus,
        "referenceNewSpace": _clean(chosen.get("new_space")),
        "referenceScore": float(chosen.get("score") or 0.0),
    }


def _resolve_ambiguous_from_source(
    geometry_path: Path,
    baseline_path: Path,
    proposed_path: Path,
    outdir: Path,
    config: dict,
) -> tuple[dict, dict | None]:
    preflight = core.preflight_pair(geometry_path, baseline_path, proposed_path, config)
    counts = {
        role: int((preflight.get("mapping", {}).get(role, {}) or {}).get("ambiguous_count") or 0)
        for role in ("baseline", "proposed")
    }
    if not any(counts.values()):
        return config, None

    baseline_ambiguous = {
        _clean(row.get("new_handle")): row
        for row in preflight["mapping"]["baseline"].get("ambiguous", [])
        if _clean(row.get("new_handle"))
    }
    proposed_ambiguous = {
        _clean(row.get("new_handle")): row
        for row in preflight["mapping"]["proposed"].get("ambiguous", [])
        if _clean(row.get("new_handle"))
    }
    if set(baseline_ambiguous) != set(proposed_ambiguous):
        raise core.CompileError(
            "GeometryCo Baseline/Proposed ambiguity sets differ; source-condition auto-resolution is intentionally refused."
        )

    geometry = core.parse_osm(geometry_path)
    xml_path, xml_index, tokens_by_handle = _select_source_xml(geometry, outdir)

    references: dict[str, dict[str, dict]] = {"baseline": {}, "proposed": {}}
    for role in ("baseline", "proposed"):
        mapping = preflight["mapping"][role]
        for family in ("occupied_or_accessory", "unconditioned_core"):
            try:
                references[role][family] = _dominant_reference(mapping, family)
            except core.CompileError:
                # A family is only required if an ambiguous source space proves it.
                pass

    resolved = copy.deepcopy(config or {})
    if not any(key in resolved for key in ("global", "baseline", "proposed")):
        resolved = {"global": resolved}
    audit_rows: list[dict] = []

    for handle in sorted(baseline_ambiguous):
        source_row = None
        matched_token = ""
        for token in tokens_by_handle.get(handle, set()):
            if token in xml_index:
                source_row = xml_index[token]
                matched_token = token
                break
        if source_row is None:
            raise core.CompileError(
                f"Ambiguous GeometryCo space {handle} has no exact gbXML Space identity; no automatic mapping was applied."
            )
        family = _condition_family(source_row.get("conditionType"))
        if family is None:
            raise core.CompileError(
                f"Ambiguous GeometryCo space {handle} has no explicit supported gbXML conditionType; no automatic mapping was applied."
            )

        row_audit = {
            "newHandle": handle,
            "newSpace": _clean(baseline_ambiguous[handle].get("new_space")),
            "gbxmlId": source_row.get("id"),
            "gbxmlName": source_row.get("name"),
            "conditionType": source_row.get("conditionType"),
            "conditioningFamily": family,
            "sourceXml": str(xml_path),
            "identityToken": matched_token,
            "roles": {},
        }
        for role in ("baseline", "proposed"):
            reference = references[role].get(family)
            if not reference:
                raise core.CompileError(
                    f"No >=75% consensus {family} behavior profile exists in the approved {role.title()} template."
                )
            role_section = resolved.setdefault(role, {})
            overrides = role_section.setdefault("space_overrides", {})
            overrides[handle] = {
                "match_old": reference["old_handle"],
                "reason": "authoritative_gbxml_conditionType_plus_template_profile_consensus",
            }
            row_audit["roles"][role] = reference
        audit_rows.append(row_audit)

    audit = {
        "schema": "liber.revex.geometryco-source-condition-r91.v1",
        "compilerVersion": core.COMPILER_VERSION,
        "minimumMappingConfidence": core.MINIMUM_MAPPING_CONFIDENCE,
        "allowAmbiguous": False,
        "sourceXml": str(xml_path),
        "preflightAmbiguous": counts,
        "resolvedCount": len(audit_rows),
        "rows": audit_rows,
        "qaStatement": "No threshold was lowered. Each override requires exact gbXML identity, explicit conditionType, and >=75% approved-template profile consensus before unchanged GeometryCo validation reruns.",
    }
    return resolved, audit


def compile_baseline_proposed_pair(
    geometry_path: Path,
    baseline_path: Path,
    proposed_path: Path,
    outdir: Path,
    config: dict | None = None,
    openstudio_cli: str | None = None,
    require_native_check: bool = False,
    progress: Any | None = None,
) -> dict:
    geometry_path = Path(geometry_path)
    baseline_path = Path(baseline_path)
    proposed_path = Path(proposed_path)
    outdir = Path(outdir)
    original_config = copy.deepcopy(config or {})

    # Never accept a caller attempt to weaken the base gate through this wrapper.
    for role in ("global", "baseline", "proposed"):
        section = original_config.get(role) if isinstance(original_config, dict) else None
        if isinstance(section, dict):
            requested = section.get("minimum_mapping_confidence")
            if requested is not None and float(requested) < core.MINIMUM_MAPPING_CONFIDENCE:
                raise core.CompileError("REVEX r91 refuses to lower GeometryCo's 75% minimum mapping confidence.")
            if section.get("allow_ambiguous") is True:
                raise core.CompileError("REVEX r91 refuses allow_ambiguous; all assignments must be proven before compilation.")

    effective_config, audit = _resolve_ambiguous_from_source(
        geometry_path, baseline_path, proposed_path, outdir, original_config
    )
    if audit:
        outdir.mkdir(parents=True, exist_ok=True)
        audit_path = outdir / "GEOMETRYCO_SOURCE_CONDITION_R91.json"
        audit_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"REVEX_GEOMETRYCO_SOURCE_CONDITION_RESOLVED={audit['resolvedCount']}", flush=True)
        print(f"REVEX_GEOMETRYCO_SOURCE_CONDITION_AUDIT={audit_path}", flush=True)

    report = _ORIGINAL_COMPILE_PAIR(
        geometry_path,
        baseline_path,
        proposed_path,
        outdir,
        effective_config,
        openstudio_cli=openstudio_cli,
        require_native_check=require_native_check,
        progress=progress,
    )
    threshold = float(core.MINIMUM_MAPPING_CONFIDENCE)
    for role in ("baseline", "proposed"):
        mapping = (report.get("reports", {}).get(role, {}) or {}).get("space_mapping", {}) or {}
        if int(mapping.get("ambiguous_count") or 0) != 0:
            raise core.CompileError(f"REVEX r91 post-resolution {role} mapping still contains ambiguity.")
        minimum = min((float(row.get("score") or 0.0) for row in mapping.get("rows", [])), default=0.0)
        if minimum < threshold:
            raise core.CompileError(
                f"REVEX r91 post-resolution {role} minimum mapping confidence {minimum:.3f} is below unchanged {threshold:.3f}."
            )
    if audit:
        report["source_condition_resolution_r91"] = audit
    return report


# Make the preserved core's own CLI use the wrapped pair compiler.
core.compile_baseline_proposed_pair = compile_baseline_proposed_pair


def main() -> int:
    return int(core.main())


if __name__ == "__main__":
    raise SystemExit(main())
