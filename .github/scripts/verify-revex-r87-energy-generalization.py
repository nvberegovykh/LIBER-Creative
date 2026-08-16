#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server/revex-energy-worker"
NORMALIZER = SERVER / "revex_energy_identity_normalizer.py"
CONTENT_AGENT = SERVER / "revex_identity_content_agent.py"
RESOLVER = SERVER / "revex_energy_pipeline_r69.py"
GUARD = SERVER / "revex_energy_pipeline_guard.py"
DOCKER = SERVER / "Dockerfile"
IDENTITY_QA = SERVER / "verify_identity_normalizer.py"
CONTENT_QA = SERVER / "verify_identity_content_agent.py"
DIAGNOSTICS = ROOT / "docs/liber-apps/apps/revex/energy-diagnostics-r68.js"
UI = ROOT / "docs/liber-apps/apps/revex/ui-integrity.js"
STORE = ROOT / "docs/liber-apps/apps/revex/store.js"
BRIDGE = ROOT / "src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js"

for path in (NORMALIZER, CONTENT_AGENT, RESOLVER, GUARD, DOCKER, IDENTITY_QA, CONTENT_QA, DIAGNOSTICS, UI, STORE, BRIDGE):
    assert path.is_file(), f"missing generalized Energy dependency: {path}"

# Execute semantic/generalization QA, not only source-marker checks.
for qa, label in ((IDENTITY_QA, "generalized active-Revit identity normalization"),
                  (CONTENT_QA, "content-aware project identity consensus")):
    completed = subprocess.run([sys.executable, str(qa)], cwd=str(SERVER))
    assert completed.returncode == 0, f"{label} QA failed"

normalizer = NORMALIZER.read_text(encoding="utf-8")
content_agent = CONTENT_AGENT.read_text(encoding="utf-8")
resolver = RESOLVER.read_text(encoding="utf-8")
guard = GUARD.read_text(encoding="utf-8")
docker = DOCKER.read_text(encoding="utf-8")
diagnostics = DIAGNOSTICS.read_text(encoding="utf-8")
ui = UI.read_text(encoding="utf-8")
store = STORE.read_text(encoding="utf-8")
bridge = BRIDGE.read_text(encoding="utf-8")

# Generalization boundary: runtime primitives cannot be tied to the current live project
# or historical template project. Those strings are valid only in isolated test fixtures.
for label, source in (("normalizer", normalizer), ("content-agent", content_agent), ("resolver", resolver)):
    upper = source.upper()
    assert "250 MIDWOOD" not in upper, f"{label} contains a live-project branch"
    assert "79 WINTHROP" not in upper, f"{label} contains a reference-project branch"

assert "normalize_verified_evidence" in normalizer
assert "locality_near_authoritative_address" in normalizer
assert "PARTY_BOUNDARY" in normalizer
assert "project-specific address mapping" in normalizer

assert "content-aware-consensus-over-immutable-active-Revit-T-Z-evidence" in content_agent
assert "MIN_AGENT_CONFIDENCE" in content_agent
assert "excludedPartyEvidence" in content_agent
assert "validate_agent_candidate" in content_agent
assert "_structured_identity_complete" in content_agent

assert "import revex_energy_identity_normalizer as identity_normalizer" in resolver
assert "PROJECT_IDENTITY_NORMALIZED" in resolver
assert "derived-only-from-immutable-active-Revit-address" in resolver
assert "US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT" in resolver

assert "import revex_identity_content_agent as content_identity" in guard
assert "_resolve_content_identity_request(request_path, output_root)" in guard
assert "import revex_energy_pipeline_r69 as resolver" in guard
assert "effective_request = _resolve_r69_request(effective_request, output_root)" in guard
assert guard.index("_resolve_content_identity_request(request_path, output_root)") < guard.index("_resolve_r69_request(effective_request, output_root)")

# Worker image must ship and execute both identity regressions before Cloud Run accepts it.
assert "COPY server/revex-energy-worker/revex_energy_identity_normalizer.py" in docker
assert "COPY server/revex-energy-worker/revex_identity_content_agent.py" in docker
assert "COPY server/revex-energy-worker/verify_identity_normalizer.py" in docker
assert "COPY server/revex-energy-worker/verify_identity_content_agent.py" in docker
assert "python3 /opt/revex/server/verify_identity_normalizer.py" in docker
assert "python3 /opt/revex/server/verify_identity_content_agent.py" in docker
assert "revex_energy_pipeline_guard_r87.py" not in docker

# Immutable revision replay is a general service primitive keyed by project/revision.
# No Revit action is part of the retry path.
assert "async runEnergyServer(projectId, sourceRevision)" in store
assert "projectId,\n        sourceRevision" in store or "projectId,\r\n        sourceRevision" in store
assert "Store.runEnergyServer(projectId, revision)" in bridge
assert "Retry this published revision" in diagnostics
assert "button.disabled=false" in diagnostics
assert "sync a new revision" not in diagnostics.lower()
assert "no Revit export or re-sync is started" in diagnostics
assert "energy-diagnostics-r68.js?v=20260816r87-energy-replay1" in ui

print(json.dumps({
    "schema": "liber.revex.r88-energy-identity-generalization.v1",
    "status": "PASSED",
    "identity": {
        "contentAwareRoleSeparation": True,
        "twoSourceConsensus": True,
        "deterministicFallbackPreserved": True,
        "crossProjectRegression": True,
        "partyAddressBoundary": True,
        "censusLastResort": True,
        "projectSpecificRuntimeBranches": False,
    },
    "replay": {
        "immutableProjectRevisionKey": True,
        "revitRerunRequired": False,
        "failedCurrentRevisionReplayEnabled": True,
    },
}, indent=2))
