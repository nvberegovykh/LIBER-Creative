#!/usr/bin/env python3
"""Verify that selected public REVEX runtime owners match the live liberpict.com assets.

This checks only files that are intentionally public web assets. Native Revit/server
engines are open source in the repository but are not expected to be served as web
assets. No credentials are read or printed.
"""
from __future__ import annotations

import hashlib
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE_ROOT = "https://liberpict.com/"

PUBLIC_OWNERS = [
    "docs/liber-apps/apps/revex/app.js",
    "docs/liber-apps/apps/revex/store.js",
    "docs/liber-apps/apps/revex/wallt-control-plane.js",
    "docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js",
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "LIBER-REVEX-live-parity/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status} for {url}")
        return response.read()


def main() -> int:
    failures: list[str] = []
    print("REVEX public runtime parity")
    for relative in PUBLIC_OWNERS:
        local_path = ROOT / relative
        local = local_path.read_bytes()
        public_path = relative.removeprefix("docs/")
        url = LIVE_ROOT + public_path
        try:
            remote = fetch(url)
        except Exception as exc:
            failures.append(f"{relative}: live fetch failed: {exc}")
            print(f"FETCH-FAIL {relative}: {exc}")
            continue

        local_hash = sha256(local)
        remote_hash = sha256(remote)
        if local_hash != remote_hash:
            failures.append(
                f"{relative}: source/live SHA256 mismatch "
                f"source={local_hash} live={remote_hash}"
            )
            print(f"MISMATCH {relative}")
            print(f"  source {local_hash}")
            print(f"  live   {remote_hash}")
        else:
            print(f"MATCH {relative} {local_hash}")

    if failures:
        print("\nREVEX_LIVE_PUBLIC_PARITY=FAILED")
        for failure in failures:
            print("- " + failure)
        return 1

    print("\nREVEX_LIVE_PUBLIC_PARITY=PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
