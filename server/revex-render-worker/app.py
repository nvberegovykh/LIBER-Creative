#!/usr/bin/env python3
"""Private REVEX architectural image-edit worker.

The browser never downloads or runs the model. The worker pulls one exact public
Apache-2.0 Qwen revision without a Hugging Face token, caches it for the life of
the Cloud Run instance, and serializes GPU work at concurrency=1.
"""
from __future__ import annotations

import io
import os
import re
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, request
from google.cloud import firestore, storage
from PIL import Image

MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
MODEL_REVISION = "6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9"
MODEL_LICENSE = "Apache-2.0"
BUILD = "20260816r54-selfhost-render2"
PROJECT_RE = re.compile(r"^[A-Za-z0-9._-]{1,160}$")
JOB_RE = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
MAX_PROMPT = 12000
MIN_GPU_VRAM_GIB = 70.0

os.environ.setdefault("HF_HOME", "/tmp/revex-hf-cache")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
os.environ.setdefault("HF_ENABLE_PARALLEL_LOADING", "YES")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Public upstream is deliberate. Never make a runtime secret or browser login a
# prerequisite for the default REVEX renderer.
os.environ.pop("HUGGING_FACE_HUB_TOKEN", None)
os.environ.pop("HF_TOKEN", None)

APP = Flask(__name__)
_STORAGE = storage.Client()
_FIRESTORE = firestore.Client()
_PIPELINE = None
_PIPELINE_LOCK = threading.Lock()
_INFERENCE_LOCK = threading.Lock()
_MODEL_STATE = {
    "status": "cold", "loadedAt": None, "loadSeconds": None, "error": None,
    "origin": "public-hugging-face-no-token", "gpu": None, "vramGiB": None,
}

GEOMETRY_LOCK = """
GEOMETRY LOCK — the supplied REVEX viewport is authoritative BIM evidence.
Preserve the exact camera projection, framing, crop, silhouette, wall locations,
openings, windows, doors, curtain-wall grids and panels, slabs, roofs, stairs,
major objects, dimensions, proportions and object positions. Do not invent,
remove, shift, widen, narrow, rotate or redesign architectural geometry. Only
improve material appearance, lighting, atmosphere, entourage and photographic
realism where those changes do not alter the architecture. If uncertain, keep
the source geometry unchanged.
""".strip()


def _job_ref(project_id: str, job_id: str):
    return _FIRESTORE.document(f"projects/{project_id}/revexRenders/{job_id}")


def _job_update(project_id: str, job_id: str, status: str, **extra) -> None:
    payload = {
        "status": status,
        "workerBuild": BUILD,
        "model": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "updatedAt": firestore.SERVER_TIMESTAMP,
        **extra,
    }
    try:
        _job_ref(project_id, job_id).set(payload, merge=True)
    except Exception:
        # Rendering must not be made impossible by a progress-write outage.
        pass


def _model_source() -> tuple[str, bool]:
    configured = str(os.environ.get("REVEX_MODEL_PATH") or "").strip()
    if configured:
        path = Path(configured)
        if not path.is_dir():
            raise RuntimeError(f"REVEX_MODEL_PATH does not exist or is not a directory: {configured}")
        return str(path), True
    return MODEL_ID, False


def _gpu_facts(torch) -> dict:
    if not torch.cuda.is_available():
        raise RuntimeError("REVEX render worker started without an NVIDIA CUDA GPU.")
    props = torch.cuda.get_device_properties(0)
    total_gib = float(props.total_memory) / (1024 ** 3)
    facts = {"name": str(props.name), "vramGiB": round(total_gib, 2)}
    if total_gib < MIN_GPU_VRAM_GIB:
        raise RuntimeError(
            f"REVEX Qwen renderer requires a large-memory GPU; detected {facts['name']} with "
            f"{facts['vramGiB']} GiB VRAM (minimum guard {MIN_GPU_VRAM_GIB:.0f} GiB)."
        )
    return facts


def _public_model_pipeline():
    global _PIPELINE
    if _PIPELINE is not None:
        return _PIPELINE
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE
        started = time.monotonic()
        _MODEL_STATE.update(status="loading", error=None)
        try:
            import torch
            from diffusers import QwenImageEditPlusPipeline

            gpu = _gpu_facts(torch)
            _MODEL_STATE.update(gpu=gpu["name"], vramGiB=gpu["vramGiB"])
            source, is_local = _model_source()
            _MODEL_STATE["origin"] = "private-local-cache" if is_local else "public-hugging-face-no-token"

            kwargs = {
                "torch_dtype": torch.bfloat16,
                # Direct placement avoids materializing another full model copy
                # in CPU RAM before moving ~58 GB of weights onto the GPU.
                "device_map": "cuda",
                "low_cpu_mem_usage": True,
                "local_files_only": is_local,
            }
            if not is_local:
                kwargs.update({"revision": MODEL_REVISION, "token": False})

            last_error = None
            pipe = None
            # A cold public download can encounter a transient CDN/Xet reset.
            # Retry the same immutable revision; partial shards stay in HF cache.
            for attempt in range(1, 4):
                try:
                    pipe = QwenImageEditPlusPipeline.from_pretrained(source, **kwargs)
                    break
                except Exception as exc:
                    last_error = exc
                    if attempt >= 3:
                        raise
                    try:
                        torch.cuda.empty_cache()
                    except Exception:
                        pass
                    time.sleep(4 * attempt)
            if pipe is None:
                raise RuntimeError(str(last_error or "Pinned Qwen model could not be loaded."))

            pipe.set_progress_bar_config(disable=True)
            _PIPELINE = pipe
            elapsed = round(time.monotonic() - started, 3)
            _MODEL_STATE.update(status="ready", loadedAt=time.time(), loadSeconds=elapsed, error=None)
            return _PIPELINE
        except Exception as exc:
            _MODEL_STATE.update(status="failed", error=str(exc)[:1500])
            raise


def _safe_id(value: object, pattern: re.Pattern[str], label: str) -> str:
    text = str(value or "").strip()
    if not pattern.fullmatch(text):
        raise ValueError(f"Invalid {label}.")
    return text


def _object_path(value: object, project_id: str, job_id: str, label: str) -> str:
    path = str(value or "").strip().lstrip("/")
    prefix = f"projects/{project_id}/revex/renders/{job_id}/"
    if not path.startswith(prefix) or ".." in path:
        raise ValueError(f"Invalid {label} path.")
    return path


def _download_image(bucket_name: str, object_path: str) -> Image.Image:
    blob = _STORAGE.bucket(bucket_name).blob(object_path)
    data = blob.download_as_bytes()
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert("RGB")


def _fit_input(image: Image.Image, resolution: str) -> Image.Image:
    max_edge = {"1K": 1024, "2K": 1536, "4K": 2048}.get(resolution, 1024)
    width, height = image.size
    longest = max(width, height)
    if longest <= max_edge:
        return image
    scale = max_edge / float(longest)
    target = (max(32, round(width * scale / 32) * 32), max(32, round(height * scale / 32) * 32))
    return image.resize(target, Image.Resampling.LANCZOS)


def _fit_output(image: Image.Image, resolution: str) -> Image.Image:
    # Qwen edits at a bounded inference size. REVEX preserves aspect/camera and
    # produces the requested review-file size afterward without pretending this
    # interpolation adds new architectural information.
    target_edge = {"1K": 1280, "2K": 2048, "4K": 3840}.get(resolution, 1280)
    width, height = image.size
    longest = max(width, height)
    if longest >= target_edge:
        return image
    scale = target_edge / float(longest)
    target = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(target, Image.Resampling.LANCZOS)


def _upload_result(bucket_name: str, object_path: str, image: Image.Image) -> tuple[str, int]:
    download_token = str(uuid.uuid4())
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=94, subsampling=0, optimize=True)
    data = output.getvalue()
    blob = _STORAGE.bucket(bucket_name).blob(object_path)
    blob.metadata = {
        "firebaseStorageDownloadTokens": download_token,
        "revexModel": MODEL_ID,
        "revexModelRevision": MODEL_REVISION,
        "revexWorkerBuild": BUILD,
    }
    blob.upload_from_string(data, content_type="image/jpeg")
    url = (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/"
        f"{quote(object_path, safe='')}?alt=media&token={download_token}"
    )
    return url, len(data)


def _render(project_id: str, job_id: str, bucket_name: str, source_path: str, result_path: str, prompt: str, resolution: str, seed: int) -> dict:
    import torch

    _job_update(project_id, job_id, "READING_SOURCE", stage="source")
    source = _fit_input(_download_image(bucket_name, source_path), resolution)

    if _PIPELINE is None:
        _job_update(project_id, job_id, "WARMING_MODEL", stage="model", modelOrigin=_MODEL_STATE.get("origin"))
    pipe = _public_model_pipeline()
    _job_update(
        project_id, job_id, "RENDERING", stage="inference",
        inputWidth=source.width, inputHeight=source.height,
        gpu=_MODEL_STATE.get("gpu"), vramGiB=_MODEL_STATE.get("vramGiB"),
    )

    final_prompt = f"{prompt.strip()}\n\n{GEOMETRY_LOCK}".strip()
    negative = "moved walls, changed openings, changed camera, distorted perspective, deformed architecture, duplicate windows, missing doors, altered floor plates"
    started = time.monotonic()
    with _INFERENCE_LOCK, torch.inference_mode():
        generated = pipe(
            image=source,
            prompt=final_prompt,
            negative_prompt=negative,
            true_cfg_scale=4.0,
            guidance_scale=1.0,
            num_inference_steps=40,
            generator=torch.Generator(device="cuda").manual_seed(seed),
            num_images_per_prompt=1,
        ).images[0].convert("RGB")
    inference_seconds = round(time.monotonic() - started, 3)

    generated = _fit_output(generated, resolution)
    _job_update(project_id, job_id, "UPLOADING", stage="result", inferenceSeconds=inference_seconds)
    result_url, result_bytes = _upload_result(bucket_name, result_path, generated)
    return {
        "resultUrl": result_url,
        "resultPath": result_path,
        "resultBytes": result_bytes,
        "width": generated.width,
        "height": generated.height,
        "inferenceSeconds": inference_seconds,
        "requestedResolution": resolution,
        "modelOrigin": _MODEL_STATE.get("origin"),
    }


@APP.get("/healthz")
def healthz():
    return jsonify({
        "ok": True,
        "schema": "liber.revex.render-worker-health.v1",
        "build": BUILD,
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "license": MODEL_LICENSE,
        "modelState": dict(_MODEL_STATE),
    })


@APP.post("/run")
def run():
    body = request.get_json(silent=True) or {}
    project_id = job_id = None
    try:
        if body.get("schema") != "liber.revex.render-worker-request.v1":
            raise ValueError("Unsupported REVEX render worker request.")
        project_id = _safe_id(body.get("projectId"), PROJECT_RE, "projectId")
        job_id = _safe_id(body.get("jobId"), JOB_RE, "jobId")
        bucket_name = str(body.get("bucket") or "").strip()
        if not bucket_name or "/" in bucket_name or "\\" in bucket_name:
            raise ValueError("Invalid Storage bucket.")
        source_path = _object_path(body.get("sourcePath"), project_id, job_id, "source")
        result_path = _object_path(body.get("resultPath"), project_id, job_id, "result")
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            prompt = "Create a realistic architectural rendering while preserving the supplied BIM design exactly."
        if len(prompt) > MAX_PROMPT:
            raise ValueError("Render prompt is too long.")
        resolution = str((body.get("settings") or {}).get("resolution") or "1K").upper()
        if resolution not in {"1K", "2K", "4K"}:
            resolution = "1K"
        seed = int(body.get("seed") or 0) & 0x7FFFFFFF

        result = _render(project_id, job_id, bucket_name, source_path, result_path, prompt, resolution, seed)
        _job_update(
            project_id,
            job_id,
            "COMPLETE",
            stage="complete",
            resultUrl=result["resultUrl"],
            resultPath=result["resultPath"],
            resultBytes=result["resultBytes"],
            resultWidth=result["width"],
            resultHeight=result["height"],
            inferenceSeconds=result["inferenceSeconds"],
            requestedResolution=result["requestedResolution"],
            modelOrigin=result["modelOrigin"],
            completedAt=firestore.SERVER_TIMESTAMP,
        )
        return jsonify({
            "ok": True,
            "schema": "liber.revex.render-worker-response.v1",
            "projectId": project_id,
            "jobId": job_id,
            "build": BUILD,
            "model": MODEL_ID,
            "modelRevision": MODEL_REVISION,
            **result,
        })
    except Exception as exc:
        message = str(exc)[:3000] or exc.__class__.__name__
        if project_id and job_id:
            _job_update(project_id, job_id, "FAILED", stage="failed", error=message)
        return jsonify({"ok": False, "error": message, "build": BUILD}), 500


if __name__ == "__main__":
    APP.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))