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
worker_deploy = read("server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1")
broker_deploy = read("server/revex-energy-worker/DEPLOY_ENERGY_BROKER_ONLY_R77.ps1")
updater = read("UPDATE_REVEX_ADDIN_CURRENT.ps1")
worker = read("server/revex-energy-worker/app.py")
broker = read("server/firebase-functions/index.js")
engineering_sync = read("src/Liber.Revex.Revit/Services/EngineeringSyncService.cs")
schedule_capture = read("src/Liber.Revex.Revit/Services/EngineeringScheduleEvidenceService.cs")
companion_bridge = read("src/Liber.Revex.Revit/Services/EngineeringCompanionWebBridge.cs")
store = read("docs/liber-apps/apps/revex/store.js")
core = read("src/Liber.Revex.Revit/Engineering/Energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py")
guard = read("server/revex-energy-worker/revex_energy_pipeline_guard.py")

# 1. Final command owns the complete Energy stack. It is not a worker-only recovery.
require(
    recovery,
    "REVEX complete Energy-stack convergence",
    "DEPLOY_ENERGY_WORKER_ONLY_R69.ps1",
    "DEPLOY_ENERGY_BROKER_ONLY_R77.ps1",
    "Assert-FullLiveEdge",
    "Worker + authenticated broker + IAM + installed Revit add-in are verified together.",
    "verify-revex-r69-energy-finish.py",
    "verify-revex-r73-energy-topology-fallback.py",
    "verify-revex-r77-energy-broker-worker-contract.js",
    "verify_geometryco_source_condition_r91.py",
    "verify_structured_schedule_evidence_r101.py",
    "verify_comcheck_evidence_r100.py",
)
forbid(
    recovery,
    "DEPLOY_REVEX_CURRENT_SERVICES.ps1",
    "firebase deploy",
    "Scope: Energy worker only",
    "Do NOT run SYNC ENGINEERING",
)
require(launcher, "Follow the revision-aware Retry vs SYNC ENGINEERING instruction printed above.")
forbid(launcher, "Do NOT rerun gbXML", "worker only")

# 2. Worker and broker deploy through direct gcloud primitives and bind to one source SHA.
require(
    worker_deploy,
    '"builds","submit"',
    '"run","deploy",$Service',
    "REVEX_SOURCE_CANDIDATE=$SourceCandidate",
    "REVEX_VERTEX_PROJECT=$VertexProject",
    "roles/run.invoker",
    "serviceAccount:$BrokerSa",
)
require(
    broker_deploy,
    "'functions','deploy','runRevexEnergy'",
    "'--runtime','nodejs22'",
    "REVEX_ENERGY_WORKER_URL=$WorkerUrl",
    "REVEX_ENERGY_BROKER_SERVICE_ACCOUNT=$BrokerSa",
    "REVEX_SOURCE_CANDIDATE=$ResolvedSource",
    "'--service-account',$BrokerSa",
)
forbid(broker_deploy.lower(), "firebase deploy", "firebase-tools")

# 3. Recovery verifies the actual live dependency edge after both deploys.
require(
    recovery,
    "REVEX_SOURCE_CANDIDATE",
    "REVEX_VERTEX_PROJECT",
    "runRevexEnergy is not ACTIVE",
    "Broker points to a different worker URL",
    "Broker runtime identity mismatch",
    "roles/run.invoker",
    "REVEX-CURRENT-SOURCE.json",
)

# 4. Every fresh Engineering Sync carries current geometry + structured schedules + T/Z/EN + EPW.
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
require(worker, '"sourceArtifacts": [str(path) for path in local_by_name.values()] + [str(page_facts)]')

# 5. Structured facts are additive before bounded PDF fallback; conflicts cannot be hidden by fallback.
require(guard, "revex_structured_schedule_projection", "pdfFallbackSkipped", "revex_comcheck_evidence")

# 6. GeometryCo quality floor and pinned implementation boundary remain intact.
require(core, "MINIMUM_MAPPING_CONFIDENCE = 0.75")
assert not re.search(r"MINIMUM_MAPPING_CONFIDENCE\s*=\s*0\.[0-6]", core)

# 7. Broker requires exact current revision, consent, complete artifact integrity and current worker result.
require(
    broker,
    "loadEngineeringRevision",
    "requireComcheckConsent",
    "REVEX_ENERGY_WORKER_URL",
    "engineering-sync.json",
    "revit-project-identity.json",
    "sha256",
    "BASELINE_UPDATED_GEOMETRY.osm",
    "PROPOSED_UPDATED_GEOMETRY.osm",
    "EN-1_READY_TO_INSERT.xlsx",
    "COMcheck_PROJECT_INPUT_READY.cxl",
    "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf",
    "COMcheck_BACKSTOP_RESULT.json",
)

# 8. Worker refuses COMPLETE unless the strict two-model + COMcheck + EN-1 contract is present.
require(
    worker,
    "BASELINE_UPDATED_GEOMETRY.osm",
    "PROPOSED_UPDATED_GEOMETRY.osm",
    "EN-1_READY_TO_INSERT.xlsx",
    "COMcheck_PROJECT_INPUT_READY.cxl",
    "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf",
    "COMcheck_BACKSTOP_RESULT.json",
    "compiledOsmCount",
    "officialDoeReport",
)

# 9. Current add-in updater must compile current source and preserve schedule-evidence wiring.
require(
    updater,
    "EngineeringScheduleEvidenceService.cs",
    "new EngineeringScheduleEvidenceService().Export",
    "REVIT-SCHEDULE-EVIDENCE.json",
    "Build current REVEX add-in for Revit 2026",
    "REVEX-CURRENT-SOURCE.json",
)

# 10. Runtime logic must remain reusable: no project reference values in generic Energy primitives.
combined = "\n".join((schedule_capture, guard, worker, recovery)).upper()
for forbidden in ("250 MIDWOOD", "79 WINTHROP", "G-002.00"):
    assert forbidden not in combined, f"project-specific runtime branch leaked into generic path: {forbidden}"

print({
    "REVEX_R104_FULL_STACK": "PASSED",
    "fullStackOwned": True,
    "worker": "direct-gcloud-cloudrun",
    "broker": "direct-gcloud-gen2",
    "revitEvidence": "geometry+schedules+T/Z/EN+EPW",
    "geometryCoMinimumConfidence": 0.75,
    "strictOutputs": 6,
    "workerOnlyFinalMode": False,
    "firebaseBrokerDeploy": False,
})
