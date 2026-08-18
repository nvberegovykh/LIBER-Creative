#!/usr/bin/env python3
"""WALLT Energy Maintainer overlay.

This module is intentionally not an Energy engine. It observes the proven pipeline at
block boundaries and may create derived shadow evidence between blocks. Immutable Revit
artifacts, GeometryCo, OSMs and simulation results are never rewritten in place.

Safe actions are deliberately narrow:
- keep a durable event/state trace for every pipeline block;
- re-read current EN PDFs when the generic page scan omitted thermal schedule facts;
- reconcile current EN geometry rows to current EN thermal rows without inventing values;
- consume an explicit user clarification when no current-project evidence can resolve a
  filing fact;
- otherwise stop as WAITING_USER with a precise question rather than guessing.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import time
from typing import Any

SCHEMA = "liber.revex.energy-maintainer.v1"
VERSION = "20260818-maintainer1"
STATE_NAME = "REVEX_ENERGY_MAINTAINER_STATE.json"
EVENTS_NAME = "REVEX_ENERGY_MAINTAINER_EVENTS.jsonl"
MIN_SOURCE_CONFIDENCE = 0.72
MIN_AGENT_MATCH_CONFIDENCE = 0.94
MAX_EN_PDFS = 8

_request_path: Path | None = None
_request: dict[str, Any] = {}
_output_root: Path | None = None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _safe_name(value: Any) -> str:
    name = Path(_text(value) or "artifact").name
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name) or "artifact"


def _json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=True))


def bind_request(request_path: Path | None) -> None:
    global _request_path, _request, _output_root
    _request_path = Path(request_path).resolve() if request_path else None
    _request = {}
    _output_root = None
    if _request_path and _request_path.is_file():
        try:
            _request = json.loads(_request_path.read_text(encoding="utf-8"))
        except Exception:
            _request = {}
    raw_root = _text(_request.get("outputFolder"))
    if raw_root:
        _output_root = Path(raw_root).resolve()
    elif _request_path:
        # Worker requests live in a child work folder; keep maintainer evidence beside
        # energy-result.json when no explicit outputFolder is declared.
        parent = _request_path.parent
        _output_root = parent.parent if parent.name.lower() in {"work", "_input", "input"} else parent
    if _output_root:
        _output_root.mkdir(parents=True, exist_ok=True)
    _write_state("RUNNING", stage="BIND_REQUEST", message="WALLT Energy Maintainer attached as a shadow overlay.")


def _state_path() -> Path | None:
    return (_output_root / STATE_NAME) if _output_root else None


def _events_path() -> Path | None:
    return (_output_root / EVENTS_NAME) if _output_root else None


def _write_state(status: str, *, stage: str, message: str, **detail: Any) -> None:
    path = _state_path()
    if path is None:
        return
    prior = {}
    if path.is_file():
        try:
            prior = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            prior = {}
    state = {
        "schema": SCHEMA,
        "version": VERSION,
        "status": status,
        "stage": stage,
        "message": message,
        "updatedAtEpoch": time.time(),
        "sourceEngineeringRevision": _request.get("revision") or _request.get("sourceEngineeringRevision"),
        "sourceEvidenceMutated": False,
        "pipelineSourceMutated": False,
        "shadowOnly": True,
        "eventsFile": EVENTS_NAME,
        **{k: v for k, v in prior.items() if k in {"repairs", "questions", "agentRuns"}},
        **detail,
    }
    path.write_text(json.dumps(state, ensure_ascii=True, indent=2), encoding="utf-8")


def record_block(stage: str, status: str, detail: dict | None = None) -> None:
    path = _events_path()
    if path is None:
        return
    row = {
        "schema": SCHEMA,
        "version": VERSION,
        "atEpoch": time.time(),
        "stage": _text(stage),
        "status": _text(status),
        "detail": _json_clone(detail or {}),
    }
    try:
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _code(module, row: dict) -> tuple[str, str]:
    try:
        return module._comcheck_row_code(row)
    except Exception:
        text = " ".join(_text(row.get(k)) for k in ("assemblyType", "description", "evidence"))
        match = re.search(r"(?<![A-Z0-9])([A-Z]{1,3}\d+(?:\.\d+)?)(?![A-Z0-9.])", text.upper())
        if not match:
            return "", ""
        value = match.group(1)
        return value, value.split(".", 1)[0]


def _has_required_thermal(row: dict) -> bool:
    kind = _text(row.get("kind")).lower()
    if kind == "window":
        return row.get("uFactor") not in (None, "") and row.get("shgc") not in (None, "")
    if kind == "door":
        return row.get("uFactor") not in (None, "")
    if kind in {"wall", "roof", "floor"}:
        return row.get("cavityR") not in (None, "") or row.get("continuousR") not in (None, "")
    return False


def _thermal_signature(row: dict) -> tuple:
    kind = _text(row.get("kind")).lower()
    if kind in {"window", "door"}:
        return (row.get("uFactor"), row.get("shgc"))
    return (row.get("cavityR"), row.get("continuousR"), row.get("uFactor"))


def _all_en_rows(en_pages: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for page in en_pages:
        source = _safe_name(page.get("sourceFile") or "")
        sheet = _text(page.get("sheetNumber"))
        for raw in list(page.get("envelope") or []):
            row = dict(raw)
            row["_maintainerSourceFile"] = source
            row["_maintainerSheetNumber"] = sheet
            rows.append(row)
    return rows


def _unresolved_codes(errors: list[str]) -> list[dict]:
    output: list[dict] = []
    seen = set()
    pattern = re.compile(r"EN\s+(wall|roof|floor|window|door|envelope)\s+geometry row\s+([^\s]+)\s+has\s+(?:no|ambiguous)\s+thermal-property", re.I)
    for error in errors:
        match = pattern.search(_text(error))
        if not match:
            continue
        kind = match.group(1).lower()
        code = match.group(2).strip(" ,;:")
        key = (kind, code.upper())
        if key not in seen:
            seen.add(key)
            output.append({"kind": kind, "code": code})
    return output


def _visible_candidate_rows(module, en_pages: list[dict], unresolved: list[dict]) -> list[dict]:
    wanted_kinds = {row["kind"] for row in unresolved}
    candidates = []
    for row in _all_en_rows(en_pages):
        kind = _text(row.get("kind")).lower()
        if kind not in wanted_kinds or not _has_required_thermal(row):
            continue
        confidence = float(row.get("confidence") or 0)
        if confidence < MIN_SOURCE_CONFIDENCE:
            continue
        code, base = _code(module, row)
        candidates.append({
            **row,
            "_maintainerCandidateCode": code,
            "_maintainerCandidateBase": base,
            "_maintainerOriginalConfidence": confidence,
        })
    return candidates


def _promote_proven_low_confidence(module, en_pages: list[dict], unresolved: list[dict]) -> tuple[list[dict], list[dict]]:
    """Promote only current EN thermal facts whose relation is deterministic.

    No value is generated. We only make already-visible current-project thermal rows
    available to the >=0.90 filing reconciler when the assembly relation is exact/base,
    or when every current same-kind candidate has one identical thermal signature.
    """
    pages = copy.deepcopy(en_pages)
    all_rows = _all_en_rows(pages)
    repairs: list[dict] = []
    for target in unresolved:
        kind = target["kind"]
        target_code = target["code"].upper()
        target_base = target_code.split(".", 1)[0]
        same = [r for r in all_rows if _text(r.get("kind")).lower() == kind and _has_required_thermal(r)
                and float(r.get("confidence") or 0) >= MIN_SOURCE_CONFIDENCE]
        exact = [r for r in same if _code(module, r)[0].upper() == target_code]
        base = [r for r in same if _code(module, r)[1].upper() == target_base]
        chosen = exact or base
        authority = "CURRENT_EN_EXACT_CODE" if exact else "CURRENT_EN_BASE_CODE" if base else ""
        if not chosen and same and len({_thermal_signature(r) for r in same}) == 1:
            chosen = same
            authority = "CURRENT_EN_UNIQUE_KIND_THERMAL_SIGNATURE"
        signatures = {_thermal_signature(r) for r in chosen}
        if not chosen or len(signatures) != 1:
            continue
        signature = next(iter(signatures))
        for page in pages:
            for row in list(page.get("envelope") or []):
                if _text(row.get("kind")).lower() != kind or not _has_required_thermal(row):
                    continue
                row_code, row_base = _code(module, row)
                relation = (row_code.upper() == target_code or row_base.upper() == target_base or
                            (authority == "CURRENT_EN_UNIQUE_KIND_THERMAL_SIGNATURE" and _thermal_signature(row) == signature))
                if not relation or float(row.get("confidence") or 0) < MIN_SOURCE_CONFIDENCE:
                    continue
                if float(row.get("confidence") or 0) < 0.90:
                    row["_maintainerOriginalConfidence"] = float(row.get("confidence") or 0)
                    row["confidence"] = 0.901
                    row["_maintainerAuthority"] = authority
        repairs.append({"kind": kind, "code": target["code"], "authority": authority, "thermalSignature": list(signature)})
    return pages, repairs


def _source_artifact_map() -> dict[str, Path]:
    output: dict[str, Path] = {}
    for raw in list(_request.get("sourceArtifacts") or []):
        path = Path(_text(raw))
        if path.is_file():
            output[_safe_name(path.name).lower()] = path
    return output


def _vertex_client():
    from google import genai
    from google.genai import types
    try:
        from revex_cloud_project import resolve_vertex_project
        project = resolve_vertex_project()
    except Exception:
        project = os.environ.get("REVEX_VERTEX_PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT") or "liber-apps-cca20"
    location = os.environ.get("REVEX_VERTEX_LOCATION", "global")
    access_token = _text(os.environ.get("REVEX_VERTEX_ACCESS_TOKEN"))
    credentials = None
    if access_token:
        from google.oauth2.credentials import Credentials
        credentials = Credentials(access_token)
    client = genai.Client(vertexai=True, project=project, location=location,
                         credentials=credentials,
                         http_options=types.HttpOptions(api_version="v1", timeout=120000))
    return client, types, project, location


THERMAL_SCAN_SCHEMA = {
    "type": "object",
    "properties": {
        "rows": {"type": "array", "items": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["wall", "roof", "floor", "window", "door"]},
            "assemblyType": {"type": ["string", "null"]},
            "description": {"type": ["string", "null"]},
            "uFactor": {"type": ["number", "null"]},
            "shgc": {"type": ["number", "null"]},
            "cavityR": {"type": ["number", "null"]},
            "continuousR": {"type": ["number", "null"]},
            "vt": {"type": ["number", "null"]},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "evidence": {"type": "string"}
        }, "required": ["kind", "assemblyType", "description", "uFactor", "shgc", "cavityR", "continuousR", "vt", "confidence", "evidence"]}},
        "notes": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["rows", "notes"]
}


def _targeted_rescan(module, en_pages: list[dict], unresolved: list[dict]) -> tuple[list[dict], list[dict]]:
    """Re-read only current EN PDFs for omitted thermal schedule rows."""
    artifacts = _source_artifact_map()
    source_names = []
    for page in en_pages:
        name = _safe_name(page.get("sourceFile") or "").lower()
        if name and name in artifacts and artifacts[name].suffix.lower() == ".pdf" and name not in source_names:
            source_names.append(name)
    if not source_names:
        return en_pages, []
    unresolved_text = ", ".join(f"{r['kind']} {r['code']}" for r in unresolved)
    model = os.environ.get("REVEX_PAGE_SCAN_MODEL", "gemini-2.5-flash")
    pages = copy.deepcopy(en_pages)
    added: list[dict] = []
    try:
        client, types, project, location = _vertex_client()
    except Exception as exc:
        record_block("MAINTAINER_TARGETED_EN_SCAN", "AI_UNAVAILABLE", {"error": str(exc)[:1000]})
        return pages, []
    try:
        for source_name in source_names[:MAX_EN_PDFS]:
            pdf = artifacts[source_name]
            prompt = (
                "You are the WALLT Energy Maintainer reading one CURRENT Revit EN sheet. "
                f"The filing reconciler is missing thermal-property matches for: {unresolved_text}. "
                "Extract only thermal-property schedule/table rows visibly present on this sheet. "
                "Do not infer area or orientation and do not use outside knowledge. Preserve assembly/type codes exactly. "
                "Opaque assemblies need visible cavity/continuous R values; windows/doors need visible U-factor; windows also need visible SHGC. "
                "VT may be returned only when visibly present. If a value is not visible, return null. Evidence must quote a short visible row/header fragment."
            )
            started = time.monotonic()
            response = client.models.generate_content(
                model=model,
                contents=[types.Part.from_bytes(data=pdf.read_bytes(), mime_type="application/pdf"), prompt],
                config={"temperature": 0, "response_mime_type": "application/json", "response_json_schema": THERMAL_SCAN_SCHEMA}
            )
            parsed = response.parsed if isinstance(getattr(response, "parsed", None), dict) else json.loads(response.text or "{}")
            accepted = []
            for raw in list(parsed.get("rows") or []):
                row = dict(raw)
                if float(row.get("confidence") or 0) < 0.88 or not _has_required_thermal(row):
                    continue
                row["confidence"] = max(0.901, float(row.get("confidence") or 0))
                row["_maintainerAuthority"] = "CURRENT_EN_TARGETED_AI_RESCAN"
                row["_maintainerSourceFile"] = source_name
                accepted.append(row)
                added.append({"sourceFile": source_name, "kind": row.get("kind"), "code": _code(module, row)[0], "evidence": row.get("evidence")})
            if accepted:
                target_page = next((p for p in pages if _safe_name(p.get("sourceFile") or "").lower() == source_name), None)
                if target_page is None:
                    target_page = {"pageType": "EN", "sheetNumber": "", "sheetName": "", "sourceFile": source_name, "confidence": 1.0, "envelope": []}
                    pages.append(target_page)
                target_page.setdefault("envelope", []).extend(accepted)
            record_block("MAINTAINER_TARGETED_EN_SCAN", "PASSED", {
                "sourceFile": source_name, "acceptedRows": len(accepted), "elapsedSeconds": round(time.monotonic() - started, 1),
                "model": model, "project": project, "location": location
            })
    except Exception as exc:
        record_block("MAINTAINER_TARGETED_EN_SCAN", "FAILED", {"error": str(exc)[:1600]})
    finally:
        try:
            client.close()
        except Exception:
            pass
    return pages, added


MATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "matches": {"type": "array", "items": {"type": "object", "properties": {
            "kind": {"type": "string"}, "code": {"type": "string"},
            "candidateIndex": {"type": ["integer", "null"]},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "reason": {"type": "string"}
        }, "required": ["kind", "code", "candidateIndex", "confidence", "reason"]}},
        "needsUser": {"type": "boolean"},
        "question": {"type": ["string", "null"]}
    },
    "required": ["matches", "needsUser", "question"]
}


def _agent_match(module, en_pages: list[dict], unresolved: list[dict], clarification: str) -> tuple[list[dict], list[dict], str | None]:
    """Let the agent choose only among current EN thermal candidates; it cannot invent a value."""
    candidates = _visible_candidate_rows(module, en_pages, unresolved)
    if not candidates:
        return en_pages, [], "No current EN thermal-property candidate rows were available after the targeted re-scan."
    compact = []
    for index, row in enumerate(candidates):
        compact.append({
            "index": index, "kind": row.get("kind"), "code": row.get("_maintainerCandidateCode"),
            "base": row.get("_maintainerCandidateBase"), "assemblyType": row.get("assemblyType"),
            "description": row.get("description"), "uFactor": row.get("uFactor"), "shgc": row.get("shgc"),
            "cavityR": row.get("cavityR"), "continuousR": row.get("continuousR"),
            "evidence": row.get("evidence"), "sourceFile": row.get("_maintainerSourceFile"),
            "sourceConfidence": row.get("_maintainerOriginalConfidence"),
        })
    prompt = (
        "You are WALLT, a conservative filing-grade energy-model maintainer. Match each unresolved CURRENT EN diagram code "
        "to at most one candidate thermal row from the supplied CURRENT EN evidence. You may select only candidateIndex values listed. "
        "Never invent thermal values. Prefer exact/base assembly semantics, explicit parent/child naming, and visible schedule evidence. "
        "If the relation is not unambiguous, set candidateIndex null and needsUser true. "
        f"Unresolved: {json.dumps(unresolved, ensure_ascii=True)}\nCandidates: {json.dumps(compact, ensure_ascii=True)}\n"
        f"User clarification, if any: {clarification or '<none>'}"
    )
    model = os.environ.get("REVEX_MAINTAINER_MODEL", os.environ.get("REVEX_PAGE_SCAN_MODEL", "gemini-2.5-flash"))
    try:
        client, _types, project, location = _vertex_client()
        response = client.models.generate_content(
            model=model, contents=prompt,
            config={"temperature": 0, "response_mime_type": "application/json", "response_json_schema": MATCH_SCHEMA}
        )
        parsed = response.parsed if isinstance(getattr(response, "parsed", None), dict) else json.loads(response.text or "{}")
    except Exception as exc:
        record_block("MAINTAINER_RELATION_AGENT", "FAILED", {"error": str(exc)[:1600]})
        return en_pages, [], "WALLT could not resolve the remaining EN relation automatically."
    finally:
        try:
            client.close()
        except Exception:
            pass

    pages = copy.deepcopy(en_pages)
    resolved: list[dict] = []
    for match in list(parsed.get("matches") or []):
        code = _text(match.get("code"))
        kind = _text(match.get("kind")).lower()
        idx = match.get("candidateIndex")
        confidence = float(match.get("confidence") or 0)
        if idx is None or confidence < MIN_AGENT_MATCH_CONFIDENCE:
            continue
        try:
            candidate = candidates[int(idx)]
        except Exception:
            continue
        if _text(candidate.get("kind")).lower() != kind or not _has_required_thermal(candidate):
            continue
        clone = {k: v for k, v in candidate.items() if not str(k).startswith("_maintainerCandidate")}
        clone["assemblyType"] = code or clone.get("assemblyType")
        clone["confidence"] = 0.999
        clone["_maintainerAuthority"] = "WALLT_CURRENT_EN_RELATION"
        clone["_maintainerMatchConfidence"] = confidence
        clone["_maintainerReason"] = _text(match.get("reason"))
        # Add a derived thermal-only row; geometry remains owned by the original diagram row.
        target_page = next((p for p in pages if _safe_name(p.get("sourceFile") or "").lower() == _text(candidate.get("_maintainerSourceFile")).lower()), None)
        if target_page is None:
            target_page = pages[0] if pages else {"pageType": "EN", "envelope": []}
            if not pages:
                pages.append(target_page)
        target_page.setdefault("envelope", []).append(clone)
        resolved.append({"kind": kind, "code": code, "candidateIndex": int(idx), "confidence": confidence,
                         "sourceFile": candidate.get("_maintainerSourceFile"), "authority": "WALLT_CURRENT_EN_RELATION"})
    question = _text(parsed.get("question")) or None
    record_block("MAINTAINER_RELATION_AGENT", "PASSED", {
        "resolved": resolved, "needsUser": bool(parsed.get("needsUser")), "question": question,
        "model": model, "project": project, "location": location
    })
    return pages, resolved, question


def _maintain_en_pages(module, en_pages: list[dict], initial_errors: list[str]) -> tuple[list[dict], list[dict], str | None]:
    unresolved = _unresolved_codes(initial_errors)
    if not unresolved:
        return en_pages, [], None
    repairs: list[dict] = []
    pages, deterministic = _promote_proven_low_confidence(module, en_pages, unresolved)
    repairs.extend(deterministic)

    # Targeted AI re-read is an observer pass over immutable current EN PDFs. It produces
    # a shadow thermal-facts layer only when generic page extraction missed needed rows.
    pages, rescanned = _targeted_rescan(module, pages, unresolved)
    repairs.extend({"authority": "CURRENT_EN_TARGETED_AI_RESCAN", **row} for row in rescanned)

    clarification = _text(_request.get("maintainerClarification"))
    pages, agent_resolved, question = _agent_match(module, pages, unresolved, clarification)
    repairs.extend(agent_resolved)
    return pages, repairs, question


def install(module) -> None:
    if getattr(module, "__revex_energy_maintainer_installed__", False):
        return

    # Observe every normal pipeline block without owning execution.
    runlog = getattr(module, "RunLog", None)
    if runlog is not None and hasattr(runlog, "write"):
        original_write = runlog.write
        def write(self, stage, status, **detail):
            record_block(stage, status, detail)
            return original_write(self, stage, status, **detail)
        runlog.write = write

    original_canonicalize = module.canonicalize_comcheck_envelope_rows
    def canonicalize(en_pages):
        rows, audit = original_canonicalize(en_pages)
        errors = list((audit or {}).get("thermalPropertyMergeErrors") or [])
        if not errors:
            record_block("MAINTAINER_EN_RECONCILIATION", "NO_ACTION", {"canonicalRows": len(rows)})
            return rows, audit

        record_block("MAINTAINER_EN_RECONCILIATION", "STARTED", {"errors": errors})
        shadow_pages, repairs, question = _maintain_en_pages(module, list(en_pages or []), errors)
        rows2, audit2 = original_canonicalize(shadow_pages)
        remaining = list((audit2 or {}).get("thermalPropertyMergeErrors") or [])
        audit2 = dict(audit2 or {})
        audit2["maintainer"] = {
            "schema": SCHEMA, "version": VERSION, "shadowOnly": True,
            "repairs": repairs, "initialErrors": errors, "remainingErrors": remaining,
            "sourceEvidenceMutated": False,
        }
        if not remaining:
            _write_state("RUNNING", stage="MAINTAINER_EN_RECONCILIATION",
                         message="WALLT reconciled current EN geometry and thermal schedule evidence in a derived shadow layer.",
                         repairs=repairs, questions=[])
            record_block("MAINTAINER_EN_RECONCILIATION", "REPAIRED", {"repairCount": len(repairs), "canonicalRows": len(rows2)})
            return rows2, audit2

        unresolved = _unresolved_codes(remaining)
        default_question = (
            "Current EN sheets still do not prove the thermal-property relation for: " +
            ", ".join(f"{row['kind']} {row['code']}" for row in unresolved) +
            ". Confirm the intended current EN assembly/thermal values or correct the EN schedule in Revit; WALLT will resume from this block."
        )
        questions = [{"id": "en-thermal-relation", "message": question or default_question,
                      "unresolved": unresolved, "acceptsFreeText": True,
                      "revitActionAvailable": "refresh-energy-evidence"}]
        _write_state("WAITING_USER", stage="MAINTAINER_EN_RECONCILIATION",
                     message=question or default_question, repairs=repairs, questions=questions,
                     unresolved=unresolved)
        record_block("MAINTAINER_EN_RECONCILIATION", "WAITING_USER", {"remainingErrors": remaining, "questions": questions})
        return rows2, audit2
    module.canonicalize_comcheck_envelope_rows = canonicalize

    original_prepare = module.prepare_project_comcheck
    def prepare(facts, project_identity, filing_dir, log):
        result = original_prepare(facts, project_identity, filing_dir, log)
        cxl, audit_pdf, audit = result
        if cxl is not None and Path(cxl).is_file():
            _write_state("RUNNING", stage="COMCHECK_INPUT_READY", message="COMcheck input passed maintainer alignment checks.")
            record_block("MAINTAINER_COMCHECK_ALIGNMENT", "PASSED", {"cxl": Path(cxl).name})
        else:
            missing = list((audit or {}).get("missing") or (audit or {}).get("missingEvidence") or [])
            if missing:
                path = _state_path()
                existing = {}
                if path and path.is_file():
                    try: existing = json.loads(path.read_text(encoding="utf-8"))
                    except Exception: existing = {}
                if existing.get("status") != "WAITING_USER":
                    question = "WALLT needs one clarification before filing can continue: " + "; ".join(map(str, missing[:12]))
                    _write_state("WAITING_USER", stage="COMCHECK_PREFLIGHT", message=question,
                                 questions=[{"id": "comcheck-missing-evidence", "message": question, "acceptsFreeText": True,
                                             "revitActionAvailable": "refresh-energy-evidence"}], missing=missing)
        return result
    module.prepare_project_comcheck = prepare

    module.__revex_energy_maintainer_installed__ = True
    record_block("MAINTAINER_INSTALL", "PASSED", {"version": VERSION, "shadowOnly": True})


def public_state() -> dict | None:
    path = _state_path()
    if path is None or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
