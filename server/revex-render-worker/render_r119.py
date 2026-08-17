#!/usr/bin/env python3
from __future__ import annotations

import os
import time
from pathlib import Path

import app as base
import render_r115 as r115

BUILD = "20260817r119-durable-model-cache1"
base.BUILD = BUILD


def _durable_public_model_pipeline():
    """Load the exact approved Qwen revision through a persistent resumable snapshot.

    The live failure being repaired here happened before inference: a cold Cloud Run
    instance had no local model cache and the Hub metadata request failed. r119 keeps
    the exact public model/revision and tokenless authority, but downloads it into a
    Cloud Storage mounted directory with long Hub timeouts. Partial downloads therefore
    survive Cloud Run instance replacement and the model is loaded locally after the
    exact snapshot has been resolved once.
    """
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
                cache_root = Path(
                    str(os.environ.get("REVEX_MODEL_CACHE_DIR") or "/tmp/revex-qwen-2511").strip()
                )
                cache_root.mkdir(parents=True, exist_ok=True)
                etag_timeout = float(os.environ.get("HF_HUB_ETAG_TIMEOUT") or 120)
                base._MODEL_STATE["origin"] = "public-hugging-face-persistent-cache"

                last_error: Exception | None = None
                source = ""
                for attempt in range(1, 7):
                    try:
                        source = snapshot_download(
                            repo_id=base.MODEL_ID,
                            revision=base.MODEL_REVISION,
                            local_dir=str(cache_root),
                            token=False,
                            etag_timeout=etag_timeout,
                            max_workers=8,
                        )
                        break
                    except Exception as exc:
                        last_error = exc
                        base._MODEL_STATE.update(
                            status="downloading",
                            error=f"snapshot attempt {attempt}/6: {str(exc)[:900]}",
                        )
                        if attempt >= 6:
                            raise
                        time.sleep(min(45, 5 * attempt))
                if not source:
                    raise RuntimeError(str(last_error or "Pinned Qwen snapshot could not be downloaded."))

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
