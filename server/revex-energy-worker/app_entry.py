#!/usr/bin/env python3
"""Production entrypoint that binds cloud routing before importing the worker app.

`app.py` also carries the REVEX application project id for immutable Firestore/storage
identity.  That id must never become the Google Cloud project used by Vertex AI.
Canonical deployment supplies REVEX_VERTEX_PROJECT explicitly; ADC is a defense-in-depth
fallback for any future deployment path that forgets that environment binding.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys

from revex_cloud_project import resolve_vertex_project

os.environ["REVEX_VERTEX_PROJECT"] = resolve_vertex_project()
os.environ.setdefault("REVEX_VERTEX_LOCATION", "global")

from app import APP  # noqa: E402  - cloud routing must be bound before app import

# r124 lives beside the pinned Energy implementation so Docker receives it through the
# existing authoritative Energy COPY.  Source-checkout fallback keeps local QA identical.
packaged_energy = Path("/opt/revex/energy")
source_energy = Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
energy_module_root = packaged_energy if packaged_energy.is_dir() else source_energy
if str(energy_module_root) not in sys.path:
    sys.path.insert(0, str(energy_module_root))

from revex_publication_resume_r124 import install_publication_resume  # noqa: E402
from durable_execution import install_durable_energy_execution  # noqa: E402

# Resume/finalization must be inside the durable lease wrapper: the durable owner sees
# the resumed COMPLETE response exactly like a normal full-pipeline completion.
install_publication_resume(APP)
install_durable_energy_execution(APP)

__all__ = ["APP"]
