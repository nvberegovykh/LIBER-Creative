#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import app as base
import render_r115 as r115

BUILD = "20260818-current-durable-cache-retry1"
base.BUILD = BUILD
CACHE_MARKER = ".revex-qwen-cache-complete.json"


def _cache_is_complete(cache_root: Path) -> bool:
    marker = cache_root / CACHE_MARKER
    model_index = cache_root / "model_index.json"
    if not marker.is_file() or not model_index.is_file():
        return False
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
        return (
            payload.get("model") == base.MODEL_ID
            and payload.get("revision") == base.MODEL_REVISION
            and payload.get("complete") is True
        )
    except Exception:
        return False


def _mark_cache_complete(cache_root: Path) -> None:
    marker = cache_root / CACHE_MARKER
    marker.write_text(
        json.dumps({
            "schema": "liber.revex.render-model-cache.v1",
            "model": base.MODEL_ID,
            "revision": base.MODEL_REVISION,
            "complete": True,
            "completedAt": time.time(),
        }, sort_keys=True),
        encoding="utf-8",
    )


def _hub_retry_delay(message: str, attempt: int) -> int:
    match = re.search(r"retry\s+after\s+(\d+)\s+seconds?", message or "", re.I)
    if match:
        # Honor upstream explicitly instead of burning the remaining quota window.
        return max(15, min(150, int(match.group(1)) + 10))
    if "429" in (message or "") or "rate limit" in (message or "").casefold():
        return 60
    return min(60, max(10, 10 * attempt))


def _durable_public_model_pipeline():
    """Resolve one exact public snapshot into durable storage, then load it offline."""
    if base._PIPELINE is not None:
        return base._PIPELINE

    with base._PIPELINE_LOCK:
        if base._PIPELINE is not None:
            return base._PIPELINE

        started = time.monotonic()
        base._MODEL_STATE.update(status="loading", error=None)
        try:
            import torch
            from diffusers import QwenImageEditPlusPipeline
            from huggingface_hub import snapshot_download

            gpu = base._gpu_facts(torch)
            base._MODEL_STATE.update(gpu=gpu["name"], vramGiB=gpu["vramGiB"])

            configured = str(os.environ.get("REVEX_MODEL_PATH") or "").strip()
            if configured:
                model_path = Path(configured)
                if not model_path.is_dir():
                    raise RuntimeError(f"REVEX_MODEL_PATH does not exist or is not a directory: {configured}")
                source = str(model_path)
                base._MODEL_STATE["origin"] = "private-local-cache"
            else:
                cache_root = Path(str(os.environ.get("REVEX_MODEL_CACHE_DIR") or "/tmp/revex-qwen-2511").strip())
                cache_root.mkdir(parents=True, exist_ok=True)
                source = str(cache_root)

                if _cache_is_complete(cache_root):
                    base._MODEL_STATE["origin"] = "public-hugging-face-persistent-cache-offline"
                else:
                    etag_timeout = float(os.environ.get("HF_HUB_ETAG_TIMEOUT") or 120)
                    base._MODEL_STATE["origin"] = "public-hugging-face-persistent-cache-filling"
                    last_error: Exception | None = None
                    resolved = ""
                    for attempt in range(1, 9):
                        try:
                            resolved = snapshot_download(
                                repo_id=base.MODEL_ID,
                                revision=base.MODEL_REVISION,
                                local_dir=str(cache_root),
                                token=False,
                                etag_timeout=etag_timeout,
                                # Fewer concurrent Hub metadata/download requests reduce burst
                                # pressure while the same persistent cache fills incrementally.
                                max_workers=4,
                            )
                            break
                        except Exception as exc:
                            last_error = exc
                            message = str(exc)
                            delay = _hub_retry_delay(message, attempt)
                            base._MODEL_STATE.update(
                                status="downloading",
                                error=f"snapshot attempt {attempt}/8: {message[:900]}",
                                snapshotAttempt=attempt,
                                nextRetrySeconds=delay,
                            )
                            if attempt >= 8:
                                raise
                            time.sleep(delay)
                    if not resolved:
                        raise RuntimeError(str(last_error or "Pinned Qwen snapshot could not be downloaded."))
                    if not (cache_root / "model_index.json").is_file():
                        raise RuntimeError("Pinned Qwen snapshot returned without model_index.json; cache is incomplete.")
                    _mark_cache_complete(cache_root)

            pipe = QwenImageEditPlusPipeline.from_pretrained(
                source,
                torch_dtype=torch.bfloat16,
                device_map="cuda",
                low_cpu_mem_usage=True,
                local_files_only=True,
            )
            pipe.set_progress_bar_config(disable=True)
            base._PIPELINE = pipe
            elapsed = round(time.monotonic() - started, 3)
            base._MODEL_STATE.update(status="ready", loadedAt=time.time(), loadSeconds=elapsed, error=None)
            return base._PIPELINE
        except Exception as exc:
            base._MODEL_STATE.update(status="failed", error=str(exc)[:1500])
            raise


base._public_model_pipeline = _durable_public_model_pipeline
APP = r115.APP
