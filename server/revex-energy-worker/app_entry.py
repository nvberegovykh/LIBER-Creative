#!/usr/bin/env python3
"""Production entrypoint that binds cloud routing before importing the worker app."""
from __future__ import annotations

import os
from pathlib import Path
import sys

from revex_cloud_project import resolve_vertex_project

os.environ["REVEX_VERTEX_PROJECT"] = resolve_vertex_project()
os.environ.setdefault("REVEX_VERTEX_LOCATION", "global")

from app import APP  # noqa: E402 - cloud routing must be bound before app import

packaged_energy = Path("/opt/revex/energy")
source_energy = Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
energy_module_root = packaged_energy if packaged_energy.is_dir() else source_energy
if str(energy_module_root) not in sys.path:
    sys.path.insert(0, str(energy_module_root))

# Current runtime imports canonical overlays. Versioned r124/r125 files remain preserved
# as proven shadow implementations behind these narrow current policies.
from revex_final_touchups import install_worker_touchups  # noqa: E402
from revex_publication_resume_current import install_publication_resume  # noqa: E402
from durable_execution import install_durable_energy_execution  # noqa: E402

install_worker_touchups()
install_publication_resume(APP)
install_durable_energy_execution(APP)

__all__ = ["APP"]
