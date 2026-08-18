#!/usr/bin/env python3
"""Execute the pinned r49 Energy implementation with r125 publication touchups in-process."""
from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import sys


FIXED_MISSING_VT = 0.45


def _load(path: Path):
    parent = str(path.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    spec = importlib.util.spec_from_file_location("revex_r125_full_impl", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load pinned Energy implementation: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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

    import revex_final_touchups_r125 as r125

    # Missing VT is deliberately deterministic for the filing path. Preserve any VT
    # already present in current evidence; only an absent value falls back to 0.45.
    r125.VT_CLEAR_FALLBACK = FIXED_MISSING_VT
    r125.VT_TINTED_FALLBACK = FIXED_MISSING_VT

    module = _load(impl)
    # Thermal same-envelope projection is completed by the r118 guard before this runner.
    # Passing no reference here prevents VT from being silently replaced by another value.
    r125.patch_pipeline(module, None)

    # The pinned implementation's main() parses sys.argv itself.
    sys.argv = [str(impl), *remaining]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
