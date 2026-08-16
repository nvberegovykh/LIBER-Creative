from pathlib import Path

AGENT = Path('server/revex-energy-worker/revex_identity_content_agent.py')
VERIFY = Path('server/revex-energy-worker/verify_identity_content_agent.py')

agent = AGENT.read_text(encoding='utf-8')
old_version = 'AGENT_VERSION = "20260816r88-content-identity1"'
new_version = 'AGENT_VERSION = "20260816r96-content-identity2"'
if old_version in agent:
    agent = agent.replace(old_version, new_version, 1)
elif new_version not in agent:
    raise SystemExit('r96 agent-version anchor missing')

marker = '"method": "multimodal-project-evidence"'
if marker not in agent:
    anchor = '''    unique_sources = {row["source"] for row in audit["votes"] if row.get("source")}
'''
    if anchor not in agent:
        raise SystemExit('r96 vote insertion anchor missing')
    insert = '''    # The multimodal resolver saw the immutable PDF bytes even when the PDF text layer is\n    # fragmented or absent. Its own evidence may therefore provide an independent source\n    # vote, but only after deterministic role/street/locality checks. This breaks the\n    # circular dependency on the earlier page parser without accepting consultant identity.\n    party_role_tokens = ("architect", "engineer", "consultant", "applicant", "owner", "contractor", "vendor", "contact")\n    project_role_tokens = ("project", "title block", "titleblock", "site", "property", "building")\n    for evidence in list(candidate.get("evidence") or []):\n        source = _safe_name(evidence.get("sourceFile") or "").lower()\n        if not source or source not in tz_source_names:\n            continue\n        role = _norm(evidence.get("role"))\n        visible = _text(evidence.get("visibleText"))\n        if not role or any(token in role for token in party_role_tokens):\n            continue\n        if not any(token in role for token in project_role_tokens):\n            continue\n        if not visible or not _same_project_street(merged["address"], visible):\n            continue\n        parsed = normalizer.parse_locality(visible)\n        locality_supported = bool(parsed and _candidate_matches(merged, parsed))\n        if not locality_supported:\n            tokens = {token.lower() for token in re.findall(r"[A-Za-z0-9]+", visible)}\n            city_tokens = {token.lower() for token in re.findall(r"[A-Za-z0-9]+", merged["city"])}\n            state_token = _text(merged["state"]).lower()\n            zip_token = _text(merged["zip"]).lower()\n            locality_supported = bool(city_tokens and city_tokens.issubset(tokens) and state_token in tokens and zip_token in tokens)\n        if locality_supported:\n            audit["votes"].append({"source": source, "method": "multimodal-project-evidence"})\n\n'''
    agent = agent.replace(anchor, insert + anchor, 1)

AGENT.write_text(agent, encoding='utf-8')

verify = VERIFY.read_text(encoding='utf-8')
if 'multimodal-project-evidence' not in verify:
    anchor = '''source = SOURCE.read_text(encoding="utf-8").upper()
'''
    if anchor not in verify:
        raise SystemExit('r96 verify insertion anchor missing')
    block = '''with tempfile.TemporaryDirectory(prefix="revex-r96-content-identity-no-text-layer-") as temp:\n    folder = Path(temp)\n    _facts, _facts_path, request_path, output, _texts = build_fixture(folder)\n\n    def evidence_only_agent(selected, _facts, base):\n        assert base["address"] == "250 Example Street"\n        return {\n            "title": "Example Residence",\n            "address": "250 Example Street",\n            "city": "Brooklyn",\n            "state": "NY",\n            "zip": "11225",\n            "confidence": 0.99,\n            "evidence": [\n                {"sourceFile": selected[0][1].name, "visibleText": "250 EXAMPLE STREET BROOKLYN, NY 11225", "role": "PROJECT TITLE BLOCK"},\n                {"sourceFile": selected[1][1].name, "visibleText": "250 EXAMPLE STREET, BROOKLYN, NY 11225", "role": "PROJECT INFORMATION"},\n            ],\n            "excludedPartyEvidence": ["CONSULTANT 99 OTHER ROAD, Troy, NY 12180"],\n        }\n\n    resolved = agent.resolve_request(\n        request_path,\n        output,\n        agent=evidence_only_agent,\n        pdf_text_loader=lambda _path: "",\n    )\n    assert resolved != request_path, "multimodal T/Z evidence must resolve identity when the PDF text layer is unavailable"\n    request = json.loads(resolved.read_text(encoding="utf-8"))\n    derived = json.loads(Path(request["pageFactsPath"]).read_text(encoding="utf-8"))\n    identity = derived["structuredIdentity"]\n    assert (identity["city"], identity["state"], identity["zip"]) == ("Brooklyn", "NY", "11225")\n    audit = json.loads((output / "PROJECT_IDENTITY_CONTENT_AGENT_R88.json").read_text(encoding="utf-8"))\n    evidence_votes = [row for row in audit["votes"] if row.get("method") == "multimodal-project-evidence"]\n    assert len({row["source"] for row in evidence_votes}) >= 2\n\n'''
    verify = verify.replace(anchor, block + anchor, 1)
    verify = verify.replace('    "twoSourceConsensus": True,\n', '    "twoSourceConsensus": True,\n    "multimodalEvidenceSurvivesMissingPdfTextLayer": True,\n', 1)

VERIFY.write_text(verify, encoding='utf-8')
print('REVEX_R96_AUTO_IDENTITY_PATCH=APPLIED')
