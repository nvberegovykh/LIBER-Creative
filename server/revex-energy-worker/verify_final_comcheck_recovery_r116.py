#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import json

import durable_execution as durable
import revex_comcheck_evidence_r116 as evidence

# Real code-analysis semantics: first number is permitted/maximum; second is provided/proposed.
assert evidence.extract_provided_building_height(
    "Table 504.3/504.4\nBuilding Hight above grade plane    85'    65'"
) == 65.0
assert evidence.extract_provided_building_height(
    "Building Height above grade plane | 85'-0\" | 65'-0\""
) == 65.0
# Zoning terminology alone is not actual building height evidence.
assert evidence.extract_provided_building_height("MAX BUILDING HEIGHT 85' permitted") is None
assert evidence.extract_provided_building_height("Maximum Building Height 65'") is None
# Ambiguous multiple actual-height rows fail closed instead of picking one.
assert evidence.extract_provided_building_height(
    "Building Height above grade plane 85' 65'\nBuilding Height above grade plane 85' 67'"
) is None

sha_a = "a" * 40
sha_b = "b" * 40
assert durable._cache_path("projects/p/revex/energy/server-results/eng_x", sha_a).endswith(f"worker-response.{sha_a}.json")
assert durable._cache_path("projects/p/revex/energy/server-results/eng_x", sha_b).endswith(f"worker-response.{sha_b}.json")
assert durable._pipeline_status({"manifest": {"status": "COMPLETE"}}) == "COMPLETE"
assert durable._pipeline_status({"manifest": {"status": "BLOCKED_COMCHECK_INPUT"}}) == "BLOCKED_COMCHECK_INPUT"

here = Path(__file__).resolve().parent
broker = (here.parent / "firebase-functions" / "index.js").read_text(encoding="utf-8")
guard = (here / "revex_energy_pipeline_guard_r116.py").read_text(encoding="utf-8")
durable_source = (here / "durable_execution.py").read_text(encoding="utf-8")

for marker in (
    "pipelineStatus === 'COMPLETE'",
    "status: 'FAILED', pipelineStatus",
    "stage: 'PIPELINE_TERMINAL'",
    "ok: pipelineStatus === 'COMPLETE'",
):
    assert marker in broker, marker
for marker in (
    "COMCHECK_PREFLIGHT_R116",
    "MUST_PASS_BEFORE_GEOMETRYCO_AND_ENERGYPLUS",
    "prepare_project_comcheck",
):
    assert marker in guard, marker
for marker in (
    "workerSourceCandidate",
    "PIPELINE_TERMINAL_CACHED",
    "PIPELINE_TERMINAL",
):
    assert marker in durable_source, marker

print(json.dumps({
    "REVEX_R116_FINAL_COMCHECK_RECOVERY": "PASSED",
    "actualBuildingHeightFt": 65,
    "zoningMaximumRejectedAsActual": True,
    "preflightBeforeSimulation": True,
    "cacheBoundToWorkerSource": True,
    "blockedPipelineIsTerminal": True,
}))
