#!/usr/bin/env python3
"""Verify selected public LIBER/REVEX source assets against liberpict.com.

PR mode may run source-only inventory validation because a PR branch is not the
live GitHub Pages authority. Push-to-main mode waits a bounded amount of time for
the custom domain to converge, cache-busting each read with the source commit.
No credentials are read or printed.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE_ROOT = "https://liberpict.com/"

BASE_PUBLIC_OWNERS = [
    "docs/liber-apps/apps/revex/app.js",
    "docs/liber-apps/apps/revex/store.js",
    "docs/liber-apps/apps/revex/wallt-control-plane.js",
    "docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js",
]

AI_PUBLIC_MANIFEST = ROOT / "docs/ai/public-manifest.json"


def manifest_public_owners() -> list[str]:
    import json
    data = json.loads(AI_PUBLIC_MANIFEST.read_text(encoding="utf-8"))
    if data.get("schema") != "liber.ai.public-manifest.v1":
        raise RuntimeError("Unexpected LIBER/AI public manifest schema.")
    owners: list[str] = []
    for row in data.get("assets", []):
        public_path = str(row.get("publicPath", "")).strip()
        source = str(row.get("source", "")).strip()
        if not public_path.startswith("/"):
            raise RuntimeError(f"Manifest publicPath must start with /: {public_path}")
        if not source.startswith("docs/"):
            raise RuntimeError(f"Manifest source must stay inside docs/: {source}")
        owners.append(source)
    if not owners:
        raise RuntimeError("LIBER/AI public manifest contains no assets.")
    return owners


PUBLIC_OWNERS = list(dict.fromkeys(BASE_PUBLIC_OWNERS + manifest_public_owners()))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def public_url(relative: str, revision: str = "") -> str:
    public_path = relative.removeprefix("docs/")
    url = urllib.parse.urljoin(LIVE_ROOT, public_path)
    if revision:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"rev": revision})
    return url


def fetch(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "LIBER-live-parity/2.0",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status} for {url}")
        return response.read()


def validate_source_inventory() -> list[str]:
    failures: list[str] = []
    seen: set[str] = set()
    print("LIBER public source inventory")
    for relative in PUBLIC_OWNERS:
        if relative in seen:
            failures.append(f"duplicate public owner: {relative}")
            continue
        seen.add(relative)
        path = ROOT / relative
        if not path.is_file():
            failures.append(f"missing source asset: {relative}")
            print(f"MISSING {relative}")
            continue
        print(f"SOURCE {relative} -> {public_url(relative)}")
    return failures


def compare_once(revision: str) -> list[str]:
    failures: list[str] = []
    print("LIBER live public-source parity")
    for relative in PUBLIC_OWNERS:
        local_path = ROOT / relative
        local = local_path.read_bytes()
        url = public_url(relative, revision)
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
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-only", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=0)
    parser.add_argument("--interval-seconds", type=int, default=10)
    args = parser.parse_args()

    failures = validate_source_inventory()
    if failures:
        print("\nLIBER_PUBLIC_SOURCE_INVENTORY=FAILED")
        for failure in failures:
            print("- " + failure)
        return 1

    if args.source_only:
        print("\nLIBER_PUBLIC_SOURCE_INVENTORY=PASSED")
        return 0

    revision = os.environ.get("GITHUB_SHA", "").strip()
    deadline = time.monotonic() + max(0, args.wait_seconds)
    attempt = 0
    while True:
        attempt += 1
        print(f"\nParity attempt {attempt}")
        failures = compare_once(revision)
        if not failures:
            print("\nLIBER_LIVE_PUBLIC_PARITY=PASSED")
            return 0
        if time.monotonic() >= deadline:
            print("\nLIBER_LIVE_PUBLIC_PARITY=FAILED")
            for failure in failures:
                print("- " + failure)
            return 1
        sleep_for = max(1, min(args.interval_seconds, int(max(1, deadline - time.monotonic()))))
        print(f"Live site not converged yet; retrying in {sleep_for}s.")
        time.sleep(sleep_for)


if __name__ == "__main__":
    raise SystemExit(main())
