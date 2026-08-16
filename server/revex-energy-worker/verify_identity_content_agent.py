#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import revex_identity_content_agent as agent

SOURCE = HERE / "revex_identity_content_agent.py"


def build_fixture(folder: Path):
    t_pdf = folder / "REVIT_PAGE_T_T-001_TEST.pdf"
    z_pdf = folder / "REVIT_PAGE_Z_Z-001_TEST.pdf"
    t_pdf.write_bytes(b"%PDF synthetic fixture marker")
    z_pdf.write_bytes(b"%PDF synthetic fixture marker")
    facts = {
        "schema": "liber.revex.revit-page-facts.v1",
        "structuredIdentity": {
            "title": "Example Residence",
            "address": "250 Example Street",
            "city": None,
            "state": None,
            "zip": None,
        },
        "pages": [
            {
                "pageType": "T", "sheetNumber": "T-001", "sheetName": "Cover Sheet", "confidence": 0.99,
                "sourceFile": t_pdf.name,
                "project": {"title": "Example Residence", "address": "250 Example Street", "city": None, "state": None, "zip": None},
            },
            {
                "pageType": "Z", "sheetNumber": "Z-001", "sheetName": "Zoning Analysis", "confidence": 0.99,
                "sourceFile": z_pdf.name,
                # Deliberately poisoned prior extraction: the content-aware consensus must
                # reject this consultant locality and normalize the derived projection.
                "project": {"title": "Example Residence", "address": "250 Example Street", "city": "Troy", "state": "NY", "zip": "12180"},
            },
        ],
    }
    facts_path = folder / "revit-page-facts.json"
    facts_path.write_text(json.dumps(facts), encoding="utf-8")
    request_path = folder / "request.json"
    output = folder / "run"
    output.mkdir()
    request_path.write_text(json.dumps({
        "pageFactsPath": str(facts_path),
        "sourceArtifacts": [str(t_pdf), str(z_pdf)],
        "outputFolder": str(output),
    }), encoding="utf-8")
    texts = {
        t_pdf.name.lower(): (
            "PROJECT: EXAMPLE RESIDENCE PROJECT ADDRESS 250 EXAMPLE STREET BROOKLYN, NY 11225 "
            "APPLICANT 2259 BEDFORD AVENUE BROOKLYN, NY 11219 CONSULTING 7407 13TH AVE BROOKLYN, NY 11228"
        ),
        z_pdf.name.lower(): (
            "PROJECT INFORMATION ADDRESS 250 EXAMPLE STREET, BROOKLYN, NY 11225 BLOCK 1 LOT 2 "
            "CONSULTANT 99 OTHER ROAD, Troy, NY 12180"
        ),
    }
    return facts, facts_path, request_path, output, texts


with tempfile.TemporaryDirectory(prefix="revex-r88-content-identity-") as temp:
    folder = Path(temp)
    facts, facts_path, request_path, output, texts = build_fixture(folder)
    original = copy.deepcopy(facts)

    def good_agent(selected, _facts, base):
        assert len(selected) == 2
        assert base["address"] == "250 Example Street"
        return {
            "title": "Example Residence",
            "address": "250 Example Street",
            "city": "Brooklyn",
            "state": "NY",
            "zip": "11225",
            "confidence": 0.99,
            "evidence": [
                {"sourceFile": selected[0][1].name, "visibleText": "250 EXAMPLE STREET BROOKLYN, NY 11225", "role": "PROJECT"},
                {"sourceFile": selected[1][1].name, "visibleText": "250 EXAMPLE STREET, BROOKLYN, NY 11225", "role": "PROJECT INFORMATION"},
            ],
            "excludedPartyEvidence": ["CONSULTANT 99 OTHER ROAD, Troy, NY 12180"],
        }

    resolved_request = agent.resolve_request(
        request_path,
        output,
        agent=good_agent,
        pdf_text_loader=lambda path: texts[path.name.lower()],
    )
    assert resolved_request != request_path
    assert json.loads(facts_path.read_text(encoding="utf-8")) == original, "immutable source page facts were mutated"
    request = json.loads(resolved_request.read_text(encoding="utf-8"))
    derived = json.loads(Path(request["pageFactsPath"]).read_text(encoding="utf-8"))
    identity = derived["structuredIdentity"]
    assert identity["city"] == "Brooklyn" and identity["state"] == "NY" and identity["zip"] == "11225"
    assert all((page["project"]["city"], page["project"]["state"], page["project"]["zip"]) == ("Brooklyn", "NY", "11225") for page in derived["pages"])
    assert "12180" not in json.dumps(derived["identityResolution"])
    audit = json.loads((output / "PROJECT_IDENTITY_CONTENT_AGENT_R88.json").read_text(encoding="utf-8"))
    assert audit["status"] == "PASSED" and audit["uniqueVoteSources"] >= 2

with tempfile.TemporaryDirectory(prefix="revex-r88-content-identity-reject-") as temp:
    folder = Path(temp)
    _facts, _facts_path, request_path, output, texts = build_fixture(folder)

    def wrong_party_agent(selected, _facts, _base):
        return {
            "title": "Consultant",
            "address": "99 Other Road",
            "city": "Troy",
            "state": "NY",
            "zip": "12180",
            "confidence": 0.99,
            "evidence": [{"sourceFile": selected[-1][1].name, "visibleText": "CONSULTANT 99 OTHER ROAD, Troy, NY 12180", "role": "CONSULTANT"}],
            "excludedPartyEvidence": [],
        }

    rejected = agent.resolve_request(
        request_path,
        output,
        agent=wrong_party_agent,
        pdf_text_loader=lambda path: texts[path.name.lower()],
    )
    assert rejected == request_path, "party address must never become project identity"
    audit = json.loads((output / "PROJECT_IDENTITY_CONTENT_AGENT_R88.json").read_text(encoding="utf-8"))
    assert any("authoritative active-Revit project street" in item for item in audit["rejected"])

source = SOURCE.read_text(encoding="utf-8").upper()
assert "250 MIDWOOD" not in source and "79 WINTHROP" not in source
assert "CONTENT-AWARE" in source and "CONSULTANT" in source and "MIN_AGENT_CONFIDENCE" in source

print(json.dumps({
    "schema": "liber.revex.identity-content-agent-qa.v1",
    "status": "PASSED",
    "contentAwareRoleSeparation": True,
    "twoSourceConsensus": True,
    "partyAddressRejected": True,
    "sourceFactsImmutable": True,
    "derivedProjectionNormalized": True,
    "projectSpecificRuntimeBranches": False,
}, indent=2))
