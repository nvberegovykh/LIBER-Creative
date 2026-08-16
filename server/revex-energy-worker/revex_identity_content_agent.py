#!/usr/bin/env python3
"""Content-aware current-project identity resolver for REVEX managed Energy.

This stage is deliberately separate from GeometryCo. It resolves only filing/project
identity from the immutable active-Revit T/Z evidence already published with one
Engineering revision. A multimodal model performs role-aware recognition across the
current T/Z sheets; deterministic validation then proves that the proposed locality
belongs to the authoritative project street and is repeated in current-project evidence.

Source artifacts are never mutated. Successful resolution writes a derived page-facts
copy consumed by the pinned Energy pipeline. Applicant/consultant/engineer addresses
are never accepted merely because they are present on the same sheet.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
from typing import Callable

import revex_energy_identity_normalizer as normalizer

SCHEMA = "liber.revex.project-identity-resolution.v1"
AGENT_VERSION = "20260816r96-content-identity2"
REQUIRED_IDENTITY = ("title", "address", "city", "state", "zip")
LOCATION_KEYS = ("city", "state", "zip")
MIN_AGENT_CONFIDENCE = 0.90
MAX_AGENT_PDFS = 4

AGENT_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": ["string", "null"]},
        "address": {"type": ["string", "null"]},
        "city": {"type": ["string", "null"]},
        "state": {"type": ["string", "null"]},
        "zip": {"type": ["string", "null"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sourceFile": {"type": "string"},
                    "visibleText": {"type": "string"},
                    "role": {"type": "string"},
                },
                "required": ["sourceFile", "visibleText", "role"],
            },
        },
        "excludedPartyEvidence": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "address", "city", "state", "zip", "confidence", "evidence", "excludedPartyEvidence"],
}


def _text(value) -> str:
    return str(value or "").strip()


def _norm(value) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _safe_name(value) -> str:
    name = Path(_text(value) or "artifact").name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def _best_page_value(facts: dict, key: str) -> str:
    rows = []
    for page in list(facts.get("pages") or []):
        if _text(page.get("pageType")).upper() not in {"T", "Z"}:
            continue
        value = _text((page.get("project") or {}).get(key))
        if value:
            rows.append((float(page.get("confidence") or 0), value))
    rows.sort(reverse=True)
    return rows[0][1] if rows else ""


def current_identity(facts: dict) -> dict[str, str]:
    structured = dict(facts.get("structuredIdentity") or {})
    identity = {
        key: _text(structured.get(key)) or _best_page_value(facts, key)
        for key in REQUIRED_IDENTITY
    }
    if not identity["city"]:
        identity["city"] = _text(structured.get("borough"))
    if not identity["address"]:
        house = _text(structured.get("houseNumber"))
        street = _text(structured.get("streetName"))
        identity["address"] = " ".join(part for part in (house, street) if part)
    if not identity["title"]:
        identity["title"] = identity["address"]
    return identity


def _structured_identity_complete(facts: dict) -> bool:
    """Skip the content agent only when verified native structured identity is complete.

    A page-agent value is intentionally not enough to short-circuit this stage: page scans
    can see applicant/consultant addresses on the same sheet and are precisely what this
    role-aware consensus stage exists to validate.
    """
    structured = dict(facts.get("structuredIdentity") or {})
    values = {key: _text(structured.get(key)) for key in REQUIRED_IDENTITY}
    if not values["city"]:
        values["city"] = _text(structured.get("borough"))
    if not values["address"]:
        values["address"] = " ".join(
            part for part in (_text(structured.get("houseNumber")), _text(structured.get("streetName"))) if part
        )
    if not values["title"]:
        values["title"] = values["address"]
    return all(values[key] for key in REQUIRED_IDENTITY)


def _pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
        return "\n".join((page.extract_text() or "") for page in PdfReader(str(path)).pages)
    except Exception:
        return ""


def _artifact_paths(request: dict) -> dict[str, Path]:
    output = {}
    for raw in list(request.get("sourceArtifacts") or []):
        path = Path(_text(raw))
        if path.is_file():
            output[_safe_name(path.name).lower()] = path
    return output


def _rank_tz_sources(facts: dict, artifacts: dict[str, Path]) -> list[tuple[dict, Path]]:
    rows = []
    for page in list(facts.get("pages") or []):
        discipline = _text(page.get("pageType")).upper()
        if discipline not in {"T", "Z"}:
            continue
        source = _safe_name(page.get("sourceFile") or "").lower()
        path = artifacts.get(source)
        if not path or path.suffix.lower() != ".pdf":
            continue
        hay = (_text(page.get("sheetNumber")) + " " + _text(page.get("sheetName"))).lower()
        score = 0
        if discipline == "T":
            score += 30
        if "cover" in hay or "project" in hay:
            score += 20
        if "zoning analysis" in hay or "map" in hay:
            score += 18
        if "z-001" in hay or "t-001" in hay:
            score += 15
        score += int(float(page.get("confidence") or 0) * 10)
        rows.append((score, source, page, path))
    rows.sort(key=lambda row: (-row[0], row[1]))
    selected = []
    seen = set()
    for _score, source, page, path in rows:
        if source in seen:
            continue
        seen.add(source)
        selected.append((page, path))
        if len(selected) >= MAX_AGENT_PDFS:
            break
    return selected


def _candidate_matches(candidate: dict, expected: dict) -> bool:
    for key in LOCATION_KEYS:
        left = _norm(candidate.get(key))
        right = _norm(expected.get(key))
        if not left or not right or left != right:
            return False
    return True


def _same_project_street(anchor: str, candidate: str) -> bool:
    if not anchor or not candidate:
        return False
    return normalizer.same_street(anchor, candidate) and normalizer.same_street(candidate, anchor)


def validate_agent_candidate(
    facts: dict,
    candidate: dict,
    pdf_text_by_name: dict[str, str],
) -> tuple[dict | None, dict]:
    """Validate one model proposal against immutable current-project evidence.

    The agent supplies role-aware interpretation; this function supplies the hard gate.
    At least two independent T/Z sources must bind the proposed locality to the same
    authoritative project street when two or more such sources are available.
    """
    base = current_identity(facts)
    merged = dict(base)
    for key in REQUIRED_IDENTITY:
        value = _text(candidate.get(key))
        if value:
            merged[key] = value

    confidence = float(candidate.get("confidence") or 0)
    audit = {
        "schema": SCHEMA,
        "agentVersion": AGENT_VERSION,
        "confidence": confidence,
        "baseIdentity": base,
        "candidate": {key: merged.get(key) for key in REQUIRED_IDENTITY},
        "votes": [],
        "rejected": [],
    }
    missing = [key for key in REQUIRED_IDENTITY if not _text(merged.get(key))]
    if missing:
        audit["rejected"].append("missing required identity: " + ", ".join(missing))
        return None, audit
    if confidence < MIN_AGENT_CONFIDENCE:
        audit["rejected"].append(f"agent confidence {confidence:.3f} below {MIN_AGENT_CONFIDENCE:.2f}")
        return None, audit

    anchor = _text((facts.get("structuredIdentity") or {}).get("address")) or _text(base.get("address"))
    if anchor and not _same_project_street(anchor, merged["address"]):
        audit["rejected"].append("agent address does not match authoritative active-Revit project street")
        return None, audit

    # Existing per-page AI extraction can vote when it already attached locality to the
    # correct project street. It is not authoritative by itself; it is one evidence arm.
    tz_source_names = set()
    for page in list(facts.get("pages") or []):
        if _text(page.get("pageType")).upper() not in {"T", "Z"}:
            continue
        source = _safe_name(page.get("sourceFile") or "").lower()
        if source:
            tz_source_names.add(source)
        project = dict(page.get("project") or {})
        page_address = _text(project.get("address")) or anchor
        if page_address and _same_project_street(merged["address"], page_address) and _candidate_matches(merged, project):
            audit["votes"].append({"source": source or _text(page.get("sheetNumber")), "method": "page-agent-project-fields"})

    # Deterministic text validation is the second arm. It only accepts locality found in
    # a bounded window around the verified project street, so consultant addresses later
    # on the page cannot satisfy this gate.
    for source, visible in pdf_text_by_name.items():
        if source.lower() not in tz_source_names:
            continue
        parsed = normalizer.locality_near_authoritative_address(visible, merged["address"])
        if parsed and _candidate_matches(merged, parsed):
            audit["votes"].append({"source": source, "method": "bounded-visible-project-street"})

    # The multimodal resolver saw the immutable PDF bytes even when the PDF text layer is
    # fragmented or absent. Its own evidence may therefore provide an independent source
    # vote, but only after deterministic role/street/locality checks. This breaks the
    # circular dependency on the earlier page parser without accepting consultant identity.
    party_role_tokens = ("architect", "engineer", "consultant", "applicant", "owner", "contractor", "vendor", "contact")
    project_role_tokens = ("project", "title block", "titleblock", "site", "property", "building")
    for evidence in list(candidate.get("evidence") or []):
        source = _safe_name(evidence.get("sourceFile") or "").lower()
        if not source or source not in tz_source_names:
            continue
        role = _norm(evidence.get("role"))
        visible = _text(evidence.get("visibleText"))
        if not role or any(token in role for token in party_role_tokens):
            continue
        if not any(token in role for token in project_role_tokens):
            continue
        if not visible or not _same_project_street(merged["address"], visible):
            continue
        parsed = normalizer.parse_locality(visible)
        locality_supported = bool(parsed and _candidate_matches(merged, parsed))
        if not locality_supported:
            tokens = {token.lower() for token in re.findall(r"[A-Za-z0-9]+", visible)}
            city_tokens = {token.lower() for token in re.findall(r"[A-Za-z0-9]+", merged["city"])}
            state_token = _text(merged["state"]).lower()
            zip_token = _text(merged["zip"]).lower()
            locality_supported = bool(city_tokens and city_tokens.issubset(tokens) and state_token in tokens and zip_token in tokens)
        if locality_supported:
            audit["votes"].append({"source": source, "method": "multimodal-project-evidence"})

    unique_sources = {row["source"] for row in audit["votes"] if row.get("source")}
    available = len(tz_source_names)
    required_votes = 2 if available >= 2 else 1
    audit["requiredVotes"] = required_votes
    audit["availableTZSources"] = available
    audit["uniqueVoteSources"] = len(unique_sources)
    if len(unique_sources) < required_votes:
        audit["rejected"].append(
            f"project identity locality had {len(unique_sources)} validated T/Z source vote(s); {required_votes} required"
        )
        return None, audit

    merged["state"] = merged["state"].upper()
    audit["status"] = "PASSED"
    audit["resolvedIdentity"] = {key: merged[key] for key in REQUIRED_IDENTITY}
    return merged, audit


def _run_content_agent(
    selected: list[tuple[dict, Path]],
    facts: dict,
    base: dict,
) -> dict:
    from google import genai
    from google.genai import types

    project = os.environ.get("REVEX_VERTEX_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
    if not project:
        return {}
    location = os.environ.get("REVEX_VERTEX_LOCATION", "global")
    model = os.environ.get("REVEX_PAGE_SCAN_MODEL", "gemini-2.5-flash")
    access_token = _text(os.environ.get("REVEX_VERTEX_ACCESS_TOKEN"))
    credentials = None
    if access_token:
        from google.oauth2.credentials import Credentials
        credentials = Credentials(access_token)

    page_summary = []
    for page, path in selected:
        page_summary.append({
            "sourceFile": path.name,
            "pageType": _text(page.get("pageType")),
            "sheetNumber": _text(page.get("sheetNumber")),
            "sheetName": _text(page.get("sheetName")),
            "priorExtractedProject": page.get("project") or {},
        })
    prompt = (
        "Resolve ONLY the current construction project's filing identity from these immutable Revit T/Z sheets. "
        "This is a role-separation task, not simple address extraction. Identify the address/title that belongs to the PROJECT/titleblock/project-information block and explicitly ignore addresses belonging to applicant, architect, engineer, consultant, owner, contractor, vendor or contact blocks. "
        "Use agreement across repeated titleblocks and project-information tables. Return the single project title, street-only address, city, two-letter state and ZIP. Do not use outside knowledge, geocoding, filenames, reference projects or template values. "
        "If evidence conflicts, choose only the identity repeatedly attached to PROJECT and lower confidence. Evidence rows must quote short visible text and name the source file. "
        f"Existing verified active-Revit identity anchor: {json.dumps(base, ensure_ascii=True)}. "
        f"Per-sheet metadata/prior extraction (non-authoritative hints): {json.dumps(page_summary, ensure_ascii=True)}"
    )
    contents = []
    for _page, path in selected:
        contents.append(types.Part.from_bytes(data=path.read_bytes(), mime_type="application/pdf"))
    contents.append(prompt)
    client = genai.Client(
        vertexai=True,
        project=project,
        location=location,
        credentials=credentials,
        http_options=types.HttpOptions(api_version="v1", timeout=120000),
    )
    try:
        response = client.models.generate_content(
            model=model,
            contents=contents,
            config={
                "temperature": 0,
                "response_mime_type": "application/json",
                "response_json_schema": AGENT_SCHEMA,
            },
        )
        if isinstance(getattr(response, "parsed", None), dict):
            return dict(response.parsed)
        return json.loads(response.text or "{}")
    finally:
        try:
            client.close()
        except Exception:
            pass


def resolve_request(
    request_path: Path,
    output_root: Path,
    *,
    agent: Callable[[list[tuple[dict, Path]], dict, dict], dict] | None = None,
    pdf_text_loader: Callable[[Path], str] = _pdf_text,
) -> Path:
    """Return original request or a derived request with validated content-aware identity."""
    request = json.loads(request_path.read_text(encoding="utf-8"))
    page_path = Path(_text(request.get("pageFactsPath")))
    if not page_path.is_file():
        return request_path
    facts = json.loads(page_path.read_text(encoding="utf-8"))
    base = current_identity(facts)
    if _structured_identity_complete(facts):
        return request_path

    artifacts = _artifact_paths(request)
    selected = _rank_tz_sources(facts, artifacts)
    if not selected:
        return request_path

    try:
        proposal = (agent or _run_content_agent)(selected, facts, base) or {}
    except Exception as exc:
        print(json.dumps({
            "stage": "PROJECT_IDENTITY_CONTENT_AGENT",
            "status": "UNAVAILABLE",
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=True), flush=True)
        return request_path

    pdf_text_by_name = {path.name.lower(): pdf_text_loader(path) for _page, path in selected}
    resolved_identity, audit = validate_agent_candidate(facts, proposal, pdf_text_by_name)
    audit["selectedSources"] = [path.name for _page, path in selected]
    audit["agentEvidence"] = list(proposal.get("evidence") or [])
    audit["excludedPartyEvidence"] = list(proposal.get("excludedPartyEvidence") or [])

    audit_path = output_root / "PROJECT_IDENTITY_CONTENT_AGENT_R88.json"
    audit_path.write_text(json.dumps(audit, ensure_ascii=True, indent=2), encoding="utf-8")
    if resolved_identity is None:
        print(json.dumps({
            "stage": "PROJECT_IDENTITY_CONTENT_AGENT",
            "status": "REJECTED",
            "rejected": audit.get("rejected"),
            "audit": audit_path.name,
        }, ensure_ascii=True), flush=True)
        return request_path

    derived = copy.deepcopy(facts)
    structured = dict(derived.get("structuredIdentity") or {})
    for key, value in resolved_identity.items():
        structured[key] = value
    derived["structuredIdentity"] = structured
    # Downstream r49 currently gives page fields precedence over structured identity. A
    # validated consensus therefore becomes the normalized projection on each derived T/Z
    # page as well. The immutable source page facts remain unchanged on disk.
    for page in list(derived.get("pages") or []):
        if _text(page.get("pageType")).upper() not in {"T", "Z"}:
            continue
        project = dict(page.get("project") or {})
        for key in REQUIRED_IDENTITY:
            project[key] = resolved_identity[key]
        page["project"] = project
    derived["identityResolution"] = {
        "schema": SCHEMA,
        "agentVersion": AGENT_VERSION,
        "authority": "content-aware-consensus-over-immutable-active-Revit-T-Z-evidence",
        "confidence": float(proposal.get("confidence") or 0),
        "resolvedIdentity": {key: resolved_identity[key] for key in REQUIRED_IDENTITY},
        "auditFile": audit_path.name,
    }

    facts_path = output_root / "00_PAGE_FACTS_CONTENT_IDENTITY_R88.json"
    facts_path.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    derived_request = dict(request)
    derived_request["pageFactsPath"] = str(facts_path)
    derived_request["identityContentResolution"] = derived["identityResolution"]
    request_copy = output_root / "00_PIPELINE_REQUEST_CONTENT_IDENTITY_R88.json"
    request_copy.write_text(json.dumps(derived_request, ensure_ascii=True, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "PROJECT_IDENTITY_CONTENT_AGENT",
        "status": "RESOLVED",
        "confidence": float(proposal.get("confidence") or 0),
        "votes": audit.get("uniqueVoteSources"),
        "title": resolved_identity["title"],
        "address": resolved_identity["address"],
        "city": resolved_identity["city"],
        "state": resolved_identity["state"],
        "zip": resolved_identity["zip"],
    }, ensure_ascii=True), flush=True)
    return request_copy
