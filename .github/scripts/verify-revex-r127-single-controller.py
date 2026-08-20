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

def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

release = json.loads(read("REVEX_CURRENT_RELEASE.json"))
controller = read("FINALIZE_REVEX.ps1")
launcher = read("FINALIZE_REVEX.cmd")
energy_deploy = read("server/revex-energy-worker/deploy-current.ps1")
render_deploy = read("server/revex-render-worker/deploy-current.ps1")
report_deploy = read("server/revex-report-functions/deploy-current.ps1")
docker = read("server/revex-energy-worker/Dockerfile")
app_entry = read("server/revex-energy-worker/app_entry.py")
current_guard = read("server/revex-energy-worker/revex_energy_pipeline_current.py")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups.py")
runner = read("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner.py")
contracts_text = read("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
contracts_path = path("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
gbxml = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py")
dyn = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn")
ui = read("docs/liber-apps/apps/revex/ui-integrity.js")
mobile = read("docs/liber-apps/apps/revex/mobile-final-r122.js")
design_versions = read("docs/liber-apps/apps/revex/design-versions-r52.js")
engineering_sync = read("src/Liber.Revex.Revit/Services/EngineeringSyncService.cs")

# Release authority: one current surface, prior versions preserved as shadows.
assert release["schema"] == "liber.revex.current-release.v2"
assert release["authority"] == "canonical-current-files"
assert release["operatorEntrypoint"] == "FINALIZE_REVEX.cmd"
assert release["acceptanceAction"] == "one fresh SYNC PROJECT after successful finalization"
for principle in (
    "oneSourceCommitPerRelease",
    "versionedImplementationsAreShadows",
    "shadowFilesAreNeverDeletedByFinalization",
    "shadowControllersAreNeverInvokedByFinalization",
    "installedPreviousAddinBecomesTimestampedShadow",
    "immutableProjectRevisionsAreNeverRewritten",
    "currentRuntimeUsesCanonicalFacades",
    "packageFilenamesAreBoundaryAdaptersNotInternalArchitecture",
    "candidateWorkersProveReadyBeforeBrokerCutover",
):
    assert release["principles"].get(principle) is True, principle
assert release["current"]["energyDeployer"] == "server/revex-energy-worker/deploy-current.ps1"
assert release["current"]["reportDeployer"] == "server/revex-report-functions/deploy-current.ps1"
assert release["current"]["renderRuntime"] == "docs/liber-apps/apps/revex/render-agent.js"
for category in ("projectIdentity","bim","mobile","designBook","specBook","docs","issues","history","blocks","render","energy"):
    assert category in release["requiredCapabilities"], f"release contract lost capability category {category}"

# Historical implementations and deployment entrypoints remain shadows, never current authority.
assert git_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups_r125.py") == "7e11be9fb0ef6cce2df205cb0a7827682f170735"
assert git_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner_r125.py") == "885b9fffc193671f0ed199a208fe3a3690e5a021"
for rel in release["preservedShadows"]["energy"] + release["preservedShadows"]["deployment"]:
    assert path(rel).is_file(), f"shadow file was removed: {rel}"

# One operator command: fresh main -> exact SHA -> validate -> stage candidates -> UI -> cutover -> add-in.
require(launcher,
        "raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX.ps1",
        "REVEX one-command current release finalizer",
        "pause >nul")
require(controller,
        '"clone","--depth","1","--branch","main","--single-branch"',
        '$SourceSha=$sha.Text.ToLowerInvariant()',
        "server\\revex-energy-worker\\deploy-current.ps1",
        "server\\revex-report-functions\\deploy-current.ps1",
        "Stage and verify current Energy candidate without broker cutover",
        "Verify current Companion UI and Render runtime are live before access/Energy cutover",
        "Deploy preserved source-bound project access rules",
        "Deploy preserved source-bound Storage access rules",
        "Deploy source-bound Report, Daily Report, Project Chat and secure device services",
        "Cut Energy broker to the already-verified current candidate",
        "Verify mutable live issuance services are bound to the exact release source",
        "Compile exact-source Revit 2026 add-in",
        "Install-AddinAtomically",
        "Wait-RevitClosed",
        "App.before-finalize.",
        "previousInstalledRevisionShadow",
        "run ONE fresh SYNC PROJECT")
# Energy is intentionally the final broker cutover because a failed candidate never touches live Energy.
assert controller.index("Stage and verify current Energy candidate") < controller.index("Verify current Companion UI and Render runtime")
assert controller.index("Deploy source-bound Report, Daily Report, Project Chat and secure device services") < controller.index("Cut Energy broker to the already-verified current candidate")
assert controller.index("Cut Energy broker to the already-verified current candidate") < controller.index("Install the exact same source revision into Revit")
forbid(controller,
       "DEPLOY_ENERGY_R127.ps1",
       "DEPLOY_RENDER_R126.ps1",
       "DEPLOY_REPORT_R126.ps1",
       "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
       "RECOVER_REVEX_ENERGY_CURRENT",
       "PUBLISH_REVEX_R49",
       "CanonicalSourceCommit",
       "FINALIZE_REVEX_CURRENT")

# Canonical Energy deployer is source-bound and supports candidate-only / broker-only phases.
require(energy_deploy,
        "Build exact current Energy worker image",
        "Deploy private current Energy candidate",
        "Energy candidate is not Ready; broker remains unchanged.",
        "Deploy only the authenticated Energy and Google Render brokers",
        "functions:revex-energy:runRevexEnergy,functions:revex-energy:runRevexGoogleRender",
        "CandidateOnly",
        "BrokerOnly",
        "REVEX_SOURCE_CANDIDATE",
        "REVEX_STORAGE_BUCKET",
        "REVEX_VERTEX_PROJECT",
        "roles/datastore.user",
        "roles/storage.objectAdmin",
        "roles/serviceusage.serviceUsageConsumer",
        "roles/aiplatform.user")
forbid(energy_deploy,
       "DEPLOY_ENERGY_CURRENT.ps1",
       "DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1",
       ".Replace(",
       "runtime-fixed",
       "CanonicalSourceCommit",
       "REVEX_R49_SOURCE_")

# Report/Daily Report is current-source bound and verifies both deployed functions.
require(report_deploy,
        "REVEX_SOURCE_CANDIDATE",
        "Deploy source-bound post-sync revision documentation trigger",
        "Deploy source-bound authenticated Daily Report finalizer",
        "Deploy source-bound authenticated Project Chat resolver",
        "documentRevexRevision",
        "finalizeRevexDailyReport",
        "nodejs22")

# Current Companion revision: preserve every recent UI/UX/BIM concept.
require(controller,
        "verify-revex-current-generation-r53.js",
        "verify-revex-r99-webview-root-cache.js",
        "verify-revex-r126-functional-convergence.js")
require(ui,
        "mobile-final-r122.js",
        "appearance-convergence-r126.js",
        "docs-convergence-r126.js",
        "issues-convergence-r126.js",
        "issues-inspector-r126.js",
        "history-daily-r126.js",
        "blocks-palette-r126.js",
        "render-convergence-r126.js",
        "bim-properties-r117.js")
require(mobile,
        "repeat(7,minmax(0,1fr))",
        "max-width:100vw",
        "r122-look",
        "r122-move",
        "function setWalk(on)",
        "function normalizeDocs()",
        "revex-r122-guide")
require(design_versions,
        "liber.revex.design-property-versions.v1",
        "lightweight-property-overlay",
        "Sync to Design Book",
        "Version retained.")
forbid(design_versions, "versionKind: 'design-book-release'", "immutable: true")

# r126 convergence coverage must remain part of current acceptance.
r126 = read(".github/scripts/verify-revex-r126-functional-convergence.js")
for marker in (
    "fullSetAuthority:true", "derivedFromFullSet:true",
    "precedence:['instance-uv','type-texture','design-color-fallback','revit-material']",
    "No BIM element selected — showing every active issue",
    "TZ='America/New_York'", "technicalHistorySeparate:true", "finalizeRevexDailyReport",
    "placementDistanceFt:3", "RevexFamilyPlacementExternalHandler",
    "normalized-revit-plan-crop-v1", "unlocatedChangedElementIds",
    "ensure_server_warm()", "--min-instances=1", "localModelCache:false",
):
    require(r126, marker)

# Engineering Sync is immutable, role-declared evidence with hard-stop/review targets.
require(engineering_sync,
        "separate immutable revision",
        "PublicationMinimum = 0.80",
        "QualityTarget = 0.95",
        'Artifact(gbxml, "gbxml")',
        'Artifact(weather, "weather-epw")',
        '"revit-project-identity"',
        '"revit-schedule-evidence"',
        "writeBackToRevitAfterExport = false",
        "pdfInsertion = false")

# Energy current runtime uses canonical facades; proven versioned mechanics stay shadows.
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
require(touchups,
        "MISSING_VT = 0.45",
        "REVEX_FIXED_MISSING_VT_0_45",
        "ACTUAL_VT_ELSE_FIXED_0_45",
        "import revex_final_touchups_r125 as _shadow")
forbid(touchups, "MISSING_VT = 0.60")

# Geometry fixes remain mandatory for every fresh Engineering Sync.
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

# Typed evidence accepts semantic roles independent of local filenames.
spec = importlib.util.spec_from_file_location("revex_energy_contracts", contracts_path)
assert spec and spec.loader
contracts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = contracts
spec.loader.exec_module(contracts)
assert abs(float(contracts.DEFAULT_MISSING_VT) - 0.45) < 1e-9
for name in ("ArtifactKind", "ArtifactSpec", "ArtifactRef", "EvidenceBundle", "FilingPackage", "ContractError", "ROLE_TO_KIND"):
    assert hasattr(contracts, name), name
require(contracts_text,
        '"revit-project-identity": ArtifactKind.PROJECT_IDENTITY',
        '"revit-schedule-evidence": ArtifactKind.SCHEDULE_EVIDENCE',
        '"gbxml": ArtifactKind.GBXML',
        '"weather-epw": ArtifactKind.WEATHER')
require(runner, "EvidenceBundle.from_request(request_path).require_sync_evidence()", "DEFAULT_MISSING_VT")

with tempfile.TemporaryDirectory(prefix="revex-current-evidence-") as tmp:
    root = Path(tmp)
    identity = root / "identity-any-name.json"; identity.write_text("{}", encoding="utf-8")
    schedule = root / "schedule-any-name.json"; schedule.write_text("{}", encoding="utf-8")
    model = root / "model-any-name.xml"; model.write_text("<gbXML/>", encoding="utf-8")
    weather = root / "brooklyn-any-name.epw"; weather.write_text("LOCATION,Brooklyn,NY,USA,TMYx,725030,40.65,-73.95,-5,10\n", encoding="utf-8")
    page = root / "page-facts-any-name.json"; page.write_text("{}", encoding="utf-8")
    manifest = root / "engineering-manifest-any-name.json"
    rows = []
    for role, file in (("revit-project-identity", identity),("revit-schedule-evidence", schedule),("gbxml", model),("weather-epw", weather)):
        rows.append({"role":role,"name":file.name,"bytes":file.stat().st_size,"sha256":sha256(file)})
    manifest.write_text(json.dumps({"projectId":"p1","revision":"eng_1","artifacts":rows}), encoding="utf-8")
    request = root / "request.json"
    request.write_text(json.dumps({
        "projectId":"p1","revision":"eng_1","engineeringManifestPath":str(manifest),
        "pageFactsPath":str(page),"gbxmlPath":str(model),"weatherFile":str(weather),
        "sourceArtifacts":[str(identity),str(schedule),str(model),str(weather),str(manifest),str(page)]
    }), encoding="utf-8")
    bundle = contracts.EvidenceBundle.from_request(request).require_sync_evidence()
    assert set(bundle.artifacts) >= {
        contracts.ArtifactKind.PROJECT_IDENTITY, contracts.ArtifactKind.SCHEDULE_EVIDENCE,
        contracts.ArtifactKind.GBXML, contracts.ArtifactKind.WEATHER, contracts.ArtifactKind.PAGE_FACTS,
    }

# Canonical policy preserves actual VT and inserts exactly 0.45 only when absent.
energy_root = path("src/Liber.Revex.Revit/Engineering/Energy")
if str(energy_root) not in sys.path:
    sys.path.insert(0, str(energy_root))
import revex_final_touchups as current_touchups
class FakeReference:
    @staticmethod
    def _approved_profiles(_): return {}
    @staticmethod
    def _reference_path(): return Path(__file__)
    @staticmethod
    def _has_any_thermal(_): return False
    @staticmethod
    def _class_for_row(row): return str(row.get("kind") or "")
    @staticmethod
    def _profile_matches_row(_profile,_row): return False
    @staticmethod
    def _row_code(row): return str(row.get("assemblyType") or ""), str(row.get("assemblyType") or "")
with tempfile.TemporaryDirectory(prefix="revex-current-vt-") as tmp:
    root = Path(tmp)
    facts = root / "facts.json"
    facts.write_text(json.dumps({"pages":[{"pageType":"EN","envelope":[
        {"kind":"window","assemblyType":"W-ACTUAL","vt":0.37,"confidence":1.0},
        {"kind":"window","assemblyType":"W-MISSING","confidence":1.0}
    ]}]}), encoding="utf-8")
    req = root / "request.json"
    req.write_text(json.dumps({"revision":"eng_vt","pageFactsPath":str(facts),"sourceArtifacts":[]}), encoding="utf-8")
    projected = current_touchups.apply_request_touchups(req, root / "out", FakeReference)
    payload = json.loads(Path(projected).read_text(encoding="utf-8"))
    out = json.loads(Path(payload["pageFactsPath"]).read_text(encoding="utf-8"))
    actual, missing = out["pages"][0]["envelope"]
    assert abs(float(actual["vt"]) - 0.37) < 1e-9, actual
    assert abs(float(missing["vt"]) - 0.45) < 1e-9, missing
    assert missing["visibleTransmittanceAuthority"] == "REVEX_FIXED_MISSING_VT_0_45", missing

# External filing package remains deliberately named and complete.
with tempfile.TemporaryDirectory(prefix="revex-current-package-") as tmp:
    root = Path(tmp)
    for spec_row in contracts.SPECS:
        if spec_row.required_for_complete:
            (root / spec_row.canonical_name).write_bytes(b"REVEX")
    package = contracts.FilingPackage.discover(root).require_complete()
    assert len(package.artifacts) >= 6

print(json.dumps({
    "REVEX_CURRENT_RELEASE": "PASSED",
    "oneCommand": "FINALIZE_REVEX.cmd",
    "singleSourceSha": True,
    "canonicalDeployers": True,
    "candidateBeforeCutover": True,
    "versionedImplementationsShadowOnly": True,
    "currentUiIncluded": True,
    "mobileR122Preserved": True,
    "designPropertyVersionsPreserved": True,
    "r126FunctionalConvergencePreserved": True,
    "typedEnergyEvidence": True,
    "arbitraryEvidenceFilenamesViaRoles": True,
    "missingVt": 0.45,
    "actualVtPreserved": True,
    "r125GeometryCorrectionsPreserved": True,
    "externalDynamoSourceIdentical": True,
    "legacyRecoveryControllerUsed": False
}, separators=(",", ":")))
