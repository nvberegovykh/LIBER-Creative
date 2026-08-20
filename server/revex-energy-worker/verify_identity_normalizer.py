#!/usr/bin/env python3
from __future__ import annotations

import ast
import copy
import json
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import revex_energy_identity_normalizer as norm
import revex_energy_pipeline_r69 as resolver

NORMALIZER = HERE / "revex_energy_identity_normalizer.py"
RESOLVER = HERE / "revex_energy_pipeline_r69.py"
WORKER = HERE / "app.py"


def worker_identity_boundary():
    """Load the exact worker identity functions without importing Flask/Cloud SDKs."""
    wanted_functions = {
        "safe_name", "_allowed_normalized_identity_provenance",
        "_load_vetted_normalized_identity", "load_structured_identity",
    }
    wanted_assignments = {
        "_NORMALIZED_IDENTITY_PROJECT_PROVENANCE",
        "_NORMALIZED_IDENTITY_SHEET_SUFFIX",
    }
    tree = ast.parse(WORKER.read_text(encoding="utf-8"), filename=str(WORKER))
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_functions:
            selected.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in wanted_assignments
            for target in node.targets
        ):
            selected.append(node)
    namespace = {"json": json, "Path": Path}
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(WORKER), "exec"), namespace)
    assert wanted_functions.issubset(namespace) and wanted_assignments.issubset(namespace)
    return namespace

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

# The managed worker must consume only the add-in's normalized field map with an
# exact raw-field provenance link. Generic architect/consultant title-block locality
# remains visible evidence but cannot short-circuit the role-aware downstream stages.
worker_boundary = worker_identity_boundary()
with tempfile.TemporaryDirectory(prefix="revex-worker-identity-") as temp:
    folder = Path(temp)
    digest = "c" * 64
    identity_path = folder / "revit-project-identity.json"
    raw_identity = {
        "schema": "liber.revex.revit-project-identity.v1",
        "authority": "active-revit-document-t-z-title-evidence",
        "digest": digest,
        "model": "Current Model",
        "sheets": ["T001 · TITLE"],
        "fields": {
            "project.Project Name": "Current Project",
            "project.Project Address": "18 Example Ave\nQueens, NY 11375",
            "sheet.T001.titleBlock.Architect City": "Brooklyn",
            "sheet.T001.titleBlock.Architect State": "NY",
            "sheet.T001.titleBlock.Architect Zip Code": "11219",
        },
        "normalized": {
            "title": "Current Project",
            "address": "18 Example Ave\nQueens, NY 11375",
        },
        "normalizedProvenance": {
            "title": "project.Project Name",
            "address": "project.Project Address",
        },
    }
    manifest = {
        "projectBinding": {"identityEvidenceDigest": digest},
        "artifacts": [{"role": "revit-project-identity", "name": identity_path.name}],
    }
    identity_path.write_text(json.dumps(raw_identity), encoding="utf-8")
    load_structured = worker_boundary["load_structured_identity"]
    structured = load_structured(manifest, {identity_path.name: identity_path})
    assert structured["city"] is None and structured["state"] is None and structured["zip"] is None
    assert structured["normalizedProvenance"] == {
        "title": "project.Project Name", "address": "project.Project Address"
    }

    # Combined authoritative Project Address is intentionally preserved at the worker
    # boundary, then parsed by the role-aware downstream normalizer without party data.
    resolved_from_raw, resolved_provenance = norm.normalize_verified_evidence(
        raw_identity, raw_identity["fields"]
    )
    assert (resolved_from_raw["city"], resolved_from_raw["state"], resolved_from_raw["zip"]) == (
        "Queens", "NY", "11375"
    )
    assert all("Architect" not in source for source in resolved_provenance.values())

    explicit_project = copy.deepcopy(raw_identity)
    explicit_project["fields"].update({
        "sheet.T001.titleBlock.Project City": "Queens",
        "sheet.T001.titleBlock.Project State": "NY",
        "sheet.T001.titleBlock.Project Zip Code": "11375",
    })
    explicit_project["normalized"].update({"city": "Queens", "state": "NY", "zip": "11375"})
    explicit_project["normalizedProvenance"].update({
        "city": "sheet.T001.titleBlock.Project City",
        "state": "sheet.T001.titleBlock.Project State",
        "zip": "sheet.T001.titleBlock.Project Zip Code",
    })
    identity_path.write_text(json.dumps(explicit_project), encoding="utf-8")
    explicit_result = load_structured(manifest, {identity_path.name: identity_path})
    assert (explicit_result["city"], explicit_result["state"], explicit_result["zip"]) == (
        "Queens", "NY", "11375"
    )

    forged = copy.deepcopy(raw_identity)
    forged["normalized"]["city"] = "Brooklyn"
    forged["normalizedProvenance"]["city"] = "sheet.T001.titleBlock.Architect City"
    identity_path.write_text(json.dumps(forged), encoding="utf-8")
    try:
        load_structured(manifest, {identity_path.name: identity_path})
        raise AssertionError("generic party City bypassed normalized project provenance")
    except ValueError as exc:
        assert "non-project provenance" in str(exc)

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
# separate regression fixtures, never in these runtime primitives.
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
    "workerNormalizedProvenanceRequired": True,
    "explicitProjectTitleblockLocalityAccepted": True,
    "genericPartyTitleblockLocalityRejected": True,
    "crossProjectCases": True,
    "censusLastResort": True,
    "sourceImmutable": True,
    "projectSpecificRuntimeBranches": False,
}, indent=2))
