#!/usr/bin/env python3
"""REVEX r118 managed-Energy guard.

Preserves the complete r116 durability/preflight execution contract and inserts one
narrow downstream step before the existing COMcheck preflight: current-project EN
geometry rows that lack thermal properties may inherit performance from the approved
79 Winthrop proposed envelope reference when current EN thermal facts corroborate the
same envelope signature.

No Revit, gbXML, GeometryCo, simulation, project identity or current geometry authority
is changed by this guard.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable

import revex_energy_pipeline_guard as base
import revex_energy_pipeline_guard_r116 as r116
import revex_reference_envelope_projection_r118 as reference_envelope

_ORIGINAL_R116_EVIDENCE_RESOLVER = r116._resolve_comcheck_evidence_request


def _resolve_comcheck_evidence_then_reference(request_path: Path, output_root: Path) -> Path:
    current = _ORIGINAL_R116_EVIDENCE_RESOLVER(request_path, output_root)
    return reference_envelope.resolve_request(current, output_root)


def main(argv: Iterable[str] | None = None) -> int:
    # r116 looks this function up from its module globals at execution time. Replace only
    # that one downstream seam; every other r116 operation stays byte-for-byte intact.
    r116._resolve_comcheck_evidence_request = _resolve_comcheck_evidence_then_reference
    r116.PREFLIGHT_NAME = "COMCHECK_PREFLIGHT_R118.json"
    base.EXACT_NAMES.update({
        "REFERENCE_ENVELOPE_PROJECTION_R118.json",
        "00_PAGE_FACTS_REFERENCE_ENVELOPE_R118.json",
        "00_PIPELINE_REQUEST_REFERENCE_ENVELOPE_R118.json",
        "COMCHECK_PREFLIGHT_R118.json",
    })
    return r116.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
