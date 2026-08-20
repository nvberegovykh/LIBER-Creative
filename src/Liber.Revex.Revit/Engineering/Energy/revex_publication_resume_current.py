#!/usr/bin/env python3
"""Current REVEX publication-resume policy.

The r124 resume engine is retained as the proven implementation. This overlay changes
only the reuse boundary: already-completed geometry/simulation artifacts belong to the
immutable Engineering revision, not to whichever later worker commit performs a
COMcheck/VT/EN-1 publication touch-up.

Reuse remains fail-closed:
- exact project + immutable Engineering revision + pipeline version must match;
- the prior simulation comparison must be review-eligible and non-regressive;
- all five upstream artifacts must have declared path/size/SHA-256 metadata;
- r124 then downloads every artifact and byte-verifies size + SHA-256 before use;
- if the newest result failed after an older useful result, durable source-bound worker
  responses are searched for the last reusable manifest;
- any missing/mismatched artifact returns to the normal full pipeline.

This lets downstream-only fixes (VT, EN schedule orientation, COMcheck/EN-1 publication)
resume above a proven geometry/simulation layer instead of needlessly rerunning GeometryCo.
"""
from __future__ import annotations

import json
from typing import Any

import revex_publication_resume_r124 as _r124
import revex_energy_pipeline_guard_r118 as _r118
import revex_final_touchups as _current_touchups
import revex_en1_amendment as _en1_amendment

VERSION = "20260818-current-publication-resume3"
_ORIGINAL_JSON_BLOB = _r124._json_blob
_ORIGINAL_PIPELINE = _r124._pipeline


def _text(value: Any) -> str:
    return str(value or "").strip()


def _has_reuse_rows(manifest: dict) -> bool:
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


def _stage_reusable_shape(manifest: dict) -> bool:
    if not isinstance(manifest, dict):
        return False
    if manifest.get("schema") != "liber.revex.energy-result.v1":
        return False
    if _text(manifest.get("pipelineVersion")) != "0.8.19-r49":
        return False
    comparison = dict(manifest.get("approvedRunComparison") or {})
    if comparison.get("reviewEligible") is not True:
        return False
    if _text(comparison.get("status")).upper() == "REGRESSION":
        return False
    return _has_reuse_rows(manifest)


def _prior_is_reusable(manifest: dict, project_id: str, revision: str, current_source: str) -> bool:
    if not _stage_reusable_shape(manifest):
        return False
    if _text(manifest.get("projectId")) != _text(project_id):
        return False
    if _text(manifest.get("sourceEngineeringRevision")) != _text(revision):
        return False
    # SourceCandidate remains recorded provenance, but is not the identity of already-
    # produced stage bytes. The immutable revision + verified artifact hashes own reuse.
    return True


def _historical_reusable_manifest(bucket, path: str, direct: dict | None) -> dict | None:
    """Recover a useful prior stage manifest even if a later retry overwrote energy-result.json."""
    candidates: list[dict] = []
    if isinstance(direct, dict):
        candidates.append(direct)
    if not path.endswith("/energy-result.json"):
        return direct

    prefix = path.rsplit("/", 1)[0]
    try:
        blobs = bucket.list_blobs(prefix=f"{prefix}/worker-response.")
        for blob in blobs:
            name = _text(getattr(blob, "name", ""))
            if not name.endswith(".json"):
                continue
            try:
                body = json.loads(blob.download_as_text(encoding="utf-8"))
            except Exception:
                continue
            manifest = body.get("manifest") if isinstance(body, dict) else None
            if isinstance(manifest, dict):
                candidates.append(manifest)
    except Exception:
        pass

    reusable = [manifest for manifest in candidates if _stage_reusable_shape(manifest)]
    if not reusable:
        return direct

    # Prefer a COMPLETE prior result; otherwise any review-eligible simulation result is
    # sufficient because r124 rehashes the five actual stored artifacts before reuse.
    reusable.sort(
        key=lambda manifest: (
            _text(manifest.get("status")).upper() == "COMPLETE",
            _text(manifest.get("sourceCandidate")),
        ),
        reverse=True,
    )
    chosen = reusable[0]
    if chosen is not direct:
        print(json.dumps({
            "stage": "PUBLICATION_RESUME_HISTORY_CURRENT",
            "status": "RECOVERED_PRIOR_STAGE_MANIFEST",
            "sourceEngineeringRevision": chosen.get("sourceEngineeringRevision"),
            "priorSourceCandidate": chosen.get("sourceCandidate"),
            "currentResultWasReusable": _stage_reusable_shape(direct or {}),
            "reuseNames": list(_r124.REUSE_NAMES),
        }, ensure_ascii=True), flush=True)
    return chosen


def _json_blob(bucket, path: str):
    direct = _ORIGINAL_JSON_BLOB(bucket, path)
    return _historical_reusable_manifest(bucket, path, direct)


def _pipeline():
    """Load the proven implementation, then apply only the canonical current publication policy."""
    module = _ORIGINAL_PIPELINE()
    _current_touchups.patch_pipeline(module)
    return module


def install_publication_resume(app) -> None:
    # r118 owns the proven evidence/reference merge seam. Bind only its final derived-page
    # touchup delegate to current policy so resumed publication preserves actual VT, uses
    # exactly 0.45 only when VT is absent, and consumes current EN schedule-section orientation.
    _r118.r125 = _current_touchups

    # Keep r124's proven restore/package implementation. Replace only the admission/history
    # seam and the post-restore publication policy; GeometryCo and EnergyPlus are untouched.
    _r124._json_blob = _json_blob
    _r124._prior_is_reusable = _prior_is_reusable
    _r124._pipeline = _pipeline
    _r124.install_publication_resume(app)
    # Install after r124 so publication-only EN-1 amendments are intercepted before
    # the general resume/full-pipeline owner. Normal requests delegate unchanged.
    _en1_amendment.install(app)


# Expose the proven surface for existing imports/tests.
REUSE_NAMES = _r124.REUSE_NAMES
PUBLIC_NAMES = _r124.PUBLIC_NAMES
RELEASE_PACKAGE = _r124.RELEASE_PACKAGE
