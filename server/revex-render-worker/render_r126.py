#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

import app as base
import render_r119 as r119

BUILD = "20260818-current-warm-retry1"
base.BUILD = BUILD
APP = r119.APP

_WARM_LOCK = threading.Lock()
_WARM_STARTED = False
_WARM_MAX_SECONDS = 32 * 60


def _warm_marker(ok: bool, error: str = "", *, attempt: int = 0, retryable: bool = False, next_retry_seconds: int = 0) -> None:
    path = str(os.environ.get("REVEX_WARM_MARKER") or "").strip()
    token = str(os.environ.get("REVEX_WARM_TOKEN") or "").strip()
    if not path or not token:
        return
    try:
        marker = Path(path)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({
            "schema": "liber.revex.render-server-warm.v2",
            "build": BUILD,
            "warmToken": token,
            "ok": bool(ok),
            "serverWarm": bool(ok),
            "browserInference": False,
            "model": base.MODEL_ID,
            "revision": base.MODEL_REVISION,
            "modelState": dict(base._MODEL_STATE),
            "attempt": int(attempt),
            "retryable": bool(retryable),
            "nextRetrySeconds": int(next_retry_seconds),
            "error": error[:1500] if error else None,
            "at": time.time(),
        }, sort_keys=True), encoding="utf-8")
    except Exception:
        pass


def _retry_after_seconds(message: str, attempt: int) -> int:
    match = re.search(r"retry\s+after\s+(\d+)\s+seconds?", message or "", re.I)
    if match:
        return max(10, min(120, int(match.group(1)) + 8))
    return min(90, max(15, 15 * attempt))


def _retryable_warm_error(message: str) -> bool:
    text = (message or "").casefold()
    permanent = (
        "started without an nvidia cuda gpu",
        "requires a large-memory gpu",
        "revex_model_path does not exist",
        "revision not found",
        "repository not found",
        "401 unauthorized",
        "403 forbidden",
    )
    if any(marker in text for marker in permanent):
        return False
    transient = (
        "429", "too many requests", "rate limit", "retry after",
        "hub could not be reached", "hfhubhttperror", "timeout", "timed out",
        "connection", "cdn", "xet", "502", "503", "504",
        "incomplete", "missing", "snapshot", "download", "network",
    )
    return any(marker in text for marker in transient)


def _warm_model() -> None:
    """Warm the pinned model server-side, resuming durable cache after transient Hub failures."""
    started = time.monotonic()
    attempt = 0
    while True:
        attempt += 1
        try:
            base._MODEL_STATE.update(status="warming-server", error=None, warmAttempt=attempt)
            base._public_model_pipeline()
            _warm_marker(True, attempt=attempt)
            return
        except Exception as exc:
            message = str(exc) or exc.__class__.__name__
            retryable = _retryable_warm_error(message)
            elapsed = time.monotonic() - started
            if (not retryable) or elapsed >= _WARM_MAX_SECONDS:
                base._MODEL_STATE.update(status="failed", error=message[:1500], warmAttempt=attempt)
                _warm_marker(False, message, attempt=attempt, retryable=False)
                return

            delay = _retry_after_seconds(message, attempt)
            remaining = max(0, int(_WARM_MAX_SECONDS - elapsed))
            delay = min(delay, remaining)
            base._MODEL_STATE.update(
                status="warm-retry",
                error=message[:1500],
                warmAttempt=attempt,
                nextRetrySeconds=delay,
            )
            # Do not publish a terminal failure marker for transient download/rate-limit
            # interruptions. The deployer keeps polling while the mounted GCS cache resumes.
            time.sleep(max(1, delay))


def ensure_server_warm() -> None:
    global _WARM_STARTED
    with _WARM_LOCK:
        if _WARM_STARTED:
            return
        _WARM_STARTED = True
        thread = threading.Thread(target=_warm_model, name="revex-qwen-server-warm", daemon=True)
        thread.start()


@APP.get("/readyz")
def readyz():
    state = dict(base._MODEL_STATE)
    ready = state.get("status") == "ready" and base._PIPELINE is not None
    return ({
        "ok": ready,
        "schema": "liber.revex.render-worker-ready.v2",
        "build": BUILD,
        "serverWarm": ready,
        "browserInference": False,
        "model": base.MODEL_ID,
        "revision": base.MODEL_REVISION,
        "modelState": state,
        "at": time.time(),
    }, 200 if ready else 503)


# Cloud Run min-instance keeps this process/GPU alive. The cache lives on the mounted
# GCS volume, so a new source-bound candidate resumes partial shards rather than
# restarting the 57+ GB model download.
ensure_server_warm()
