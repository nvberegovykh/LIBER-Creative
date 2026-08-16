#!/usr/bin/env python3
"""Resolve the Google Cloud project used by REVEX managed AI services.

REVEX project ids (for example ``revex_<id>``) are application/database identities,
not Google Cloud project ids.  Never use one as a Vertex AI routing fallback.
"""
from __future__ import annotations

import os
import re

_GCP_PROJECT_ID = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")


def _valid(value: object) -> str:
    text = str(value or "").strip()
    return text if _GCP_PROJECT_ID.fullmatch(text) else ""


def resolve_vertex_project(*, required: bool = True) -> str:
    """Return an authoritative GCP project id for Vertex AI.

    Order is explicit REVEX configuration -> standard Google env -> ADC metadata.
    Application-level REVEX project ids are intentionally never accepted as fallback.
    """
    for key in ("REVEX_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"):
        value = _valid(os.environ.get(key))
        if value:
            return value

    try:
        import google.auth
        _credentials, detected = google.auth.default()
        value = _valid(detected)
        if value:
            return value
    except Exception:
        pass

    if required:
        raise RuntimeError(
            "Google Cloud project for REVEX Vertex AI is unavailable. "
            "Set REVEX_VERTEX_PROJECT to the deployment GCP project; a REVEX application project id is not a valid substitute."
        )
    return ""
