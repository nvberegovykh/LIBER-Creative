#!/usr/bin/env python3
"""r116 correction for current-project COMcheck evidence recovery.

The native structured Revit schedule graph is authoritative when it resolves a fact.
This module only corrects the bounded PDF fallback so it uses the actual/provided
building height above grade plane and never confuses it with a zoning maximum.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

import revex_comcheck_evidence as base

VERSION = "20260817r116-comcheck-evidence2"
HEIGHT_ROW = re.compile(r"\bbuilding\s+(?:height|hight)\s+above\s+grade\s+plane\b", re.I)


def _provided_height_above_grade_plane(text: str) -> float | None:
    """Return only the actual/provided value from the code-analysis row.

    Typical visible row semantics are:
        Building Hight above grade plane | 85' | 65'
    where the first value is a permitted/maximum zoning/code value and the second
    value is the provided/proposed building. Energy/COMcheck needs 65 ft.

    The fallback intentionally does not recognize MAX BUILDING HEIGHT: that phrase
    denotes a zoning limit and is not evidence of the building's actual height.
    """
    raw = str(text or "")
    candidates: list[float] = []

    # Preserve line/table extraction when PDF text keeps the schedule row together.
    lines = [line for line in raw.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        if not HEIGHT_ROW.search(base._flat(line)):
            continue
        window = " ".join(lines[index:index + 3])
        values = base._feet_tokens(window)
        if values:
            candidates.append(values[-1])

    # PDF extractors sometimes flatten merged Revit schedule cells into one stream.
    source = base._flat(raw)
    for match in HEIGHT_ROW.finditer(source):
        window = source[match.start():match.start() + 220]
        # Stop before a clearly different row/section when possible.
        boundary = re.search(r"\b(?:TABLE\s+\d|NUMBER\s+OF\s+STOR|BASE\s+HEIGHT|OCCUPANCY|FLOOR\s+AREA)\b", window[1:], re.I)
        if boundary:
            window = window[:boundary.start() + 1]
        values = base._feet_tokens(window)
        if values:
            candidates.append(values[-1])

    if not candidates:
        return None
    # More than one independently visible row is acceptable only when it agrees.
    rounded = {round(float(value), 3) for value in candidates}
    return float(next(iter(rounded))) if len(rounded) == 1 else None


def resolve_request(
    request_path: Path,
    output_root: Path,
    *,
    envelope_agent: Callable[[list[dict]], dict] | None = None,
    pdf_text_loader: Callable[[Path], str] | None = None,
) -> Path:
    # Patch only the obsolete fallback primitive. All other r100 evidence rules,
    # provenance checks, 0.90 confidence floor, and immutable-source behavior remain.
    original_height = base._extract_height
    original_version = base.VERSION
    try:
        base._extract_height = _provided_height_above_grade_plane
        base.VERSION = VERSION
        return base.resolve_request(
            request_path,
            output_root,
            envelope_agent=envelope_agent,
            pdf_text_loader=pdf_text_loader,
        )
    finally:
        base._extract_height = original_height
        base.VERSION = original_version


# Expose the corrected primitive for regression tests.
extract_provided_building_height = _provided_height_above_grade_plane
