#!/usr/bin/env python3
"""Revision-scoped user context loader for WALLT Energy.

The immutable Engineering revision stays untouched. When a WALLT question was answered in
Companion, the answer lives on the same user's revision-scoped COMcheck authorization record.
The managed worker reads that one authenticated record and creates a derived request copy.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA = "liber.revex.energy-agent-context.v1"
VERSION = "20260818-wallt-context1"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _output_root(request_path: Path, request: dict) -> Path:
    raw = _text(request.get("outputFolder"))
    if raw:
        return Path(raw).resolve()
    parent = request_path.resolve().parent
    return parent.parent if parent.name.lower() in {"work", "input", "_input"} else parent


def _consent_identity(request: dict) -> tuple[str, str, str]:
    consent = dict(request.get("externalProcessingConsent") or {})
    return (
        _text(request.get("projectId")),
        _text(request.get("revision") or request.get("sourceEngineeringRevision")),
        _text(consent.get("approvedByUid")),
    )


def enrich_request(request_path: Path | None) -> Path | None:
    if request_path is None:
        return None
    source = Path(request_path).resolve()
    if not source.is_file():
        return source
    try:
        request = json.loads(source.read_text(encoding="utf-8"))
    except Exception:
        return source
    if _text(request.get("maintainerClarification")):
        return source

    project_id, revision, uid = _consent_identity(request)
    if not project_id or not revision or not uid:
        return source

    clarification = ""
    record_path = f"projects/{project_id}/revexEnergyConsents/{revision}/approvers/{uid}"
    try:
        from google.cloud import firestore
        snap = firestore.Client().document(record_path).get()
        if snap.exists:
            row = dict(snap.to_dict() or {})
            value = row.get("maintainerClarification")
            if isinstance(value, dict):
                clarification = _text(value.get("text") or value.get("message"))
            else:
                clarification = _text(value)
    except Exception as exc:
        # Clarification is optional context. Do not make a previously autonomous run depend on
        # Firestore; if WALLT still lacks evidence it will issue the same precise question.
        try:
            root = _output_root(source, request)
            root.mkdir(parents=True, exist_ok=True)
            (root / "REVEX_ENERGY_AGENT_CONTEXT.json").write_text(json.dumps({
                "schema": SCHEMA, "version": VERSION, "status": "UNAVAILABLE",
                "recordPath": record_path, "error": f"{type(exc).__name__}: {exc}",
                "sourceEvidenceMutated": False,
            }, ensure_ascii=True, indent=2), encoding="utf-8")
        except Exception:
            pass
        return source

    if not clarification:
        return source

    derived = dict(request)
    derived["maintainerClarification"] = clarification
    derived["maintainerClarificationAuthority"] = "REVISION_SCOPED_AUTHENTICATED_USER_RESPONSE"
    root = _output_root(source, request)
    root.mkdir(parents=True, exist_ok=True)
    out = root / "00_PIPELINE_REQUEST_WALLT_CONTEXT.json"
    out.write_text(json.dumps(derived, ensure_ascii=True, indent=2), encoding="utf-8")
    (root / "REVEX_ENERGY_AGENT_CONTEXT.json").write_text(json.dumps({
        "schema": SCHEMA, "version": VERSION, "status": "APPLIED",
        "recordPath": record_path, "clarificationBytes": len(clarification.encode("utf-8")),
        "authority": derived["maintainerClarificationAuthority"],
        "sourceRequest": source.name, "derivedRequest": out.name,
        "sourceEvidenceMutated": False,
    }, ensure_ascii=True, indent=2), encoding="utf-8")
    return out
