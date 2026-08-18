#!/usr/bin/env python3
"""Execute the pinned r49 Energy implementation with r125 publication touchups in-process."""
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
    try:
        import revex_reference_envelope_projection_r118 as reference_envelope
    except Exception:
        reference_envelope = None

    module = _load(impl)
    r125.patch_pipeline(module, reference_envelope)

    # The pinned implementation's main() parses sys.argv itself.
    sys.argv = [str(impl), *remaining]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
