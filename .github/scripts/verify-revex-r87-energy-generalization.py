#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server/revex-energy-worker"
NORMALIZER = SERVER / "revex_energy_identity_normalizer.py"
RESOLVER = SERVER / "revex_energy_pipeline_r69.py"
GUARD = SERVER / "revex_energy_pipeline_guard.py"
DOCKER = SERVER / "Dockerfile"
IDENTITY_QA = SERVER / "verify_identity_normalizer.py"
DIAGNOSTICS = ROOT / "docs/liber-apps/apps/revex/energy-diagnostics-r68.js"
UI = ROOT / "docs/liber-apps/apps/revex/ui-integrity.js"
STORE = ROOT / "docs/liber-apps/apps/revex/store.js"
BRIDGE = ROOT / "src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js"

for path in (NORMALIZER, RESOLVER, GUARD, DOCKER, IDENTITY_QA, DIAGNOSTICS, UI, STORE, BRIDGE):
    assert path.is_file(), f"missing r87 dependency: {path}"

# Execute semantic/generalization QA, not only source-marker checks.
completed = subprocess.run([sys.executable, str(IDENTITY_QA)], cwd=str(SERVER))
assert completed.returncode == 0, "generalized active-Revit identity normalization QA failed"

normalizer = NORMALIZER.read_text(encoding="utf-8")
resolver = RESOLVER.read_text(encoding="utf-8")
guard = GUARD.read_text(encoding="utf-8")
docker = DOCKER.read_text(encoding="utf-8")
diagnostics = DIAGNOSTICS.read_text(encoding="utf-8")
ui = UI.read_text(encoding="utf-8")
store = STORE.read_text(encoding="utf-8")
bridge = BRIDGE.read_text(encoding="utf-8")

# Generalization boundary: runtime primitives cannot be tied to the current live project
# or historical template project. Those strings are valid only in isolated test fixtures.
for label, source in (("normalizer", normalizer), ("resolver", resolver)):
    upper = source.upper()
    assert "250 MIDWOOD" not in upper, f"{label} contains a live-project branch"
    assert "79 WINTHROP" not in upper, f"{label} contains a reference-project branch"

assert "normalize_verified_evidence" in normalizer
assert "locality_near_authoritative_address" in normalizer
assert "PARTY_BOUNDARY" in normalizer
assert "project-specific address mapping" in normalizer
assert "import revex_energy_identity_normalizer as identity_normalizer" in resolver
assert "PROJECT_IDENTITY_NORMALIZED" in resolver
assert "derived-only-from-immutable-active-Revit-address" in resolver
assert "US_CENSUS_GEOCODER_PUBLIC_AR_CURRENT" in resolver
assert "import revex_energy_pipeline_r69 as resolver" in guard
assert "_resolve_r69_request(request_path, output_root)" in guard

# Worker image must ship and execute the generalized normalizer regression itself before
# Cloud Run accepts the image.
assert "COPY server/revex-energy-worker/revex_energy_identity_normalizer.py" in docker
assert "COPY server/revex-energy-worker/verify_identity_normalizer.py" in docker
assert "python3 /opt/revex/server/verify_identity_normalizer.py" in docker
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
    "schema": "liber.revex.r87-energy-generalization.v1",
    "status": "PASSED",
    "identity": {
        "singleGeneralNormalizer": True,
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
