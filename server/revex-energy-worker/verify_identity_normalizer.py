#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile

HERE = Path(__file__).resolve().parent
NORMALIZER = HERE / "revex_energy_identity_normalizer.py"
RESOLVER = HERE / "revex_energy_pipeline_r69.py"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


norm = load("revex_identity_normalizer", NORMALIZER)
resolver = load("revex_identity_resolver", RESOLVER)

# General combined-address parsing across unrelated projects/locations.
for source, expected in (
    ("18 Example Ave, Queens, NY 11375", {"city": "Queens", "state": "NY", "zip": "11375"}),
    ("500 Market Street, San Francisco, CA 94105", {"city": "San Francisco", "state": "CA", "zip": "94105"}),
    ("123 Congress Ave Austin, TX 78701", {"city": "Austin", "state": "TX", "zip": "78701"}),
):
    assert norm.parse_locality(source) == expected, (source, norm.parse_locality(source))

# Project address locality must win over later consultant/engineer addresses.
visible = (
    "PROJECT ADDRESS 77 RIVER ROAD CITY / STATE / ZIP Albany, NY 12207 "
    "ARCHITECT 99 OTHER ROAD, Troy, NY 12180"
)
assert norm.locality_near_authoritative_address(visible, "77 River Road") == {
    "city": "Albany", "state": "NY", "zip": "12207"
}

visible2 = (
    "CONSULTANT 2259 BEDFORD AVENUE, Brooklyn, NY 11219 "
    "PROJECT ADDRESS 18 Example Ave Queens, NY 11375 "
    "ENGINEER 7407 13TH AVE, Brooklyn, NY 11228"
)
assert norm.locality_near_authoritative_address(visible2, "18 Example Ave") == {
    "city": "Queens", "state": "NY", "zip": "11375"
}

# Semantic Revit fields work without any known project naming convention.
raw = {"displayName": "General Test Building"}
fields = {
    "project.Project Name": "General Test Building",
    "project.Address": "500 Market Street",
    "sheet.A100.titleBlock.Project Address": "500 MARKET STREET, San Francisco, CA 94105",
    "sheet.A100.titleBlock.Engineer Address": "100 Engineer Way, Oakland, CA 94607",
}
identity, provenance = norm.normalize_verified_evidence(raw, fields)
assert identity["address"] == "500 Market Street"
assert identity["city"] == "San Francisco" and identity["state"] == "CA" and identity["zip"] == "94105"
assert "Engineer" not in " ".join(provenance.values())

# Separate project city/state/ZIP fields are accepted directly.
identity2, _ = norm.normalize_verified_evidence({"displayName": "Another Building"}, {
    "project.Project Name": "Another Building",
    "project.Address": "12 Broad Street",
    "project.City": "Boston",
    "project.State": "MA",
    "project.Postal Code": "02109",
})
assert identity2["city"] == "Boston" and identity2["state"] == "MA" and identity2["zip"] == "02109"

# No authority -> no fabrication.
identity3, provenance3 = norm.normalize_verified_evidence({"displayName": "Unknown"}, {})
assert not identity3["city"] and not identity3["state"] and not identity3["zip"]
assert provenance3 == {}

# End-to-end resolver must consume a verified immutable raw identity graph, preserve
# source facts byte-for-byte, reject distracting party addresses, and avoid Census when
# the active-Revit evidence is already complete.
with tempfile.TemporaryDirectory(prefix="revex-general-identity-") as temp:
    folder = Path(temp)
    digest = "b" * 64
    manifest = folder / "engineering-sync.json"
    raw_path = folder / "revit-project-identity.json"
    page_path = folder / "revit-page-facts.json"
    manifest.write_text(json.dumps({
        "schema": "liber.revex.engineering-sync.v1",
        "projectBinding": {"identityEvidenceDigest": digest},
    }), encoding="utf-8")
    raw_path.write_text(json.dumps({
        "schema": "liber.revex.revit-project-identity.v1",
        "authority": "active-revit-document-t-z-title-evidence",
        "digest": digest,
        "displayName": "River Test",
        "fields": {
            "project.Project Name": "River Test",
            "project.Address": "77 River Road",
            "sheet.T001.titleBlock.Project Address": "77 RIVER ROAD\nAlbany, NY 12207",
            "sheet.T001.titleBlock.Consultant Address": "99 OTHER ROAD, Troy, NY 12180",
        },
    }), encoding="utf-8")
    facts = {
        "schema": "liber.revex.revit-page-facts.v1",
        "structuredIdentity": {"title": "River Test", "address": "77 River Road", "city": None, "state": None, "zip": None},
        "pages": [],
    }
    page_path.write_text(json.dumps(facts), encoding="utf-8")
    original = copy.deepcopy(facts)
    calls = []
    request = {
        "engineeringManifestPath": str(manifest),
        "sourceArtifacts": [str(raw_path)],
        "pageFactsPath": str(page_path),
    }
    resolved, resolved_identity = resolver._resolve_identity(
        facts,
        lambda value: calls.append(dict(value)) or {},
        request=request,
    )
    assert facts == original, "immutable source page facts were mutated"
    assert resolved_identity["city"] == "Albany"
    assert resolved_identity["state"] == "NY"
    assert resolved_identity["zip"] == "12207"
    assert resolved["locationResolution"]["remainingMissing"] == []
    assert resolved["locationResolution"]["provider"] is None
    assert calls == [], "external geocoder must be last resort only"
    serialized = json.dumps(resolved["structuredIdentity"])
    assert "12180" not in serialized

# Generic Census fallback remains available only after an authoritative street exists.
facts = {
    "schema": "liber.revex.revit-page-facts.v1",
    "structuredIdentity": {"title": "Synthetic", "address": "42 Example Boulevard"},
    "pages": [],
}
seen = []
resolved, resolved_identity = resolver._resolve_identity(
    facts,
    lambda value: seen.append(dict(value)) or {"city": "Denver", "state": "CO", "zip": "80202", "matchedAddress": "42 EXAMPLE BLVD, DENVER, CO 80202"},
)
assert seen and seen[0]["address"] == "42 Example Boulevard"
assert resolved_identity["city"] == "Denver" and resolved_identity["state"] == "CO" and resolved_identity["zip"] == "80202"
assert resolved["locationResolution"]["provider"] == "US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT"

# Implementation itself must stay project-agnostic. Live project strings belong only in
# separate regression fixtures, never in these two runtime primitives.
for path in (NORMALIZER, RESOLVER):
    source = path.read_text(encoding="utf-8").upper()
    assert "250 MIDWOOD" not in source
    assert "79 WINTHROP" not in source

print(json.dumps({
    "schema": "liber.revex.identity-normalizer-generalization.v1",
    "status": "PASSED",
    "combinedAddresses": True,
    "separateFields": True,
    "boundedPdfText": True,
    "partyAddressRejected": True,
    "crossProjectCases": True,
    "censusLastResort": True,
    "sourceImmutable": True,
    "projectSpecificRuntimeBranches": False,
}, indent=2))
