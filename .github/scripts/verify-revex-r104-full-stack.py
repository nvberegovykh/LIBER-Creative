#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8-sig")

def require(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker in text, f"missing required marker: {marker}"

def forbid(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker not in text, f"forbidden marker present: {marker}"

recovery = read("RECOVER_REVEX_ENERGY_CURRENT.ps1")
launcher = read("RECOVER_REVEX_ENERGY_CURRENT.cmd")
current_deploy = read("server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1")
argv_fix = read("server/revex-energy-worker/DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1")
updater = read("UPDATE_REVEX_ADDIN_CURRENT.ps1")
worker = read("server/revex-energy-worker/app.py")
broker = read("server/firebase-functions/index.js")
engineering_sync = read("src/Liber.Revex.Revit/Services/EngineeringSyncService.cs")
schedule_capture = read("src/Liber.Revex.Revit/Services/EngineeringScheduleEvidenceService.cs")
companion_bridge = read("src/Liber.Revex.Revit/Services/EngineeringCompanionWebBridge.cs")
store = read("docs/liber-apps/apps/revex/store.js")
core = read("src/Liber.Revex.Revit/Engineering/Energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py")

# Current final recovery is intentionally Energy-only: immutable Revit evidence is
# preserved, worker + authenticated broker are redeployed, and no new Revit sync or
# add-in replacement is performed during a downstream retry.
require(
    recovery,
    "REVEX r125 Energy recovery - final filing touchups",
    "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
    "Energy worker + authenticated broker only",
    "No Revit sync, no add-in replacement, no BIM/Docs/Render mutation",
    "REVEX_ENERGY_RELEASE_PACKAGE.zip",
    "use Retry",
)
assert re.search(r'\$SourceCandidate\s*=\s*"[0-9a-f]{40}"', recovery, re.I), "recovery must pin an exact source SHA"
forbid(recovery, "DEPLOY_REVEX_CURRENT_SERVICES.ps1", "Scope: Energy worker only")
require(launcher, "Refreshing the current controller from GitHub main", "Retry / future Engineering Sync distinction")
forbid(launcher, "Do NOT rerun gbXML")

# The argv repair must remain a strict five-call wrapper around the current deployer,
# not a second divergent deployment implementation.
require(
    argv_fix,
    'DEPLOY_ENERGY_CURRENT.ps1',
    'REVEX Energy argv repair: PASS (5 exact calls)',
    '"auth" "list" "--filter=status:ACTIVE"',
    '"builds" "get-default-service-account"',
    '"run" "services" "describe" $Service',
    '"functions" "describe" "runRevexEnergy"',
    '-SourceCandidate $SourceCandidate',
)
require(current_deploy, "REVEX_SOURCE_CANDIDATE", "runRevexEnergy", "roles/run.invoker")

# Every fresh Engineering Sync still carries current geometry + structured schedules
# and the immutable weather / identity evidence used by the managed worker.
require(schedule_capture, "REVIT-SCHEDULE-EVIDENCE.json", "ScheduleSheetInstance", "placedOnSheets", "bodyRows")
require(
    engineering_sync,
    "revit-energy.xml",
    "weather.epw",
    "REVIT-PAGE-EVIDENCE.json",
    "REVIT-PROJECT-IDENTITY.json",
    'Directory.GetFiles(source.RunFolder, "*.json"',
)
require(companion_bridge, "output.EvidenceFiles", "files.Length", "AttachEngineeringSyncAsync")
require(store, "declaredArtifacts", "manifest mismatch", "for (let index = 0; index < files.length; index += 1)")

# GeometryCo quality floor remains unchanged.
require(core, "MINIMUM_MAPPING_CONFIDENCE = 0.75")
assert not re.search(r"MINIMUM_MAPPING_CONFIDENCE\s*=\s*0\.[0-6]", core)

# Broker requires exact revision + consent and worker/broker agree on the strict filing outputs.
require(broker, "loadEngineeringRevision", "requireComcheckConsent", "REVEX_ENERGY_WORKER_URL", "engineering-sync.json", "revit-project-identity.json", "sha256")
required = (
    "BASELINE_UPDATED_GEOMETRY.osm",
    "PROPOSED_UPDATED_GEOMETRY.osm",
    "EN-1_READY_TO_INSERT.xlsx",
    "COMcheck_PROJECT_INPUT_READY.cxl",
    "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf",
    "COMcheck_BACKSTOP_RESULT.json",
)
for item in required:
    assert item in worker and item in broker, f"strict output missing from worker/broker contract: {item}"
require(worker, "compiledOsmCount", "officialDoeReport")

# Add-in updating remains a separate explicit operation and must still compile the
# current Revit source with structured schedule evidence wired in.
require(updater, "EngineeringScheduleEvidenceService.cs", "REVIT-SCHEDULE-EVIDENCE.json", "Build current REVEX add-in for Revit 2026", "REVEX-CURRENT-SOURCE.json")

print({
    "REVEX_R104_FULL_STACK": "PASSED_CURRENT_ARCHITECTURE",
    "recoveryScope": "energy-worker+authenticated-broker",
    "revitRevisionMutationDuringRetry": False,
    "argvRepairCalls": 5,
    "revitEvidence": "geometry+schedules+T/Z/EN+EPW",
    "geometryCoMinimumConfidence": 0.75,
    "strictOutputs": len(required),
    "addinUpdateSeparated": True,
})
