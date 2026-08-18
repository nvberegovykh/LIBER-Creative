#!/usr/bin/env python3
"""Current REVEX publication-resume policy.

The r124 resume engine is retained as the proven implementation. This overlay changes
only its reuse gate: already-completed geometry/simulation artifacts belong to the
immutable Engineering revision, not to whichever later worker commit performs a
COMcheck/VT/EN-1 publication touch-up.

Reuse remains fail-closed:
- exact project + immutable Engineering revision + pipeline version must match;
- the prior simulation comparison must be review-eligible and non-regressive;
- all five upstream artifacts must have declared path/size/SHA-256 metadata;
- r124 then downloads every artifact and byte-verifies size + SHA-256 before use;
- any missing/mismatched artifact returns to the normal full pipeline.

This lets downstream-only fixes (VT, EN schedule orientation, COMcheck/EN-1 publication)
resume above a proven geometry/simulation layer instead of needlessly rerunning GeometryCo.
"""
from __future__ import annotations

from typing import Any

import revex_publication_resume_r124 as _r124

VERSION = "20260818-current-publication-resume1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _prior_is_reusable(manifest: dict, project_id: str, revision: str, current_source: str) -> bool:
    if manifest.get("schema") != "liber.revex.energy-result.v1":
        return False
    if _text(manifest.get("pipelineVersion")) != "0.8.19-r49":
        return False
    if _text(manifest.get("projectId")) != _text(project_id):
        return False
    if _text(manifest.get("sourceEngineeringRevision")) != _text(revision):
        return False

    comparison = dict(manifest.get("approvedRunComparison") or {})
    if comparison.get("reviewEligible") is not True:
        return False
    if _text(comparison.get("status")).upper() == "REGRESSION":
        return False

    # SourceCandidate is provenance, not the identity of already-produced stage bytes.
    # The exact immutable revision + per-artifact hashes below are the reuse authority.
    for review_name in _r124.REUSE_NAMES:
        row = _r124._prior_row(manifest, review_name)
        if row is None:
            return False
        if not _text(row.get("path")) or not _text(row.get("sha256")):
            return False
        try:
            if int(row.get("bytes") or 0) <= 0:
                return False
        except (TypeError, ValueError):
            return False
    return True


def install_publication_resume(app) -> None:
    _r124._prior_is_reusable = _prior_is_reusable
    _r124.install_publication_resume(app)


# Expose the proven surface for existing imports/tests.
REUSE_NAMES = _r124.REUSE_NAMES
PUBLIC_NAMES = _r124.PUBLIC_NAMES
RELEASE_PACKAGE = _r124.RELEASE_PACKAGE
