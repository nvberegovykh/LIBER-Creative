#!/usr/bin/env python3
from __future__ import annotations

import json
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


def _cache_path(output_prefix: str) -> str:
    return f"{output_prefix.rstrip('/')}/{CACHE_NAME}"


def _load_cached_response(bucket, path: str, project_id: str, source_revision: str):
    blob = bucket.blob(path)
    if not blob.exists():
        return None
    try:
        body = json.loads(blob.download_as_text(encoding="utf-8"))
    except Exception:
        return None
    if (
        body.get("schema") == "liber.revex.energy-server-response.v1"
        and str(body.get("projectId") or "") == project_id
        and str(body.get("sourceRevision") or "") == source_revision
    ):
        return body
    return None


def _store_cached_response(bucket, path: str, body: dict) -> None:
    blob = bucket.blob(path)
    blob.upload_from_string(
        json.dumps(body, ensure_ascii=True, separators=(",", ":")),
        content_type="application/json",
    )


def install_durable_energy_execution(app) -> None:
    """Wrap the existing r49 /run handler without changing the Energy pipeline.

    One immutable Engineering revision owns one worker lease. The wrapper writes a
    durable Firestore heartbeat while the existing synchronous r49 pipeline runs
    and caches the final server response in the same Storage result prefix. A
    replacement broker request therefore attaches to the existing run, consumes a
    completed cached response, or takes over only after the worker lease is stale.
    """
    endpoint = "run_energy"
    original = app.view_functions.get(endpoint)
    if original is None or getattr(original, "__revex_r114_durable__", False):
        return

    db = firestore.Client()
    storage_client = storage.Client()

    def durable_run_energy():
        data = request.get_json(silent=True) or {}
        project_id = str(data.get("projectId") or "").strip()
        source_revision = str(data.get("sourceRevision") or "").strip()
        bucket_name = str(data.get("bucket") or "").strip()
        output_prefix = str(data.get("outputPrefix") or "").strip().strip("/")
        if not project_id or not source_revision or not bucket_name or not output_prefix:
            return original()

        job_ref = db.document(f"projects/{project_id}/revexEnergyJobs/{source_revision}")
        bucket = storage_client.bucket(bucket_name)
        cache_path = _cache_path(output_prefix)

        cached = _load_cached_response(bucket, cache_path, project_id, source_revision)
        if cached is not None:
            job_ref.set({
                "workerStatus": "COMPLETE",
                "workerStage": "WORKER_COMPLETE_CACHED",
                "workerResponsePath": cache_path,
                "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                "workerRecoveredFromCache": True,
            }, merge=True)
            return jsonify(cached), 200

        run_id = f"worker-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        transaction = db.transaction()

        @firestore.transactional
        def claim(txn):
            snap = job_ref.get(transaction=txn)
            state = snap.to_dict() if snap.exists else {}
            if str(state.get("workerStatus") or "").upper() == "COMPLETE" and state.get("workerResponsePath"):
                return "COMPLETE", state
            if str(state.get("workerStatus") or "").upper() == "RUNNING" and _fresh_worker(state):
                return "RUNNING", state
            now = _utcnow()
            txn.set(job_ref, {
                "workerStatus": "RUNNING",
                "workerStage": "WORKER_LEASE_CLAIMED",
                "workerRunId": run_id,
                "workerHeartbeatAt": now,
                "workerLeaseExpiresAt": now + timedelta(seconds=LEASE_SECONDS),
                "workerStartedAt": now,
                "workerResponsePath": cache_path,
                "workerFailure": firestore.DELETE_FIELD,
            }, merge=True)
            return "CLAIMED", {}

        disposition, state = claim(transaction)
        if disposition == "COMPLETE":
            cached = _load_cached_response(bucket, str(state.get("workerResponsePath") or cache_path), project_id, source_revision)
            if cached is not None:
                return jsonify(cached), 200
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
                job_ref.set({
                    "workerStatus": "COMPLETE",
                    "workerStage": "WORKER_COMPLETE",
                    "workerRunId": run_id,
                    "workerHeartbeatAt": firestore.SERVER_TIMESTAMP,
                    "workerLeaseExpiresAt": firestore.DELETE_FIELD,
                    "workerResponsePath": cache_path,
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
