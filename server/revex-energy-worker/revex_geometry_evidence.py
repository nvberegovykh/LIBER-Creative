#!/usr/bin/env python3
"""Dependency-free validator for immutable processed Revit energy geometry."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable


def validate_geometry_evidence(
    manifest: dict,
    geometry: Path,
    gbxml: Path,
    sha256: Callable[[Path], str],
) -> dict:
    metadata = dict(manifest.get("geometryEvidence") or {})
    facts = json.loads(Path(geometry).read_text(encoding="utf-8"))
    if (facts.get("schema") != "liber.revex.revit-energy-geometry.v1"
            or facts.get("authority") != "active-revit-document-processed-energy-geometry"):
        raise ValueError("processed Revit energy geometry has an incompatible schema or authority")
    if str(metadata.get("sha256") or "").lower() != sha256(Path(geometry)).lower():
        raise ValueError("geometryEvidence metadata/hash does not match the immutable geometry artifact")
    if str((facts.get("gbxml") or {}).get("sha256") or "").lower() != sha256(Path(gbxml)).lower():
        raise ValueError("processed Revit energy geometry is bound to different gbXML bytes")
    binding_fingerprint = str((manifest.get("projectBinding") or {}).get("documentFingerprint") or "")
    if str(metadata.get("documentFingerprint") or "") != binding_fingerprint:
        raise ValueError("processed Revit energy geometry is bound to a different Revit document fingerprint")
    source_document = dict(facts.get("sourceDocument") or {})
    if str(source_document.get("documentFingerprint") or "") != binding_fingerprint:
        raise ValueError("processed Revit energy geometry source document fingerprint mismatch")
    try:
        phase_id = int(source_document.get("phaseId"))
    except (TypeError, ValueError) as exc:
        raise ValueError("processed Revit energy geometry has no valid phase id") from exc
    if phase_id < 0 or not str(source_document.get("phaseName") or "").strip():
        raise ValueError("processed Revit energy geometry has no valid phase binding")
    if (source_document.get("coordinateSystem") != "REVIT_HOST_INTERNAL"
            or source_document.get("linearUnit") != "foot"
            or source_document.get("areaUnit") != "square-foot"):
        raise ValueError("processed Revit energy geometry has an unsupported coordinate/unit contract")
    spaces = list(facts.get("spaces") or [])
    if not spaces:
        raise ValueError("processed Revit energy geometry has no recorded Spaces")
    allowed_provenance = {"PREEXISTING_UNTOUCHED", "REVEX_CREATED"}
    if any(str(row.get("provenance") or "") not in allowed_provenance for row in spaces):
        raise ValueError("processed Revit energy geometry contains unknown Space provenance")
    processed = list(facts.get("processedSpaces") or [])
    processed_ids: set[str] = set()
    repaired_original_ids: set[int] = set()
    for row in processed:
        processed_id = str(row.get("id") or "").strip()
        if not processed_id or processed_id in processed_ids:
            raise ValueError("Room-derived processed geometry has a missing or duplicate id")
        processed_ids.add(processed_id)
        if row.get("provenance") != "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE":
            raise ValueError("Room-derived processed geometry has unknown provenance")
        if (row.get("coordinateSystem") != "REVIT_HOST_INTERNAL"
                or row.get("geometryMode") != "ROOM_BOUNDARY_STORY_BOUNDED_2_5D"):
            raise ValueError("Room-derived processed geometry has an unsupported coordinate/mode contract")
        try:
            invalid_original_id = int(row.get("invalidOriginalSpaceId"))
            height = float(row.get("heightFt"))
            area = float(row.get("areaFt2"))
            volume = float(row.get("volumeFt3"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Room-derived processed geometry has invalid numeric evidence") from exc
        if invalid_original_id < 0 or height <= 0.25 or height > (20.0 / 0.3048):
            raise ValueError("Room-derived processed geometry has an invalid or story-tower height")
        if area <= 0.0 or volume <= 0.0 or len(list(row.get("outerLoopFt") or [])) < 3:
            raise ValueError("Room-derived processed geometry has empty boundary/area/volume evidence")
        repaired_original_ids.add(invalid_original_id)
    excluded_original_ids = {
        int(row.get("id")) for row in spaces
        if row.get("provenance") == "PREEXISTING_UNTOUCHED"
        and row.get("exportable") is False
        and str(row.get("id") or "").lstrip("-").isdigit()
    }
    if not excluded_original_ids.issubset(repaired_original_ids):
        raise ValueError("an excluded invalid original Space has no bounded Room-derived processed representation")
    if not any(row.get("exportable") is True for row in spaces) and not processed:
        raise ValueError("processed Revit energy geometry has no exportable native or Room-derived Space")
    return facts
