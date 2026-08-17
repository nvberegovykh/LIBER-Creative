#!/usr/bin/env python3
"""Production entrypoint that binds cloud routing before importing the worker app.

`app.py` also carries the REVEX application project id for immutable Firestore/storage
identity. That id must never become the Google Cloud project used by Vertex AI.
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

from app import APP  # noqa: E402 - cloud routing must be bound before app import

# r124/r125 live beside the pinned Energy implementation so Docker receives them through
# the existing authoritative Energy COPY. Source-checkout fallback keeps local QA identical.
packaged_energy = Path("/opt/revex/energy")
source_energy = Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
energy_module_root = packaged_energy if packaged_energy.is_dir() else source_energy
if str(energy_module_root) not in sys.path:
    sys.path.insert(0, str(energy_module_root))

from revex_final_touchups_r125 import install_worker_touchups  # noqa: E402
from revex_publication_resume_r124 import install_publication_resume  # noqa: E402
from durable_execution import install_durable_energy_execution  # noqa: E402

# Install r125 first so the resumable r124 publication path uses the same native-total,
# VT and EN-1 finalization rules as a normal full Energy execution. Resume/finalization
# remains inside the durable lease wrapper, so the durable owner sees a resumed COMPLETE
# response exactly like a normal full-pipeline completion.
install_worker_touchups()
install_publication_resume(APP)
install_durable_energy_execution(APP)

__all__ = ["APP"]
