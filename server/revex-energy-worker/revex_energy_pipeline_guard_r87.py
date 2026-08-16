#!/usr/bin/env python3
"""REVEX r87 identity-resolution shim for the preserved r49 Energy guard.

The worker already carries verified active-Revit identity JSON and immutable T/Z PDFs.
r87 strengthens only the locality extraction seam: city/state/ZIP may be read from text
within a bounded window immediately following the authoritative project street. This
covers multiline/titleblock PDF extraction without accepting unrelated consultant
addresses elsewhere on the sheet. The preserved r49 pipeline, failure guard and all
other Energy behavior remain unchanged.
"""
from __future__ import annotations

import re
from pathlib import Path

try:
    import revex_energy_pipeline_guard_base as base_guard
except ImportError:  # source-tree QA; Docker installs the preserved guard under *_base
    import revex_energy_pipeline_guard as base_guard
import revex_energy_pipeline_r69 as identity

BUILD = "20260816r87"


def _flat(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def location_near_authoritative_address(text: str, authoritative_address: str) -> dict[str, str]:
    """Return locality only when it follows the authoritative street in the same bounded text window."""
    flat = _flat(text)
    address = _flat(authoritative_address)
    if not flat or not address:
        return {}

    tokens = re.findall(r"[A-Za-z0-9]+", address)
    if not tokens:
        return {}

    # Require the authoritative address tokens in order, but tolerate titleblock labels,
    # punctuation and PDF extraction gaps between them. The locality must occur very
    # shortly after that matched project street, so an architect/engineer address elsewhere
    # on the same sheet cannot win.
    address_pattern = r"\b" + r"\b.{0,48}?\b".join(re.escape(token) for token in tokens) + r"\b"
    location_pattern = re.compile(
        r"([A-Za-z][A-Za-z .'-]{1,60}?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b",
        re.I,
    )
    for match in re.finditer(address_pattern, flat, re.I):
        window = flat[match.end():match.end() + 220]
        locality = location_pattern.search(window)
        if not locality:
            continue
        city = re.sub(
            r"^(?:PROJECT|SITE|PROPERTY|BUILDING|ADDRESS|LOCATION)\s+",
            "",
            locality.group(1).strip(),
            flags=re.I,
        ).strip(" ,-:")
        if not city:
            continue
        return {"city": city, "state": locality.group(2).upper(), "zip": locality.group(3)}
    return {}


def _location_from_revit_pdfs_r87(request: dict, authoritative_address: str):
    try:
        from pypdf import PdfReader
    except Exception:
        return {}, ""

    for value in list(request.get("sourceArtifacts") or []):
        path = Path(str(value or "").strip())
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        try:
            text = "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
        except Exception:
            continue
        parsed = location_near_authoritative_address(text, authoritative_address)
        if parsed:
            return parsed, f"immutable Revit sheet PDF {path.name} · r87 bounded project-address window"
    return {}, ""


def _install() -> None:
    identity._location_from_revit_pdfs = _location_from_revit_pdfs_r87


def main(argv=None) -> int:
    _install()
    return int(base_guard.main(argv) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
