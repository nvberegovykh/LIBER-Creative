#!/usr/bin/env python3
"""Production entrypoint that binds cloud routing before importing the worker app.

`app.py` also carries the REVEX application project id for immutable Firestore/storage
identity.  That id must never become the Google Cloud project used by Vertex AI.
Canonical deployment supplies REVEX_VERTEX_PROJECT explicitly; ADC is a defense-in-depth
fallback for any future deployment path that forgets that environment binding.
"""
from __future__ import annotations

import os

from revex_cloud_project import resolve_vertex_project

os.environ["REVEX_VERTEX_PROJECT"] = resolve_vertex_project()
os.environ.setdefault("REVEX_VERTEX_LOCATION", "global")

from app import APP  # noqa: E402  - cloud routing must be bound before app import
from durable_execution import install_durable_energy_execution  # noqa: E402

install_durable_energy_execution(APP)

__all__ = ["APP"]
