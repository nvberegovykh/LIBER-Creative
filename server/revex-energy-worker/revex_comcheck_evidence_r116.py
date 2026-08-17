#!/usr/bin/env python3
"""r116 correction for current-project COMcheck evidence recovery.

The native structured Revit schedule graph is authoritative when it resolves a fact.
This module only corrects the bounded PDF fallback so it uses the actual/provided
building height above grade plane and never confuses it with a zoning maximum.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

import revex_comcheck_evidence as base

VERSION = "20260817r116-comcheck-evidence3"
HEIGHT_ROW = re.compile(r"\bbuilding\s+(?:height|hight)\s+above\s+grade\s+plane\b", re.I)
SECTION_BOUNDARY = re.compile(
    r"\b(?:TABLE\s+\d|NUMBER\s+OF\s+STOR|BASE\s+HEIGHT|OCCUPANCY|FLOOR\s+AREA)\b",
    re.I,
)


def _last_height_value(window: str) -> float | None:
    values = base._feet_tokens(window)
    return float(values[-1]) if values else None


def _unambiguous(values: list[float]) -> float | None:
    if not values:
        return None
    rounded = {round(float(value), 3) for value in values}
    return float(next(iter(rounded))) if len(rounded) == 1 else None


def _provided_height_above_grade_plane(text: str) -> float | None:
    """Return only an unambiguous PROVIDED/PROPOSED height above grade plane.

    Visible code-analysis semantics:
        Building Hight above grade plane | 85' | 65'
    The first value is allowable/required; the final value is the project's
    provided/proposed building height. Therefore the example resolves to 65 ft.

    Intact extracted rows are authoritative for this fallback. Flattened-window
    parsing is used only when the PDF extractor did not preserve usable rows. This
    prevents a second matching row from contaminating the first and guarantees that
    conflicting current rows fail closed instead of silently selecting one.
    """
    raw = str(text or "")
    lines = [line for line in raw.splitlines() if line.strip()]
    row_candidates: list[float] = []

    for index, line in enumerate(lines):
        flattened = base._flat(line)
        if not HEIGHT_ROW.search(flattened):
            continue
        value = _last_height_value(flattened)
        if value is None:
            continuation: list[str] = [line]
            for following in lines[index + 1:index + 3]:
                flat_following = base._flat(following)
                if HEIGHT_ROW.search(flat_following) or SECTION_BOUNDARY.search(flat_following):
                    break
                continuation.append(following)
            value = _last_height_value(" ".join(continuation))
        if value is not None:
            row_candidates.append(value)

    # When intact matching rows were recovered, resolve only those rows. Two rows
    # that say 65 and 67 are a real current-evidence conflict and must return None.
    if row_candidates:
        return _unambiguous(row_candidates)

    # Fallback for PDF text where Revit table cells were flattened into one stream.
    source = base._flat(raw)
    matches = list(HEIGHT_ROW.finditer(source))
    flat_candidates: list[float] = []
    for index, match in enumerate(matches):
        stop = min(len(source), match.start() + 220)
        if index + 1 < len(matches):
            stop = min(stop, matches[index + 1].start())
        window = source[match.start():stop]
        boundary = SECTION_BOUNDARY.search(window[1:])
        if boundary:
            window = window[:boundary.start() + 1]
        value = _last_height_value(window)
        if value is not None:
            flat_candidates.append(value)
    return _unambiguous(flat_candidates)


def resolve_request(
    request_path: Path,
    output_root: Path,
    *,
    envelope_agent: Callable[[list[dict]], dict] | None = None,
    pdf_text_loader: Callable[[Path], str] | None = None,
) -> Path:
    # Patch only the bounded PDF fallback primitive. Native structured schedules,
    # provenance checks, the 0.90 filing-confidence floor, and immutable source
    # evidence remain owned by the existing r100/r101 chain.
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


extract_provided_building_height = _provided_height_above_grade_plane
