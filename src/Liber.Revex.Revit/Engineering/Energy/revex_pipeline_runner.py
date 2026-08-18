#!/usr/bin/env python3
"""Current REVEX Energy runner.

The proven engine remains version-shadowed; this canonical runner owns current contracts.
WALLT Energy Maintainer is an observer/repair overlay inserted between proven blocks; it
never becomes a second Energy engine and never mutates immutable Revit evidence in place.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import sys


def _load(path: Path):
    parent = str(path.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("revex_current_energy_impl", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load proven Energy implementation: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _request_from_args(values: list[str]) -> Path | None:
    for index, value in enumerate(values):
        if value == "--request" and index + 1 < len(values):
            return Path(values[index + 1]).resolve()
    return None


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--impl", type=Path, required=True)
    known, remaining = parser.parse_known_args()
    impl = known.impl.resolve()

    server_hint = str(os.environ.get("REVEX_PIPELINE") or "").strip()
    if server_hint:
        server_root = Path(server_hint).resolve().parent
        if str(server_root) not in sys.path:
            sys.path.insert(0, str(server_root))

    import revex_final_touchups as touchups
    import revex_energy_maintainer as maintainer
    from revex_energy_contracts import DEFAULT_MISSING_VT, EvidenceBundle

    if abs(float(touchups.MISSING_VT) - DEFAULT_MISSING_VT) > 1e-9:
        raise RuntimeError("REVEX Energy VT policy drifted from the typed current contract")

    request_path = _request_from_args(remaining)
    if request_path is not None:
        EvidenceBundle.from_request(request_path).require_sync_evidence()
    maintainer.bind_request(request_path)

    module = _load(impl)
    touchups.patch_pipeline(module)
    maintainer.install(module)

    # The proven implementation's main() parses sys.argv itself.
    sys.argv = [str(impl), *remaining]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
