#!/usr/bin/env python3
"""REVEX managed-Energy current-project identity resolver.

This is the single pre-pipeline identity-normalization owner.  It consumes only the
immutable active-Revit evidence graph/page facts carried by the published Engineering
revision.  Project-specific strings are test fixtures, never implementation branches.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import revex_energy_identity_normalizer as identity_normalizer

CENSUS_ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
CENSUS_BENCHMARK = "Public_AR_Current"
REQUIRED_LOCATION = identity_normalizer.REQUIRED_LOCATION


def _text(value) -> str:
    return identity_normalizer.text(value)


def _first(*values) -> str:
    return next((_text(value) for value in values if _text(value)), "")


def _split_address_location(value: str) -> dict[str, str]:
    parsed = identity_normalizer.parse_locality(value)
    return {key: parsed[key] for key in REQUIRED_LOCATION if parsed.get(key)}


def _verified_raw_revit_identity(request: dict) -> tuple[dict, dict]:
    """Load the exact raw active-Revit identity artifact and recheck its binding digest."""
    manifest_path = Path(_text(request.get("engineeringManifestPath")))
    if not manifest_path.is_file():
        return {}, {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}, {}
    expected = _text((manifest.get("projectBinding") or {}).get("identityEvidenceDigest")).lower()
    for value in list(request.get("sourceArtifacts") or []):
        path = Path(_text(value))
        if not path.is_file() or path.name.lower() != "revit-project-identity.json":
            continue
        try:
            identity = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        digest = _text(identity.get("digest") or identity.get("Digest")).lower()
        if identity.get("schema") != "liber.revex.revit-project-identity.v1":
            continue
        if identity.get("authority") != "active-revit-document-t-z-title-evidence":
            continue
        if not digest or not expected or digest != expected:
            continue
        return identity, dict(identity.get("fields") or identity.get("Fields") or {})
    return {}, {}


def _pdf_paths(request: dict) -> list[Path]:
    paths = []
    for value in list(request.get("sourceArtifacts") or []):
        path = Path(_text(value))
        if path.is_file() and path.suffix.lower() == ".pdf":
            paths.append(path)
    return paths


def _census_lookup(identity: dict) -> dict[str, str]:
    """Last-resort US locality derivation from an already-authoritative project street."""
    address = _first(identity.get("address"), identity.get("title"))
    if not address:
        return {}
    locality_hint = _first(identity.get("city"), identity.get("borough"))
    state_hint = _text(identity.get("state"))
    query_address = ", ".join(part for part in (address, locality_hint, state_hint) if part)
    params = urlencode({"address": query_address, "benchmark": CENSUS_BENCHMARK, "format": "json"})
    request = Request(f"{CENSUS_ENDPOINT}?{params}", headers={"User-Agent": "LIBER-REVEX/0.8.19 identity-normalizer"})
    with urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))
    matches = (((payload or {}).get("result") or {}).get("addressMatches") or [])
    if not matches:
        return {}
    match = matches[0]
    components = dict(match.get("addressComponents") or {})
    matched_address = _text(match.get("matchedAddress"))

    source_tokens = identity_normalizer.address_tokens(address)
    expected_number = next((token for token in source_tokens if token.isdigit()), "")
    expected_words = [token for token in source_tokens if not token.isdigit() and len(token) >= 3]
    actual_number = _text(components.get("fromAddress"))
    actual_street = " ".join(
        part for part in (
            _text(components.get("preQualifier")), _text(components.get("preDirection")),
            _text(components.get("preType")), _text(components.get("streetName")),
            _text(components.get("suffixType")), _text(components.get("suffixDirection")),
            _text(components.get("suffixQualifier")),
        ) if part
    ).strip()
    target = (actual_street + " " + matched_address).lower()
    if expected_number and actual_number and expected_number.lstrip("0") != actual_number.lstrip("0"):
        return {}
    if expected_words and not any(word in target for word in expected_words):
        return {}

    city_value = _first(components.get("city"), components.get("cityName"), components.get("placeName"))
    state_value = _first(components.get("state"), components.get("stateName"))
    zip_value = _first(components.get("zip"), components.get("zipCode"))
    if not city_value or not state_value or not re.fullmatch(r"\d{5}(?:-\d{4})?", zip_value):
        suffix = _split_address_location(matched_address)
        city_value = city_value or suffix.get("city", "")
        state_value = state_value or suffix.get("state", "")
        zip_value = zip_value or suffix.get("zip", "")
    if not city_value or not state_value or not re.fullmatch(r"\d{5}(?:-\d{4})?", zip_value):
        return {}
    return {
        "city": city_value,
        "state": state_value.upper(),
        "zip": zip_value,
        "matchedAddress": matched_address,
    }


def _best_page_project(facts: dict, key: str) -> str:
    rows = []
    for page in list(facts.get("pages") or []):
        value = _text((page.get("project") or {}).get(key))
        if value:
            rows.append((float(page.get("confidence") or 0), value))
    rows.sort(reverse=True)
    return rows[0][1] if rows else ""


def _resolve_identity(
    facts: dict,
    geocode: Callable[[dict], dict[str, str]] | None = None,
    *,
    request: dict | None = None,
) -> tuple[dict, dict]:
    resolved = json.loads(json.dumps(facts))
    structured = dict(resolved.get("structuredIdentity") or {})
    project = dict(resolved.get("project") or {})
    keys = ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip")
    identity = {
        key: _first(structured.get(key), _best_page_project(resolved, key), project.get(key))
        for key in keys
    }
    filled: dict[str, dict[str, str]] = {}

    # Verified raw Revit evidence outranks AI page extraction.  The shared normalizer
    # handles semantic field names, combined/multiline addresses and bounded PDF text.
    if request:
        raw_identity, fields = _verified_raw_revit_identity(request)
        if raw_identity:
            normalized, provenance = identity_normalizer.normalize_verified_evidence(
                raw_identity,
                fields,
                pdf_paths=_pdf_paths(request),
            )
            for key in keys:
                value = _text(normalized.get(key))
                if value:
                    identity[key] = value
            for key, source in provenance.items():
                if identity.get(key):
                    filled[key] = {"value": identity[key], "source": source}

    if not identity["address"] and identity["houseNumber"] and identity["streetName"]:
        identity["address"] = f"{identity['houseNumber']} {identity['streetName']}".strip()
    if not identity["address"]:
        title = identity["title"]
        if re.match(r"^\s*\d+(?:-\d+)?\s+\S+", title):
            identity["address"] = title

    parsed = _split_address_location(identity["address"])
    for key in REQUIRED_LOCATION:
        if not identity[key] and parsed.get(key):
            identity[key] = parsed[key]
            filled[key] = {"value": parsed[key], "source": "verified active-Revit combined address"}

    missing = [key for key in REQUIRED_LOCATION if not identity[key]]
    geocode_result: dict[str, str] = {}
    if missing and identity["address"]:
        try:
            geocode_result = (geocode or _census_lookup)(identity) or {}
        except Exception as exc:
            geocode_result = {"error": f"{type(exc).__name__}: {exc}"}
        for key in REQUIRED_LOCATION:
            value = _text(geocode_result.get(key))
            if not identity[key] and value:
                identity[key] = value
                filled[key] = {"value": value, "source": "US Census address match"}

    for key in keys:
        if identity[key]:
            structured[key] = identity[key]
    resolved["structuredIdentity"] = structured
    resolved["locationResolution"] = {
        "schema": "liber.revex.location-resolution.v3",
        "authority": "derived-only-from-immutable-active-Revit-address",
        "normalizer": "generalized-active-revit-evidence-v1",
        "provider": "US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT" if any(row["source"].startswith("US Census") for row in filled.values()) else None,
        "filled": filled,
        "matchedAddress": _text(geocode_result.get("matchedAddress")),
        "error": _text(geocode_result.get("error")),
        "remainingMissing": [key for key in REQUIRED_LOCATION if not identity[key]],
    }
    return resolved, identity


def _resolved_request(request_path: Path, output_root: Path) -> Path:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(_text(request.get("pageFactsPath")))
    if not page_path.is_file():
        return request_path
    facts = json.loads(page_path.read_text(encoding="utf-8"))
    resolved, identity = _resolve_identity(facts, request=request)
    resolution = resolved.get("locationResolution") or {}

    # Write a derived request whenever normalization changed/filled authoritative identity.
    # The immutable source evidence remains byte-for-byte untouched.
    if not resolution.get("filled"):
        return request_path
    facts_path = output_root / "00_PAGE_FACTS_RESOLVED_R69.json"
    facts_path.write_text(json.dumps(resolved, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_path)
    derived_request["identityResolution"] = resolution
    request_copy = output_root / "00_PIPELINE_REQUEST_RESOLVED_R69.json"
    request_copy.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "PROJECT_IDENTITY_NORMALIZED",
        "status": "RESOLVED" if not resolution.get("remainingMissing") else "PARTIAL",
        "filled": resolution.get("filled"),
        "remainingMissing": resolution.get("remainingMissing"),
        "address": identity.get("address"),
        "city": identity.get("city"),
        "state": identity.get("state"),
        "zip": identity.get("zip"),
    }, ensure_ascii=True), flush=True)
    return request_copy


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    args, passthrough = parser.parse_known_args(argv)
    request_path = args.request.resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output_root = Path(_text(request.get("outputFolder"))).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    resolved = _resolved_request(request_path, output_root)
    guard = Path(__file__).with_name("revex_energy_pipeline_guard.py")
    completed = subprocess.run([sys.executable, str(guard), "--request", str(resolved), *passthrough], cwd=str(guard.parent))
    return int(completed.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())
