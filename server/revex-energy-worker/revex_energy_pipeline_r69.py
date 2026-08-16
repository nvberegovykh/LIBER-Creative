#!/usr/bin/env python3
"""REVEX r69 managed-Energy request resolver.

The immutable Revit T/Z evidence remains authoritative. When that evidence carries a
street address but omits city/state/ZIP, this wrapper may derive only those missing
location fields from that exact address using the public US Census geocoder. The
source evidence is never edited; a derived page-facts copy and request copy are
written inside the immutable run output and then passed to the existing r55 failure
guard / pinned Energy pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Callable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

CENSUS_ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
CENSUS_BENCHMARK = "Public_AR_Current"
REQUIRED_LOCATION = ("city", "state", "zip")
NYC_BOROUGHS = {
    "brooklyn": "Brooklyn",
    "bronx": "Bronx",
    "manhattan": "New York",
    "new york": "New York",
    "queens": "Queens",
    "staten island": "Staten Island",
}


def _text(value) -> str:
    return str(value or "").strip()


def _first(*values) -> str:
    return next((_text(value) for value in values if _text(value)), "")


def _split_address_location(value: str) -> dict[str, str]:
    """Read an already-present city/state/ZIP suffix without inventing anything."""
    text = _text(value)
    if not text:
        return {}
    match = re.search(
        r"(?:,|\s)\s*([A-Za-z][A-Za-z .'-]{1,60})\s*,?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$",
        text,
    )
    if not match:
        return {}
    return {"city": match.group(1).strip(), "state": match.group(2).upper(), "zip": match.group(3)}


def _street_tokens(identity: dict) -> tuple[str, str]:
    address = _first(identity.get("address"), identity.get("title"))
    house = _text(identity.get("houseNumber"))
    street = _text(identity.get("streetName"))
    if not house:
        match = re.match(r"^\s*(\d+(?:-\d+)?)\b", address)
        if match:
            house = match.group(1)
    if not street and house:
        street = re.sub(r"^\s*" + re.escape(house) + r"\s+", "", address, count=1, flags=re.I)
        street = re.split(r",", street, maxsplit=1)[0].strip()
    return house, street


def _census_lookup(identity: dict) -> dict[str, str]:
    address = _first(identity.get("address"), identity.get("title"))
    if not address:
        return {}
    borough = _text(identity.get("borough"))
    city = _text(identity.get("city"))
    state = _text(identity.get("state"))
    if not city and borough.lower() in NYC_BOROUGHS:
        city = NYC_BOROUGHS[borough.lower()]
    # NYC borough evidence is enough to constrain the query to New York State,
    # but the returned state/ZIP still come from Census, not from this hint.
    state_hint = state or ("NY" if borough.lower() in NYC_BOROUGHS else "")
    query_address = ", ".join(part for part in (address, city or borough, state_hint) if part)
    params = urlencode({"address": query_address, "benchmark": CENSUS_BENCHMARK, "format": "json"})
    request = Request(f"{CENSUS_ENDPOINT}?{params}", headers={"User-Agent": "LIBER-REVEX/0.8.19 r69"})
    with urlopen(request, timeout=12) as response:
        payload = json.loads(response.read().decode("utf-8"))
    matches = (((payload or {}).get("result") or {}).get("addressMatches") or [])
    if not matches:
        return {}
    match = matches[0]
    components = dict(match.get("addressComponents") or {})
    matched_address = _text(match.get("matchedAddress"))

    expected_house, expected_street = _street_tokens(identity)
    actual_house = _text(components.get("fromAddress"))
    actual_street = " ".join(
        part for part in (
            _text(components.get("preQualifier")), _text(components.get("preDirection")),
            _text(components.get("preType")), _text(components.get("streetName")),
            _text(components.get("suffixType")), _text(components.get("suffixDirection")),
            _text(components.get("suffixQualifier")),
        ) if part
    ).strip()
    if expected_house and actual_house and expected_house.lstrip("0") != actual_house.lstrip("0"):
        return {}
    source_words = [w for w in re.findall(r"[A-Za-z0-9]+", expected_street.lower()) if len(w) >= 3]
    target = (actual_street + " " + matched_address).lower()
    if source_words and not any(word in target for word in source_words):
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


def _resolve_identity(facts: dict, geocode: Callable[[dict], dict[str, str]] | None = None) -> tuple[dict, dict]:
    resolved = json.loads(json.dumps(facts))
    structured = dict(resolved.get("structuredIdentity") or {})
    project = dict(resolved.get("project") or {})
    identity = {
        key: _first(_best_page_project(resolved, key), structured.get(key), project.get(key))
        for key in ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip")
    }
    if not identity["address"] and identity["houseNumber"] and identity["streetName"]:
        identity["address"] = f"{identity['houseNumber']} {identity['streetName']}".strip()
    if not identity["address"]:
        title = identity["title"]
        if re.match(r"^\s*\d+(?:-\d+)?\s+\S+", title):
            identity["address"] = title
    parsed = _split_address_location(identity["address"])
    filled = {}
    for key in REQUIRED_LOCATION:
        if not identity[key] and parsed.get(key):
            identity[key] = parsed[key]
            filled[key] = {"value": parsed[key], "source": "active-Revit address text"}

    missing = [key for key in REQUIRED_LOCATION if not identity[key]]
    geocode_result = {}
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

    for key in ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip"):
        if identity[key] and not _text(structured.get(key)):
            structured[key] = identity[key]
    resolved["structuredIdentity"] = structured
    resolved["locationResolution"] = {
        "schema": "liber.revex.location-resolution.v1",
        "authority": "derived-only-from-immutable-active-Revit-address",
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
    resolved, identity = _resolve_identity(facts)
    if not resolved.get("locationResolution", {}).get("filled"):
        return request_path
    facts_path = output_root / "00_PAGE_FACTS_RESOLVED_R69.json"
    facts_path.write_text(json.dumps(resolved, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_path)
    derived_request["identityResolution"] = resolved.get("locationResolution")
    request_copy = output_root / "00_PIPELINE_REQUEST_RESOLVED_R69.json"
    request_copy.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "PROJECT_IDENTITY_R69", "status": "RESOLVED",
        "filled": resolved["locationResolution"]["filled"],
        "remainingMissing": resolved["locationResolution"]["remainingMissing"],
        "address": identity.get("address"),
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
    completed = subprocess.run([sys.executable, str(guard), "--request", str(resolved), *passthrough], cwd=str(guard.parent), env=os.environ.copy())
    return int(completed.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())
