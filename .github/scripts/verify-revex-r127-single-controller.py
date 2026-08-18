#!/usr/bin/env python3
from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def path(rel: str) -> Path:
    return ROOT / rel

def read(rel: str) -> str:
    return path(rel).read_text(encoding="utf-8-sig")

def require(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker in text, f"missing required marker: {marker}"

def forbid(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker not in text, f"forbidden marker present: {marker}"

def git_blob_sha(rel: str) -> str:
    raw = path(rel).read_bytes()
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()

controller = read("FINALIZE_REVEX.ps1")
launcher = read("FINALIZE_REVEX.cmd")
energy_deploy = read("server/revex-energy-worker/DEPLOY_ENERGY_R127.ps1")
docker = read("server/revex-energy-worker/Dockerfile")
app_entry = read("server/revex-energy-worker/app_entry.py")
current_guard = read("server/revex-energy-worker/revex_energy_pipeline_current.py")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups.py")
runner = read("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner.py")
contracts_path = path("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
gbxml = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py")
dyn = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn")
ui = read("docs/liber-apps/apps/revex/ui-integrity.js")

# Versioned implementations are immutable shadows. Current behavior belongs to canonical files.
assert git_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups_r125.py") == "7e11be9fb0ef6cce2df205cb0a7827682f170735"
assert git_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner_r125.py") == "885b9fffc193671f0ed199a208fe3a3690e5a021"

require(launcher,
        "raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX.ps1",
        "REVEX one-command current release finalizer",
        "pause >nul")
require(controller,
        '"clone","--depth","1","--branch","main","--single-branch"',
        '$SourceSha = $sha.Text.ToLowerInvariant()',
        "DEPLOY_ENERGY_R127.ps1",
        "DEPLOY_REPORT_R126.ps1",
        "DEPLOY_RENDER_R126.ps1",
        "Compile exact-source Revit 2026 add-in",
        "Install-AddinAtomically",
        "Verify-LiveUi",
        "Wait-RevitClosed",
        "Reopen Revit 2026 and run one fresh SYNC ENGINEERING")
forbid(controller,
       "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
       "RECOVER_REVEX_ENERGY_CURRENT",
       "PUBLISH_REVEX_R49",
       "CanonicalSourceCommit",
       "FINALIZE_REVEX_CURRENT")

require(energy_deploy,
        "Build exact r127 Energy worker image",
        "Deploy private r127 Energy worker candidate",
        "Cut authenticated Energy broker over to verified candidate",
        "REVEX_SOURCE_CANDIDATE",
        "roles/datastore.user",
        "roles/storage.objectAdmin",
        "roles/aiplatform.user")
forbid(energy_deploy,
       "DEPLOY_ENERGY_CURRENT.ps1",
       "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
       ".Replace(",
       "runtime-fixed",
       "CanonicalSourceCommit",
       "REVEX_R49_SOURCE_")

require(docker,
        "COPY server/revex-energy-worker/revex_energy_pipeline_current.py",
        "REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_current.py",
        "/opt/revex/energy/revex_final_touchups.py",
        "/opt/revex/energy/revex_pipeline_runner.py",
        "Historical deploy scripts are retained as shadow files")
require(app_entry, "from revex_final_touchups import install_worker_touchups")
forbid(app_entry, "from revex_final_touchups_r125 import install_worker_touchups")
require(current_guard,
        "import revex_energy_pipeline_guard_r118 as shadow",
        "import revex_final_touchups as current_touchups",
        'runner = _energy_root / "revex_pipeline_runner.py"')

# Every current Companion/UI improvement remains in the same release gate.
require(controller,
        "verify-revex-current-generation-r53.js",
        "verify-revex-r99-webview-root-cache.js",
        "verify-revex-r126-functional-convergence.js")
require(ui,
        "appearance-convergence-r126.js",
        "docs-convergence-r126.js",
        "issues-convergence-r126.js",
        "issues-inspector-r126.js",
        "history-daily-r126.js",
        "blocks-palette-r126.js",
        "render-convergence-r126.js")

# Missing VT is intentionally deterministic in the canonical current layer only.
require(touchups,
        "MISSING_VT = 0.45",
        "REVEX_FIXED_MISSING_VT_0_45",
        "ACTUAL_VT_ELSE_FIXED_0_45",
        "import revex_final_touchups_r125 as _shadow")
forbid(touchups, "MISSING_VT = 0.60")

# Geometry corrections remain mandatory for every fresh Engineering Sync.
for marker in (
    "REVEX_R125_GEOMETRY_TOUCHUPS_BEGIN",
    "bbox-whole-door-r125",
    "CURTAIN_PANEL_GEOMETRY_HOST_PROOF_R125",
    "_r125_curtain_parent_candidates",
    'TOP_COVER_SEARCH_MAX_FT = float("inf")',
):
    require(gbxml, marker)

graph = json.loads(dyn)
nodes = [n for n in graph.get("Nodes", []) if "PythonNodeModels.PythonNode" in str(n.get("ConcreteType") or "")]
assert len(nodes) == 1, "gbXML Dynamo must contain exactly one authoritative Python node"
embedded = str(nodes[0].get("Code") or "").replace("\r\n", "\n").rstrip()
external = gbxml.replace("\r\n", "\n").rstrip()
assert embedded == external, "Dynamo embedded gbXML source drifted from external exporter"

# Evidence is typed by semantic role at the boundary; exact filenames remain only output/API adapters.
spec = importlib.util.spec_from_file_location("revex_energy_contracts", contracts_path)
assert spec and spec.loader
contracts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = contracts
spec.loader.exec_module(contracts)
assert abs(float(contracts.DEFAULT_MISSING_VT) - 0.45) < 1e-9
for name in ("ArtifactKind", "ArtifactSpec", "ArtifactRef", "EvidenceBundle", "FilingPackage", "ContractError", "ROLE_TO_KIND"):
    assert hasattr(contracts, name), name
require(read("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py"),
        '"revit-project-identity": ArtifactKind.PROJECT_IDENTITY',
        '"revit-schedule-evidence": ArtifactKind.SCHEDULE_EVIDENCE',
        '"weather-epw": ArtifactKind.WEATHER')
require(runner, "EvidenceBundle.from_request(request_path).require_sync_evidence()", "DEFAULT_MISSING_VT")

with tempfile.TemporaryDirectory(prefix="revex-r127-contract-") as tmp:
    root = Path(tmp)
    for spec_row in contracts.SPECS:
        if spec_row.required_for_complete:
            (root / spec_row.canonical_name).write_bytes(b"REVEX")
    package = contracts.FilingPackage.discover(root).require_complete()
    assert len(package.artifacts) >= 6

print(json.dumps({
    "REVEX_R127_SINGLE_CONTROLLER": "PASSED",
    "oneCommand": "FINALIZE_REVEX.cmd",
    "singleSourceSha": True,
    "cleanEnergyDeployer": True,
    "currentUiIncluded": True,
    "typedEnergyContracts": True,
    "versionedImplementationsShadowOnly": True,
    "missingVt": 0.45,
    "actualVtPreserved": True,
    "r125GeometryCorrectionsPreserved": True,
    "externalDynamoSourceIdentical": True,
    "legacyRecoveryControllerUsed": False,
}, separators=(",", ":")))
