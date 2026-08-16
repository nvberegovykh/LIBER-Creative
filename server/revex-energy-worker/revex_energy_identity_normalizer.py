#!/usr/bin/env python3
"""General active-Revit identity normalization for REVEX managed Energy.

The caller must verify the active-Revit identity schema/authority/digest before using
this module. This module only normalizes that verified evidence plus immutable Revit
sheet text. It never supplies identity from a template/reference project and contains
no project-specific address mapping.
"""
from __future__ import annotations

from pathlib import Path
import re
from typing import Iterable

REQUIRED_LOCATION = ("city", "state", "zip")
PARTY_KEY_TOKENS = (
    "architect", "engineer", "consultant", "applicant", "owner", "contractor",
    "business", "company", "firm", "contact", "email", "phone", "vendor",
)
PROJECT_KEY_TOKENS = ("project", "site", "property", "building")
ADDRESS_KEY_TOKENS = ("projectaddress", "siteaddress", "propertyaddress", "buildingaddress", "address")
PARTY_BOUNDARY = re.compile(
    r"\b(?:ARCHITECT|ENGINEER|CONSULTANT|APPLICANT|OWNER|CONTRACTOR|VENDOR|CONTACT|PHONE|EMAIL)\b",
    re.I,
)
CITY_PREFIX = re.compile(
    r"^(?:(?:PROJECT|SITE|PROPERTY|BUILDING)\s+)?"
    r"(?:(?:CITY(?:\s*/?\s*STATE(?:\s*/?\s*ZIP)?)?)|STATE(?:\s*/?\s*ZIP)?|ZIP|LOCATION|LOCALITY|BOROUGH)"
    r"\b[\s:=-]*",
    re.I,
)
LOCALITY = re.compile(
    r"\b([A-Za-z][A-Za-z .'-]{1,60}?)\s*,?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b",
    re.I,
)
STATE_ZIP = re.compile(r"\b([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\b", re.I)
STREET_SUFFIX = (
    r"(?:STREET|ST|AVENUE|AVE|ROAD|RD|BOULEVARD|BLVD|DRIVE|DR|LANE|LN|COURT|CT|"
    r"PLACE|PL|WAY|PARKWAY|PKWY|HIGHWAY|HWY|TERRACE|TER|CIRCLE|CIR)"
)
FULL_ADDRESS_LOCALITY = re.compile(
    rf"^\s*(?P<street>\d+[A-Za-z0-9-]*\s+.+?\b{STREET_SUFFIX}\b)\s*[,]?\s+"
    r"(?P<city>[A-Za-z][A-Za-z .'-]{1,60}?)\s*,?\s+"
    r"(?P<state>[A-Za-z]{2})\s+(?P<zip>\d{5}(?:-\d{4})?)\s*$",
    re.I,
)
GENERIC_ADDRESS_TOKENS = {
    "project", "site", "property", "building", "address", "location",
    "unit", "suite", "floor", "fl",
}


def text(value) -> str:
    return str(value or "").strip()


def flat(value) -> str:
    return re.sub(r"\s+", " ", text(value)).strip()


def norm_key(value) -> str:
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())


def _clean_city(value: str) -> str:
    city = flat(value).strip(" ,;:-")
    prior = None
    while city and prior != city:
        prior = city
        city = CITY_PREFIX.sub("", city).strip(" ,;:-")
    return city


def _candidate(city: str, state: str, zip_code: str) -> dict[str, str]:
    city = _clean_city(city)
    if not city or any(ch.isdigit() for ch in city) or len(city) > 60:
        return {}
    return {"city": city, "state": state.upper(), "zip": zip_code}


def parse_locality(value: str) -> dict[str, str]:
    """Parse an explicitly present US city/state/ZIP group; never infer missing parts.

    The parser preserves line boundaries first, then supports common one-line US address
    layouts.  Ambiguous street+city text is rejected rather than guessed.
    """
    raw = text(value)
    if not raw:
        return {}

    # A titleblock often puts street on one line and city/state/ZIP on the next. Prefer
    # a locality-only line before flattening so the preceding street cannot be swallowed
    # into the city token by PDF/text extraction.
    lines = [line.strip(" ,;:-\t") for line in re.split(r"[\r\n]+", raw) if line.strip()]
    if len(lines) > 1:
        for line in lines:
            boundary = PARTY_BOUNDARY.search(line)
            if boundary:
                line = line[:boundary.start()].strip()
            if not line or re.match(r"^\d", line):
                continue
            match = LOCALITY.search(line)
            if match:
                parsed = _candidate(match.group(1), match.group(2), match.group(3))
                if parsed:
                    return parsed

    source = flat(raw)
    boundary = PARTY_BOUNDARY.search(source)
    if boundary:
        source = source[:boundary.start()].rstrip()
    if not source:
        return {}

    # Common full-address case with no comma/newline between street and city.
    full = FULL_ADDRESS_LOCALITY.match(source)
    if full:
        return _candidate(full.group("city"), full.group("state"), full.group("zip"))

    state_zip = STATE_ZIP.search(source)
    if state_zip:
        prefix = source[:state_zip.start()].rstrip(" ,;:-")
        # When comma-separated, the segment immediately before state is the locality;
        # earlier segments remain street/address content.
        parts = [part.strip(" ,;:-") for part in prefix.split(",") if part.strip(" ,;:-")]
        if len(parts) >= 2:
            parsed = _candidate(parts[-1], state_zip.group(1), state_zip.group(2))
            if parsed:
                return parsed

    # Standalone locality strings such as "Boston, MA 02109" are unambiguous. A
    # digit-led string that reached this point is an unresolved full address and must not
    # be guessed.
    if re.match(r"^\s*\d", source):
        return {}
    match = LOCALITY.search(source)
    if match:
        return _candidate(match.group(1), match.group(2), match.group(3))
    return {}


def field_value(fields: dict, aliases: tuple[str, ...], *, reject: tuple[str, ...] = ()) -> str:
    """Rank semantically named verified-Revit fields without depending on any project string."""
    candidates = []
    for key, raw in fields.items():
        value = text(raw)
        normalized = norm_key(key)
        if not value or any(token in normalized for token in reject):
            continue
        match = max((len(alias) for alias in aliases if alias in normalized), default=0)
        if not match:
            continue
        authority = (
            5 if normalized.startswith("project")
            else 4 if "project" in normalized and "titleblock" in normalized
            else 3 if any(token in normalized for token in PROJECT_KEY_TOKENS) and "titleblock" in normalized
            else 2 if "titleblock" in normalized
            else 1
        )
        candidates.append((authority, match, -len(normalized), value))
    return sorted(candidates, reverse=True)[0][3] if candidates else ""


def identity_from_fields(raw_identity: dict, fields: dict) -> dict[str, str]:
    values = {
        "title": field_value(fields, ("projectname", "buildingname", "projecttitle"), reject=("uniqu",)),
        "address": field_value(fields, ADDRESS_KEY_TOKENS, reject=PARTY_KEY_TOKENS),
        "houseNumber": field_value(fields, ("housenumber", "houseno", "streetnumber"), reject=PARTY_KEY_TOKENS),
        "streetName": field_value(fields, ("streetname",), reject=PARTY_KEY_TOKENS),
        "borough": field_value(fields, ("borough",), reject=PARTY_KEY_TOKENS),
        "city": field_value(fields, ("projectcity", "sitecity", "propertycity", "buildingcity", "city"), reject=PARTY_KEY_TOKENS),
        "state": field_value(fields, ("projectstate", "sitestate", "propertystate", "buildingstate", "stateprovince", "state"), reject=PARTY_KEY_TOKENS + ("status",)),
        "zip": field_value(fields, ("zipcode", "postalcode", "projectzip", "sitezip", "propertyzip", "buildingzip", "zip"), reject=PARTY_KEY_TOKENS),
        "block": field_value(fields, ("taxblock", "block"), reject=PARTY_KEY_TOKENS),
        "lot": field_value(fields, ("taxlot", "lot"), reject=PARTY_KEY_TOKENS),
        "bin": field_value(fields, ("buildingidentificationnumber", "binnumber", "bin"), reject=PARTY_KEY_TOKENS),
        "communityBoard": field_value(fields, ("communityboard", "cbno", "cbnumber"), reject=PARTY_KEY_TOKENS),
        "jobType": field_value(fields, ("jobtype", "filingtype"), reject=PARTY_KEY_TOKENS),
        "architecturalJobNumber": field_value(fields, ("architecturaljobnumber", "architecturaljobno", "dobjobnumber")),
        "mechanicalJobNumber": field_value(fields, ("mechanicaljobnumber", "mechanicaljobno")),
        "plumbingJobNumber": field_value(fields, ("plumbingjobnumber", "plumbingjobno")),
    }
    values["title"] = values["title"] or text(raw_identity.get("displayName") or raw_identity.get("DisplayName"))
    if not values["address"] and values["houseNumber"] and values["streetName"]:
        values["address"] = f"{values['houseNumber']} {values['streetName']}".strip()
    return values


def _street_part(authoritative_address: str) -> str:
    raw = text(authoritative_address)
    if not raw:
        return ""
    lines = [line.strip(" ,;:-\t") for line in re.split(r"[\r\n]+", raw) if line.strip()]
    if len(lines) > 1 and re.match(r"^\d", lines[0]) and any(STATE_ZIP.search(line) for line in lines[1:]):
        return lines[0]
    source = flat(raw)
    full = FULL_ADDRESS_LOCALITY.match(source)
    if full:
        return full.group("street").strip(" ,;:-")
    state_zip = STATE_ZIP.search(source)
    if state_zip:
        prefix = source[:state_zip.start()].rstrip(" ,;:-")
        parts = [part.strip(" ,;:-") for part in prefix.split(",") if part.strip(" ,;:-")]
        if len(parts) >= 2:
            return ", ".join(parts[:-1])
    return source


def address_tokens(authoritative_address: str) -> list[str]:
    tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9]+", _street_part(authoritative_address))]
    return [token for token in tokens if token not in GENERIC_ADDRESS_TOKENS]


def same_street(authoritative_address: str, candidate_text: str) -> bool:
    candidate = flat(candidate_text).lower()
    tokens = address_tokens(authoritative_address)
    if not candidate or not tokens:
        return False
    numeric = [token for token in tokens if token.isdigit()]
    words = [token for token in tokens if not token.isdigit() and len(token) >= 3]
    if numeric and numeric[0] not in candidate:
        return False
    if words and not any(word in candidate for word in words):
        return False
    return bool(numeric or words)


def locality_near_authoritative_address(visible_text: str, authoritative_address: str) -> dict[str, str]:
    """Read locality from a bounded window following the verified project street.

    Ordered street tokens may be separated by titleblock labels/PDF extraction gaps. A
    party heading terminates the locality window so a consultant/engineer address cannot
    become the project's locality merely because it appears later on the same sheet.
    """
    source = flat(visible_text)
    tokens = address_tokens(authoritative_address)
    if not source or not tokens:
        return {}
    pattern = r"\b" + r"\b.{0,64}?\b".join(re.escape(token) for token in tokens) + r"\b"
    for address_match in re.finditer(pattern, source, re.I):
        window = source[address_match.end():address_match.end() + 260]
        boundary = PARTY_BOUNDARY.search(window)
        if boundary:
            window = window[:boundary.start()]
        parsed = parse_locality(window)
        if parsed:
            return parsed
    return {}


def locality_from_fields(fields: dict, authoritative_address: str) -> tuple[dict[str, str], str]:
    """Find locality only in project/site/property/building fields or the exact project street."""
    ranked = []
    for key, raw in fields.items():
        value = text(raw)
        normalized = norm_key(key)
        if not value or any(token in normalized for token in PARTY_KEY_TOKENS):
            continue
        projectish = any(token in normalized for token in PROJECT_KEY_TOKENS)
        addressish = any(token in normalized for token in ADDRESS_KEY_TOKENS)
        street_match = same_street(authoritative_address, value)
        if not projectish and not addressish and not street_match:
            continue
        parsed = locality_near_authoritative_address(value, authoritative_address) if street_match else parse_locality(value)
        if not parsed:
            continue
        authority = (
            6 if normalized.startswith("project") and addressish
            else 5 if projectish and addressish
            else 4 if street_match and "titleblock" in normalized
            else 3 if projectish
            else 2 if addressish
            else 1
        )
        ranked.append((authority, parsed, f"verified Revit field {key}"))
    if not ranked:
        return {}, ""
    ranked.sort(key=lambda row: row[0], reverse=True)
    return ranked[0][1], ranked[0][2]


def locality_from_pdf_paths(paths: Iterable[Path | str], authoritative_address: str) -> tuple[dict[str, str], str]:
    try:
        from pypdf import PdfReader
    except Exception:
        return {}, ""
    for value in paths:
        path = Path(value)
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        try:
            visible = "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
        except Exception:
            continue
        parsed = locality_near_authoritative_address(visible, authoritative_address)
        if parsed:
            return parsed, f"immutable Revit sheet PDF {path.name}"
    return {}, ""


def normalize_verified_evidence(raw_identity: dict, fields: dict, *, pdf_paths: Iterable[Path | str] = ()) -> tuple[dict, dict]:
    """Normalize one verified active-Revit identity evidence graph.

    Returns (identity, provenance). Missing values remain missing; there is no fabricated
    project mapping. External geocoding, if allowed by a caller, is a later explicit step.
    """
    identity = identity_from_fields(raw_identity, fields)
    provenance: dict[str, str] = {}
    combined = parse_locality(identity.get("address", ""))
    for key in REQUIRED_LOCATION:
        if not identity.get(key) and combined.get(key):
            identity[key] = combined[key]
            provenance[key] = "verified active-Revit combined address"

    if any(not identity.get(key) for key in REQUIRED_LOCATION):
        parsed, source = locality_from_fields(fields, identity.get("address", ""))
        for key in REQUIRED_LOCATION:
            if not identity.get(key) and parsed.get(key):
                identity[key] = parsed[key]
                provenance[key] = source

    if any(not identity.get(key) for key in REQUIRED_LOCATION) and identity.get("address"):
        parsed, source = locality_from_pdf_paths(pdf_paths, identity["address"])
        for key in REQUIRED_LOCATION:
            if not identity.get(key) and parsed.get(key):
                identity[key] = parsed[key]
                provenance[key] = source

    return identity, provenance
