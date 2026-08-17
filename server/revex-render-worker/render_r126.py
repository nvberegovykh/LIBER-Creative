#!/usr/bin/env python3
from __future__ import annotations

import threading
import time

import app as base
import render_r119 as r119

BUILD = "20260817r126-warm-private-gpu1"
base.BUILD = BUILD
APP = r119.APP

_WARM_LOCK = threading.Lock()
_WARM_STARTED = False


def _warm_model() -> None:
    """Warm the exact pinned model on the server, never in the browser/client."""
    try:
        base._MODEL_STATE.update(status="warming-server", error=None)
        base._public_model_pipeline()
    except Exception as exc:
        # Keep the service alive so /healthz and /readyz expose the exact failure.
        base._MODEL_STATE.update(status="failed", error=str(exc)[:1500])


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
