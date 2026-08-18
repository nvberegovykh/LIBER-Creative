#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import app as base
import render_r119 as r119

BUILD = "20260817r126-warm-private-gpu2"
base.BUILD = BUILD
APP = r119.APP

_WARM_LOCK = threading.Lock()
_WARM_STARTED = False


def _warm_marker(ok: bool, error: str = "") -> None:
    path = str(os.environ.get("REVEX_WARM_MARKER") or "").strip()
    token = str(os.environ.get("REVEX_WARM_TOKEN") or "").strip()
    if not path or not token:
        return
    try:
        marker = Path(path)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({
            "schema": "liber.revex.render-server-warm.v1",
            "build": BUILD,
            "warmToken": token,
            "ok": bool(ok),
            "serverWarm": bool(ok),
            "browserInference": False,
            "model": base.MODEL_ID,
            "revision": base.MODEL_REVISION,
            "modelState": dict(base._MODEL_STATE),
            "error": error[:1500] if error else None,
            "at": time.time(),
        }, sort_keys=True), encoding="utf-8")
    except Exception:
        pass


def _warm_model() -> None:
    """Warm the exact pinned model on the server, never in the browser/client."""
    try:
        base._MODEL_STATE.update(status="warming-server", error=None)
        base._public_model_pipeline()
        _warm_marker(True)
    except Exception as exc:
        # Keep the service alive so /healthz and /readyz expose the exact failure.
        base._MODEL_STATE.update(status="failed", error=str(exc)[:1500])
        _warm_marker(False, str(exc))


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
        "schema": "liber.revex.render-worker-ready.v1",
        "build": BUILD,
        "serverWarm": True,
        "browserInference": False,
        "model": base.MODEL_ID,
        "revision": base.MODEL_REVISION,
        "modelState": state,
        "at": time.time(),
    }, 200 if ready else 503)


# Cloud Run min-instance keeps this process/GPU alive. Start loading as soon as the
# worker process imports, so the user request only uploads the viewport + prompt.
ensure_server_warm()
