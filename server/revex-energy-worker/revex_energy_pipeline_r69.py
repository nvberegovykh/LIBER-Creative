#!/usr/bin/env python3
"""REVEX managed-Energy current-project identity resolver.

The immutable active-Revit evidence graph is authoritative.  This resolver consumes
both the reduced page-facts object and the already-verified raw Revit project identity
artifact carried in sourceArtifacts.  Combined/multiline titleblock address values are
normalized deterministically before the preserved Energy failure guard runs.

No reference-project identity is accepted.  The public Census geocoder remains only a
last-resort derivation for missing city/state/ZIP from an already-authoritative street
address; source evidence is never edited in place.
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


def _flat(value: str) -> str:
    return re.sub(r"\s+", " ", _text(value)).strip()


def _norm_key(value: str) -> str:
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())


def _split_address_location(value: str) -> dict[str, str]:
    """Read an already-present city/state/ZIP suffix without inventing anything."""
    text = _flat(value)
    if not text:
        return {}
    match = re.search(
        r"(?:,|\s)\s*([A-Za-z][A-Za-z .'-]{1,60})\s*,?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$",
        text,
    )
    if not match:
        return {}
    return {"city": match.group(1).strip(), "state": match.group(2).upper(), "zip": match.group(3)}


def _location_anywhere(value: str) -> dict[str, str]:
    text = _flat(value)
    if not text:
        return {}
    matches = list(re.finditer(
        r"\b([A-Za-z][A-Za-z .'-]{1,60}?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b",
        text,
    ))
    if not matches:
        return {}
    match = matches[-1]
    return {"city": match.group(1).strip(), "state": match.group(2).upper(), "zip": match.group(3)}


def _field_value(fields: dict, aliases: tuple[str, ...], *, reject: tuple[str, ...] = ()) -> str:
    candidates = []
    for key, raw in fields.items():
        value = _text(raw)
        normalized = _norm_key(key)
        if not value or any(token in normalized for token in reject):
            continue
        strength = max((len(alias) for alias in aliases if alias in normalized), default=0)
        if not strength:
            continue
        authority = 4 if normalized.startswith("project") else 3 if "project" in normalized and "titleblock" in normalized else 2 if "titleblock" in normalized else 1
        candidates.append((authority, strength, -len(normalized), value))
    return sorted(candidates, reverse=True)[0][3] if candidates else ""


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


def _same_street(authoritative_address: str, candidate_text: str) -> bool:
    address = _flat(authoritative_address).lower()
    candidate = _flat(candidate_text).lower()
    if not address or not candidate:
        return False
    house_match = re.match(r"^(\d+(?:-\d+)?)\b", address)
    house = house_match.group(1) if house_match else ""
    words = [w for w in re.findall(r"[a-z0-9]+", address) if len(w) >= 3 and not w.isdigit()]
    if house and house not in candidate:
        return False
    if words and not any(word in candidate for word in words):
        return False
    return bool(house or words)


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


def _raw_identity_values(raw_identity: dict, fields: dict) -> dict[str, str]:
    values = {
        "title": _field_value(fields, ("projectname", "buildingname", "projecttitle"), reject=("uniqu",)),
        "address": _field_value(fields, ("projectaddress", "siteaddress", "propertyaddress", "buildingaddress", "address"), reject=("business", "email")),
        "houseNumber": _field_value(fields, ("housenumber", "houseno", "streetnumber")),
        "streetName": _field_value(fields, ("streetname",)),
        "borough": _field_value(fields, ("borough",)),
        "city": _field_value(fields, ("projectcity", "city"), reject=("business",)),
        "state": _field_value(fields, ("projectstate", "stateprovince", "state"), reject=("status",)),
        "zip": _field_value(fields, ("zipcode", "postalcode", "projectzip", "zip")),
    }
    values["title"] = values["title"] or _text(raw_identity.get("displayName") or raw_identity.get("DisplayName"))
    if not values["address"] and values["houseNumber"] and values["streetName"]:
        values["address"] = f"{values['houseNumber']} {values['streetName']}".strip()
    return values


def _location_from_raw_fields(fields: dict, authoritative_address: str) -> tuple[dict[str, str], str]:
    """Find locality in authoritative Project Information/titleblock values only."""
    ranked = []
    for key, raw in fields.items():
        value = _text(raw)
        if not value:
            continue
        parsed = _split_address_location(value) or _location_anywhere(value)
        if not parsed:
            continue
        normalized = _norm_key(key)
        projectish = normalized.startswith("project") or any(token in normalized for token in ("projectaddress", "siteaddress", "propertyaddress", "buildingaddress"))
        street_match = _same_street(authoritative_address, value)
        if not projectish and not street_match:
            continue
        authority = 5 if normalized.startswith("project") else 4 if "projectaddress" in normalized else 3 if street_match and "titleblock" in normalized else 2 if street_match else 1
        ranked.append((authority, parsed, f"raw Revit field {key}"))
    if not ranked:
        return {}, ""
    ranked.sort(key=lambda row: row[0], reverse=True)
    return ranked[0][1], ranked[0][2]


def _location_from_revit_pdfs(request: dict, authoritative_address: str) -> tuple[dict[str, str], str]:
    """Read immutable native-Revit PDFs and accept locality only adjacent to the authoritative street."""
    address = _flat(authoritative_address)
    if not address:
        return {}, ""
    tokens = re.findall(r"[A-Za-z0-9]+", address)
    if not tokens:
        return {}, ""
    address_pattern = r"\s*[,\-]?\s*".join(re.escape(token) for token in tokens)
    pattern = re.compile(
        address_pattern + r"\s*[,]?\s+([A-Za-z][A-Za-z .'-]{1,60}?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b",
        re.I,
    )
    try:
        from pypdf import PdfReader
    except Exception:
        return {}, ""
    for value in list(request.get("sourceArtifacts") or []):
        path = Path(_text(value))
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        try:
            text = "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
        except Exception:
            continue
        flat = _flat(text)
        match = pattern.search(flat)
        if not match:
            continue
        return {
            "city": match.group(1).strip(),
            "state": match.group(2).upper(),
            "zip": match.group(3),
        }, f"immutable Revit sheet PDF {path.name}"
    return {}, ""


def _census_lookup(identity: dict) -> dict[str, str]:
    address = _first(identity.get("address"), identity.get("title"))
    if not address:
        return {}
    borough = _text(identity.get("borough"))
    city = _text(identity.get("city"))
    state = _text(identity.get("state"))
    if not city and borough.lower() in NYC_BOROUGHS:
        city = NYC_BOROUGHS[borough.lower()]
    state_hint = state or ("NY" if borough.lower() in NYC_BOROUGHS else "")
    query_address = ", ".join(part for part in (address, city or borough, state_hint) if part)
    params = urlencode({"address": query_address, "benchmark": CENSUS_BENCHMARK, "format": "json"})
    request = Request(f"{CENSUS_ENDPOINT}?{params}", headers={"User-Agent": "LIBER-REVEX/0.8.19 r82"})
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


def _resolve_identity(
    facts: dict,
    geocode: Callable[[dict], dict[str, str]] | None = None,
    *,
    request: dict | None = None,
) -> tuple[dict, dict]:
    resolved = json.loads(json.dumps(facts))
    structured = dict(resolved.get("structuredIdentity") or {})
    project = dict(resolved.get("project") or {})
    identity = {
        key: _first(_best_page_project(resolved, key), structured.get(key), project.get(key))
        for key in ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip")
    }
    filled: dict[str, dict[str, str]] = {}

    if request:
        raw_identity, fields = _verified_raw_revit_identity(request)
        raw = _raw_identity_values(raw_identity, fields) if raw_identity else {}
        for key in ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip"):
            if not identity[key] and _text(raw.get(key)):
                identity[key] = _text(raw[key])
                if key in REQUIRED_LOCATION:
                    filled[key] = {"value": identity[key], "source": "verified raw active-Revit identity field"}

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
            filled[key] = {"value": parsed[key], "source": "active-Revit combined address text"}

    if request and any(not identity[key] for key in REQUIRED_LOCATION):
        raw_identity, fields = _verified_raw_revit_identity(request)
        raw_location, raw_source = _location_from_raw_fields(fields, identity["address"]) if raw_identity else ({}, "")
        for key in REQUIRED_LOCATION:
            if not identity[key] and raw_location.get(key):
                identity[key] = raw_location[key]
                filled[key] = {"value": raw_location[key], "source": raw_source}

    if request and any(not identity[key] for key in REQUIRED_LOCATION):
        pdf_location, pdf_source = _location_from_revit_pdfs(request, identity["address"])
        for key in REQUIRED_LOCATION:
            if not identity[key] and pdf_location.get(key):
                identity[key] = pdf_location[key]
                filled[key] = {"value": pdf_location[key], "source": pdf_source}

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

    for key in ("title", "address", "houseNumber", "streetName", "borough", "city", "state", "zip"):
        if identity[key]:
            structured[key] = identity[key]
    resolved["structuredIdentity"] = structured
    resolved["locationResolution"] = {
        "schema": "liber.revex.location-resolution.v2",
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
    resolved, identity = _resolve_identity(facts, request=request)
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
        "stage": "PROJECT_IDENTITY_R82", "status": "RESOLVED",
        "filled": resolved["locationResolution"]["filled"],
        "remainingMissing": resolved["locationResolution"]["remainingMissing"],
        "address": identity.get("address"),
        "city": identity.get("city"), "state": identity.get("state"), "zip": identity.get("zip"),
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
