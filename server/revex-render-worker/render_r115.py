#!/usr/bin/env python3
from __future__ import annotations

import time
import app as base

BUILD = "20260817r115-fast-construction1"
base.BUILD = BUILD

BUILDING_AUTHORITY = """
BUILDING AUTHORITY — the supplied REVEX viewport and Revit model own everything inside or on the building.
Preserve all walls, openings, windows, doors, curtain-wall grids/panels, slabs, roofs, stairs, railings, casework,
furniture, plumbing fixtures, lighting fixtures, equipment, modeled decor/families, their count, position,
orientation, mounting relationship, clearance/envelope, size and proportions. Do not invent, remove, relocate,
resize or redesign building objects. A modeled family/object may be visually substituted only by an equivalent
object in the same location, same orientation, same functional role, same clearance/envelope and effectively the
same size/proportions as the source. Only surroundings outside the modeled building may be imagined: sky,
distant context, vegetation/background entourage and atmosphere. Surroundings may never obscure, crop, move or
reshape the building. Construction-useful precision, joints/reveals, material scale/roughness, glass depth,
fixture realism and physically plausible lighting outrank cinematic mood. If uncertain, preserve the Revit source.
""".strip()

base.GEOMETRY_LOCK = BUILDING_AUTHORITY

STEP_BUDGET = {"1K": 12, "2K": 20, "4K": 30}
DEADLINE_SECONDS = {"1K": 30.0, "2K": 90.0, "4K": 180.0}


def _render(project_id: str, job_id: str, bucket_name: str, source_path: str, result_path: str, prompt: str, resolution: str, seed: int) -> dict:
    import torch

    base._job_update(project_id, job_id, "READING_SOURCE", stage="source")
    source = base._fit_input(base._download_image(bucket_name, source_path), resolution)

    if base._PIPELINE is None:
        base._job_update(project_id, job_id, "WARMING_MODEL", stage="model", modelOrigin=base._MODEL_STATE.get("origin"))
    pipe = base._public_model_pipeline()

    steps = int(STEP_BUDGET.get(resolution, STEP_BUDGET["1K"]))
    deadline_seconds = float(DEADLINE_SECONDS.get(resolution, DEADLINE_SECONDS["1K"]))
    base._job_update(
        project_id, job_id, "RENDERING", stage="inference",
        inputWidth=source.width, inputHeight=source.height,
        gpu=base._MODEL_STATE.get("gpu"), vramGiB=base._MODEL_STATE.get("vramGiB"),
        inferenceSteps=steps, targetSeconds=deadline_seconds,
    )

    final_prompt = f"{prompt.strip()}\n\n{BUILDING_AUTHORITY}".strip()
    negative = (
        "moved walls, changed openings, changed camera, distorted perspective, deformed architecture, "
        "duplicate windows, missing doors, altered floor plates, moved fixtures, missing light fixtures, "
        "invented furniture, changed furniture layout, relocated equipment, resized families, changed mounting height"
    )
    started = time.monotonic()
    last_progress = [started]

    def on_step_end(pipeline, step, timestep, callback_kwargs):
        now = time.monotonic()
        elapsed = now - started
        if elapsed > deadline_seconds:
            raise TimeoutError(
                f"REVEX fast render exceeded the {deadline_seconds:.0f}s inference budget at step {step + 1}/{steps}. "
                "Use 1K construction review or retry on a warm worker."
            )
        if step == 0 or step + 1 == steps or now - last_progress[0] >= 3.0:
            base._job_update(
                project_id, job_id, "RENDERING", stage="inference",
                inferenceStep=step + 1, inferenceSteps=steps,
                elapsedSeconds=round(elapsed, 2), targetSeconds=deadline_seconds,
            )
            last_progress[0] = now
        return callback_kwargs

    with base._INFERENCE_LOCK, torch.inference_mode():
        generated = pipe(
            image=source,
            prompt=final_prompt,
            negative_prompt=negative,
            true_cfg_scale=4.0,
            guidance_scale=1.0,
            num_inference_steps=steps,
            callback_on_step_end=on_step_end,
            generator=torch.Generator(device="cuda").manual_seed(seed),
            num_images_per_prompt=1,
        ).images[0].convert("RGB")
    inference_seconds = round(time.monotonic() - started, 3)

    generated = base._fit_output(generated, resolution)
    base._job_update(
        project_id, job_id, "UPLOADING", stage="result",
        inferenceSeconds=inference_seconds, inferenceSteps=steps, targetSeconds=deadline_seconds,
    )
    result_url, result_bytes = base._upload_result(bucket_name, result_path, generated)
    return {
        "resultUrl": result_url,
        "resultPath": result_path,
        "resultBytes": result_bytes,
        "width": generated.width,
        "height": generated.height,
        "inferenceSeconds": inference_seconds,
        "inferenceSteps": steps,
        "targetSeconds": deadline_seconds,
        "requestedResolution": resolution,
        "modelOrigin": base._MODEL_STATE.get("origin"),
        "buildingAuthority": "revit-model",
        "imaginationBoundary": "surroundings-only",
    }


base._render = _render
APP = base.APP
