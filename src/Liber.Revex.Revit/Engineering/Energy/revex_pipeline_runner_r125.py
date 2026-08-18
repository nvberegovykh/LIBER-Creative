#!/usr/bin/env python3
"""Execute the proven Energy implementation behind the current typed REVEX contract."""
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

    import revex_final_touchups_r125 as touchups
    from revex_energy_contracts import DEFAULT_MISSING_VT, EvidenceBundle

    if abs(float(getattr(touchups, "MISSING_VT", DEFAULT_MISSING_VT)) - DEFAULT_MISSING_VT) > 1e-9:
        raise RuntimeError("REVEX Energy VT policy drifted from the typed contract")

    request_path = _request_from_args(remaining)
    if request_path is not None:
        EvidenceBundle.from_request(request_path).require_sync_evidence()

    try:
        import revex_reference_envelope_projection_r118 as reference_envelope
    except Exception:
        reference_envelope = None

    module = _load(impl)
    touchups.patch_pipeline(module, reference_envelope)

    # The proven implementation's main() parses sys.argv itself.
    sys.argv = [str(impl), *remaining]
    return int(module.main())


if __name__ == "__main__":
    raise SystemExit(main())
