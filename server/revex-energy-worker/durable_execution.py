#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from flask import jsonify, make_response, request
from google.cloud import firestore, storage

HEARTBEAT_SECONDS = 15
LEASE_SECONDS = 120
CACHE_NAME = "worker-response.json"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp(value):
    if isinstance(value, datetime):
        return value
    return None


def _fresh_worker(data: dict) -> bool:
    heartbeat = _timestamp(data.get("workerHeartbeatAt"))
    lease = _timestamp(data.get("workerLeaseExpiresAt"))
    now = _utcnow()
    if lease and lease > now:
        return True
    return bool(heartbeat and (now - heartbeat).total_seconds() <= LEASE_SECONDS)


def _source_candidate() -> str:
    return str(os.environ.get("REVEX_SOURCE_CANDIDATE") or "").strip()


def _cache_path(output_prefix: str, source_candidate: str) -> str:
    token = "".join(ch for ch in str(source_candidate or "").lower() if ch.isalnum())[:40]
    name = f"worker-response.{token}.json" if token else CACHE_NAME
    return f"{output_prefix.rstrip('/')}/{name}"


def _response_source_candidate(body: dict) -> str:
    return str((body.get("manifest") or {}).get("sourceCandidate") or body.get("sourceCandidate") or "").strip()


def _pipeline_status(body: dict) -> str:
    return str((body.get("manifest") or {}).get("status") or body.get("status") or "UNKNOWN").strip().upper()


def _pipeline_error(body: dict, status: str = "") -> str:
    manifest = body.get("manifest") or {}
    return str(manifest.get("error") or body.get("error") or body.get("message") or f"Energy pipeline status is {status or _pipeline_status(body)}.").strip()


def _load_cached_response(bucket, path: str, project_id: str, source_revision: str, source_candidate: str):
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    try:
        body = json.loads(blob.download_as_text(encoding="utf-8"))
    except Exception:
        return None
    if not (
        body.get("schema") == "liber.revex.energy-server-response.v1"
        and str(body.get("projectId") or "") == project_id
        and str(body.get("sourceRevision") or "") == source_revision
    ):
        return None
    # A worker result is derived output, not source evidence. Reuse it only when the
    # exact worker source candidate matches the currently deployed worker. A new worker
    # fix therefore replays the same immutable Engineering revision instead of being
    # trapped behind an obsolete cached downstream result.
    current = str(source_candidate or "").strip()
    cached_source = _response_source_candidate(body)
    if current and cached_source != current:
        return None
    return body


def _store_cached_response(bucket, path: str, body: dict) -> None:
    blob = bucket.blob(path)
    blob.upload_from_string(
        json.dumps(body, ensure_ascii=True, separators=(",", ":")),
        content_type="application/json",
    )


def _record_cached_terminal(job_ref, *, cache_path: str, body: dict, source_candidate: str) -> None:
    status = _pipeline_status(body)
    if status == "COMPLETE":
        job_ref.set({
            "workerStatus": "COMPLETE",
            "workerStage": "WORKER_COMPLETE_CACHED",
            "workerResponsePath": cache_path,
            "workerSourceCandidate": source_candidate or None,
            "workerPipelineStatus": status,
            "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
            "workerRecoveredFromCache": True,
            "workerFailure": firestore.DELETE_FIELD,
        }, merge=True)
        return
    job_ref.set({
        "workerStatus": "FAILED",
        "workerStage": "PIPELINE_TERMINAL_CACHED",
        "workerResponsePath": cache_path,
        "workerSourceCandidate": source_candidate or None,
        "workerPipelineStatus": status,
        "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
        "workerRecoveredFromCache": True,
        "workerFailure": _pipeline_error(body, status)[:4000],
        "workerLeaseExpiresAt": firestore.DELETE_FIELD,
    }, merge=True)


def install_durable_energy_execution(app) -> None:
    """Wrap the existing r49 /run handler without changing the Energy pipeline.

    One immutable Engineering revision owns one worker lease. The wrapper writes a
    durable Firestore heartbeat while the existing synchronous r49 pipeline runs and
    caches the final server response in the same Storage result prefix. Cached derived
    results are source-candidate-bound: deploying a corrected worker may replay the
    exact same immutable revision, but never silently reuse output from older code.
    """
    endpoint = "run_energy"
    original = app.view_functions.get(endpoint)
    if original is None or getattr(original, "__revex_r114_durable__", False):
        return

    def durable_run_energy():
        data = request.get_json(silent=True) or {}
        project_id = str(data.get("projectId") or "").strip()
        source_revision = str(data.get("sourceRevision") or "").strip()
        bucket_name = str(data.get("bucket") or "").strip()
        output_prefix = str(data.get("outputPrefix") or "").strip().strip("/")
        if not project_id or not source_revision or not bucket_name or not output_prefix:
            return original()

        source_candidate = _source_candidate()
        # Bind cloud clients only inside the live request. Docker/import QA therefore
        # stays credential-free while Cloud Run receives ADC through its service account.
        db = firestore.Client()
        storage_client = storage.Client()
        job_ref = db.document(f"projects/{project_id}/revexEnergyJobs/{source_revision}")
        bucket = storage_client.bucket(bucket_name)
        cache_path = _cache_path(output_prefix, source_candidate)

        cached = _load_cached_response(bucket, cache_path, project_id, source_revision, source_candidate)
        if cached is not None:
            _record_cached_terminal(job_ref, cache_path=cache_path, body=cached, source_candidate=source_candidate)
            return jsonify(cached), 200

        run_id = f"worker-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        transaction = db.transaction()

        @firestore.transactional
        def claim(txn):
            snap = job_ref.get(transaction=txn)
            state = snap.to_dict() if snap.exists else {}
            state_source = str(state.get("workerSourceCandidate") or "").strip()
            if (
                str(state.get("workerStatus") or "").upper() == "COMPLETE"
                and state.get("workerResponsePath")
                and state_source == source_candidate
            ):
                return "COMPLETE", state
            # Never duplicate a genuinely live worker, even during a rolling release.
            if str(state.get("workerStatus") or "").upper() == "RUNNING" and _fresh_worker(state):
                return "RUNNING", state
            now = _utcnow()
            txn.set(job_ref, {
                "workerStatus": "RUNNING",
                "workerStage": "WORKER_LEASE_CLAIMED",
                "workerRunId": run_id,
                "workerSourceCandidate": source_candidate or None,
                "workerPipelineStatus": firestore.DELETE_FIELD,
                "workerHeartbeatAt": now,
                "workerLeaseExpiresAt": now + timedelta(seconds=LEASE_SECONDS),
                "workerStartedAt": now,
                "workerResponsePath": cache_path,
                "workerFailure": firestore.DELETE_FIELD,
                "workerRecoveredFromCache": firestore.DELETE_FIELD,
            }, merge=True)
            return "CLAIMED", {}

        disposition, state = claim(transaction)
        if disposition == "COMPLETE":
            cached = _load_cached_response(
                bucket,
                str(state.get("workerResponsePath") or cache_path),
                project_id,
                source_revision,
                source_candidate,
            )
            if cached is not None:
                _record_cached_terminal(job_ref, cache_path=str(state.get("workerResponsePath") or cache_path), body=cached, source_candidate=source_candidate)
                return jsonify(cached), 200
            # A legacy/mismatched COMPLETE marker without a valid current-source cache is
            # stale derived state. Claim the same immutable revision for this worker source.
            now = _utcnow()
            job_ref.set({
                "workerStatus": "RUNNING",
                "workerStage": "WORKER_STALE_CACHE_REPLAY",
                "workerRunId": run_id,
                "workerSourceCandidate": source_candidate or None,
                "workerHeartbeatAt": now,
                "workerLeaseExpiresAt": now + timedelta(seconds=LEASE_SECONDS),
                "workerStartedAt": now,
                "workerResponsePath": cache_path,
                "workerFailure": firestore.DELETE_FIELD,
            }, merge=True)
        if disposition == "RUNNING":
            return jsonify({
                "schema": "liber.revex.energy-worker-async.v1",
                "projectId": project_id,
                "sourceRevision": source_revision,
                "status": "RUNNING",
                "workerRunId": str(state.get("workerRunId") or ""),
                "workerStage": str(state.get("workerStage") or "WORKER_RUNNING"),
            }), 202

        stop = threading.Event()

        def heartbeat() -> None:
            while not stop.wait(HEARTBEAT_SECONDS):
                now = _utcnow()
                try:
                    job_ref.set({
                        "workerStatus": "RUNNING",
                        "workerStage": "WORKER_EXECUTION",
                        "workerRunId": run_id,
                        "workerSourceCandidate": source_candidate or None,
                        "workerHeartbeatAt": now,
                        "workerLeaseExpiresAt": now + timedelta(seconds=LEASE_SECONDS),
                    }, merge=True)
                except Exception as exc:
                    print(json.dumps({
                        "stage": "DURABLE_HEARTBEAT_FAILED",
                        "projectId": project_id,
                        "sourceRevision": source_revision,
                        "workerRunId": run_id,
                        "error": str(exc),
                    }), flush=True)

        thread = threading.Thread(target=heartbeat, name="revex-energy-durable-heartbeat", daemon=True)
        thread.start()
        try:
            response = make_response(original())
            body = response.get_json(silent=True)
            if response.status_code < 400 and isinstance(body, dict) and body.get("schema") == "liber.revex.energy-server-response.v1":
                _store_cached_response(bucket, cache_path, body)
                pipeline_status = _pipeline_status(body)
                if pipeline_status == "COMPLETE":
                    job_ref.set({
                        "workerStatus": "COMPLETE",
                        "workerStage": "WORKER_COMPLETE",
                        "workerRunId": run_id,
                        "workerSourceCandidate": source_candidate or None,
                        "workerPipelineStatus": pipeline_status,
                        "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                        "workerLeaseExpiresAt": firestore.DELETE_FIELD,
                        "workerResponsePath": cache_path,
                        "workerFailure": firestore.DELETE_FIELD,
                        "workerFinishedAt": firestore.SERVER_TIMESTAMP,
                    }, merge=True)
                else:
                    job_ref.set({
                        "workerStatus": "FAILED",
                        "workerStage": "PIPELINE_TERMINAL",
                        "workerRunId": run_id,
                        "workerSourceCandidate": source_candidate or None,
                        "workerPipelineStatus": pipeline_status,
                        "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                        "workerLeaseExpiresAt": firestore.DELETE_FIELD,
                        "workerResponsePath": cache_path,
                        "workerFailure": _pipeline_error(body, pipeline_status)[:4000],
                        "workerFinishedAt": firestore.SERVER_TIMESTAMP,
                    }, merge=True)
            else:
                error = "worker returned HTTP %s" % response.status_code
                if isinstance(body, dict):
                    error = str(body.get("error") or body.get("message") or error)
                job_ref.set({
                    "workerStatus": "FAILED",
                    "workerStage": str(body.get("stage") if isinstance(body, dict) else "WORKER_RESPONSE_FAILED") or "WORKER_RESPONSE_FAILED",
                    "workerRunId": run_id,
                    "workerSourceCandidate": source_candidate or None,
                    "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                    "workerLeaseExpiresAt": firestore.DELETE_FIELD,
                    "workerFailure": error[:4000],
                    "workerFinishedAt": firestore.SERVER_TIMESTAMP,
                }, merge=True)
            return response
        except Exception as exc:
            try:
                job_ref.set({
                    "workerStatus": "FAILED",
                    "workerStage": "WORKER_UNHANDLED",
                    "workerRunId": run_id,
                    "workerSourceCandidate": source_candidate or None,
                    "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                    "workerLeaseExpiresAt": firestore.DELETE_FIELD,
                    "workerFailure": str(exc)[:4000],
                    "workerFinishedAt": firestore.SERVER_TIMESTAMP,
                }, merge=True)
            finally:
                raise
        finally:
            stop.set()
            thread.join(timeout=2)

    durable_run_energy.__name__ = original.__name__
    durable_run_energy.__revex_r114_durable__ = True
    app.view_functions[endpoint] = durable_run_energy
