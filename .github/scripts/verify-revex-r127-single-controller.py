#!/usr/bin/env python3
from pathlib import Path
import importlib.util
import json
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8-sig")

def require(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker in text, f"missing required marker: {marker}"

def forbid(text: str, *markers: str) -> None:
    for marker in markers:
        assert marker not in text, f"forbidden marker present: {marker}"

controller = read("FINALIZE_REVEX.ps1")
launcher = read("FINALIZE_REVEX.cmd")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups_r125.py")
runner = read("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner_r125.py")
contracts_path = ROOT / "src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py"
gbxml = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py")
dyn = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn")
ui = read("docs/liber-apps/apps/revex/ui-integrity.js")

require(launcher,
        "raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX.ps1",
        "REVEX one-command current release finalizer",
        "pause >nul")
require(controller,
        '"clone","--depth","1","--branch","main","--single-branch"',
        '$SourceSha = $sha.Text.ToLowerInvariant()',
        "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
        "DEPLOY_REPORT_R126.ps1",
        "DEPLOY_RENDER_R126.ps1",
        "Compile exact-source Revit 2026 add-in",
        "Install-AddinAtomically",
        "Verify-LiveUi",
        "Wait-RevitClosed",
        "Reopen Revit 2026 and run one fresh SYNC ENGINEERING")
forbid(controller,
       "RECOVER_REVEX_ENERGY_CURRENT",
       "PUBLISH_REVEX_R49",
       "CanonicalSourceCommit",
       "FINALIZE_REVEX_CURRENT")

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

require(touchups,
        "MISSING_VT = 0.45",
        'authority = "REVEX_FIXED_MISSING_VT_0_45"',
        '"policy": "NATIVE_SCHEDULE_TOTAL_OVER_REGION_RESUM; ACTUAL_VT_ELSE_FIXED_0_45"',
        "return MISSING_VT")
forbid(touchups,
       "VT_CLEAR_FALLBACK = 0.60",
       'authority = "CODE_FALLBACK_TINTED"',
       'authority = "CODE_FALLBACK_CLEAR"')

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

spec = importlib.util.spec_from_file_location("revex_energy_contracts", contracts_path)
assert spec and spec.loader
contracts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = contracts
spec.loader.exec_module(contracts)
assert abs(float(contracts.DEFAULT_MISSING_VT) - 0.45) < 1e-9
for name in ("ArtifactKind", "ArtifactSpec", "ArtifactRef", "EvidenceBundle", "FilingPackage", "ContractError"):
    assert hasattr(contracts, name), name
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
    "currentUiIncluded": True,
    "typedEnergyContracts": True,
    "missingVt": 0.45,
    "actualVtPreserved": True,
    "r125GeometryCorrectionsPreserved": True,
    "externalDynamoSourceIdentical": True,
    "legacyRecoveryControllerUsed": False,
}, separators=(",", ":")))
