#!/usr/bin/env python3
"""Canonical managed Energy pipeline facade.

Versioned guards remain preserved as shadows. This file is the only active managed-pipeline
entrypoint and binds the current typed evidence/VT policy to the proven r118/r116 mechanics.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

import revex_energy_pipeline_guard as base
import revex_energy_pipeline_guard_r116 as r116
import revex_energy_pipeline_guard_r118 as shadow

_impl_hint = str(os.environ.get("REVEX_PIPELINE_IMPL") or "").strip()
if _impl_hint:
    _energy_root = Path(_impl_hint).resolve().parent
else:
    packaged = Path("/opt/revex/energy")
    _energy_root = packaged if packaged.is_dir() else Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy"
if str(_energy_root) not in sys.path:
    sys.path.insert(0, str(_energy_root))

import revex_final_touchups as current_touchups

shadow.r125 = current_touchups


def _install_current_full_pipeline_runner() -> None:
    if getattr(r116, "__revex_current_subprocess_patched__", False):
        return
    runner = _energy_root / "revex_pipeline_runner.py"
    if not runner.is_file():
        raise RuntimeError(f"REVEX current full pipeline runner is unavailable: {runner}")
    original_run = shadow._ORIGINAL_R116_SUBPROCESS_RUN

    def run(command, *args, **kwargs):
        try:
            values = list(command)
        except TypeError:
            return original_run(command, *args, **kwargs)
        if len(values) >= 2:
            try:
                target = Path(str(values[1])).resolve()
                pinned = base._pipeline_impl().resolve()
            except Exception:
                target = None
                pinned = None
            if target is not None and pinned is not None and target == pinned:
                values = [values[0], str(runner), "--impl", str(pinned), *values[2:]]
                print(json.dumps({
                    "stage": "FULL_PIPELINE_CURRENT",
                    "status": "CANONICAL_RUNNER",
                    "runner": str(runner),
                    "impl": str(pinned),
                }, ensure_ascii=True), flush=True)
                return original_run(values, *args, **kwargs)
        return original_run(command, *args, **kwargs)

    r116.subprocess.run = run
    r116.__revex_current_subprocess_patched__ = True


# Replace only the version-shadow dispatch point; all proven guard semantics remain intact.
shadow._install_full_pipeline_runner = _install_current_full_pipeline_runner


def main(argv=None) -> int:
    return int(shadow.main(argv))


if __name__ == "__main__":
    raise SystemExit(main())
