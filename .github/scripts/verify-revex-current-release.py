#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8-sig")


def must(text: str, *markers: str) -> None:
    for marker in markers:
        if marker not in text:
            raise AssertionError(f"missing current-release marker: {marker}")


def forbid(text: str, *markers: str) -> None:
    for marker in markers:
        if marker in text:
            raise AssertionError(f"forbidden current-release marker: {marker}")


def git_index_blob_sha(rel: str) -> str:
    result = subprocess.run(
        ["git", "ls-files", "--stage", "--", rel],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    fields = result.stdout.strip().split()
    if len(fields) < 2:
        raise AssertionError(f"tracked shadow file is missing from the Git index: {rel}")
    return fields[1].lower()


release = json.loads(read("REVEX_CURRENT_RELEASE.json"))
finalizer = read("FINALIZE_REVEX.ps1")
launcher = read("FINALIZE_REVEX.cmd")
energy_deploy = read("server/revex-energy-worker/deploy-current.ps1")
render_deploy = read("server/revex-render-worker/deploy-current.ps1")
report_deploy = read("server/revex-report-functions/deploy-current.ps1")
access_deploy = read("firebase/deploy-current-access.ps1")
contracts = read("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups.py")
pipeline = read("server/revex-energy-worker/revex_energy_pipeline_current.py")
gbxml = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py")
dyn = json.loads(read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn"))
ui = read("docs/liber-apps/apps/revex/ui-integrity.js")
mobile = read("docs/liber-apps/apps/revex/mobile-final-r122.js")
docs_pages = read("docs/liber-apps/apps/revex/docs-pages-r115.js")
chat_boundary = read("docs/liber-apps/apps/revex/chat-convergence-r136.js")
wallt_control = read("docs/liber-apps/apps/revex/wallt-control-plane.js")
wallt_fixer = read("docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js")
wallt_cycle = read("docs/liber-apps/apps/revex/wallt-cycle-history.js")
wallt_ui = read("docs/liber-apps/apps/revex/wallt-ui-r138.js")
blocks_palette = read("docs/liber-apps/apps/revex/blocks-palette-r126.js")
blocks_bridge = read("src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs")
family_placement = read("src/Liber.Revex.Revit/Services/FamilyPlacementService.cs")
design_versions = read("docs/liber-apps/apps/revex/design-versions-r52.js")
workspace = read("docs/liber-apps/apps/revex/workspace-r51.js")
render_agent = read("docs/liber-apps/apps/revex/render-agent.js")
render_client = read("docs/liber-apps/apps/revex/render-convergence-r126.js")
engineering_sync = read("src/Liber.Revex.Revit/Services/EngineeringSyncService.cs")
store = read("docs/liber-apps/apps/revex/store.js")
app = read("docs/liber-apps/apps/revex/app.js")
dev_contract = read("REVEX-DEVELOPMENT-CONTRACT.md")
rules_qa = read(".github/scripts/verify-revex-r43-rules.js")

assert release["schema"] == "liber.revex.current-release.v2"
assert release["authority"] == "canonical-current-files"
assert release["operatorEntrypoint"] == "FINALIZE_REVEX.cmd"
assert release["acceptanceAction"] == "one fresh SYNC ENGINEERING after successful finalization"
assert release["current"]["releaseVerifier"] == ".github/scripts/verify-revex-current-release.py"
assert release["current"]["walltControlRuntime"] == "docs/liber-apps/apps/revex/wallt-control-plane.js"
assert release["current"]["walltFixerAdaptersRuntime"] == "docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js"
assert release["current"]["walltCycleHistoryRuntime"] == "docs/liber-apps/apps/revex/wallt-cycle-history.js"
assert release["current"]["walltUiRuntime"] == "docs/liber-apps/apps/revex/wallt-ui-r138.js"
assert release["current"]["chatBoundaryRuntime"] == "docs/liber-apps/apps/revex/chat-convergence-r136.js"
assert release["current"]["energyDeployer"] == "server/revex-energy-worker/deploy-current.ps1"
assert release["current"]["reportDeployer"] == "server/revex-report-functions/deploy-current.ps1"
assert release["current"]["accessDeployer"] == "firebase/deploy-current-access.ps1"
for principle in (
    "oneSourceCommitPerRelease", "versionedImplementationsAreShadows",
    "shadowFilesAreNeverDeletedByFinalization", "shadowControllersAreNeverInvokedByFinalization",
    "installedPreviousAddinBecomesTimestampedShadow", "immutableProjectRevisionsAreNeverRewritten",
    "currentRuntimeUsesCanonicalFacades", "packageFilenamesAreBoundaryAdaptersNotInternalArchitecture",
    "candidateWorkersProveReadyBeforeBrokerCutover", "liveFirestoreRulesArePreservedBeforeRevexAccessPatch",
):
    assert release["principles"].get(principle) is True, principle

assert git_index_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups_r125.py") == "7e11be9fb0ef6cce2df205cb0a7827682f170735"
assert git_index_blob_sha("src/Liber.Revex.Revit/Engineering/Energy/revex_pipeline_runner_r125.py") == "885b9fffc193671f0ed199a208fe3a3690e5a021"
for rel in release["preservedShadows"]["energy"] + release["preservedShadows"]["deployment"]:
    assert (ROOT / rel).is_file(), f"preserved shadow disappeared: {rel}"

must(launcher,
     "raw.githubusercontent.com/nvberegovykh/LIBER-Creative/main/FINALIZE_REVEX.ps1",
     "REVEX one-command current release finalizer")
must(finalizer,
     '"clone","--depth","1","--branch","main","--single-branch"',
     '$SourceSha=$sha.Text.ToLowerInvariant()',
     ".github\\scripts\\verify-revex-current-release.py",
     "server\\revex-energy-worker\\deploy-current.ps1",
     "server\\revex-report-functions\\deploy-current.ps1",
     "firebase\\deploy-current-access.ps1",
     "REVEX one-command full current release finalizer",
     "Scope: Companion + WALLT Helper/Fixer + BIM + Design Book + Spec Book + Docs + Chat + Issues + History + Blocks + Render + Revit add-in + Energy + Report + access.",
     "Docs Full Set + linked-page behavioral contract",
     "Project-isolated Secure Chat contract",
     "Executable WALLT Helper/Fixer adapter contract",
     "docs-pages-r115.js",
     "BUILD='20260818r134-docs-linked-pages1'",
     "wallt-fixer-adapters-r137.js",
     "Verify canonical Google Render provider",
     "gemini-3.1-flash-image",
     "Stage and verify current Energy candidate without broker cutover",
     "Verify current Companion UI and Render runtime are live before access/Energy cutover",
     "Deploy preserved source-bound project access rules",
     "Deploy source-bound Report and Daily Report",
     "Cut Energy broker to the already-verified current candidate",
     "Install-AddinAtomically",
     "previousInstalledRevisionShadow",
     "run ONE fresh SYNC ENGINEERING")
forbid(finalizer,
       "RenderDeferredFirstIssuance", "Render is deferred", "Stage, warm and verify current Render candidate",
       "Cut Render broker", "DEPLOY_ENERGY_R127.ps1", "DEPLOY_RENDER_R126.ps1", "DEPLOY_REPORT_R126.ps1",
       "RECOVER_REVEX_ENERGY_CURRENT", "FINALIZE_REVEX_CURRENT", "PUBLISH_REVEX_R49")
assert finalizer.index("Stage and verify current Energy candidate") < finalizer.index("Verify current Companion UI and Render runtime")
assert finalizer.index("Deploy preserved source-bound project access rules") < finalizer.index("Cut Energy broker to the already-verified current candidate")
assert finalizer.index("Cut Energy broker to the already-verified current candidate") < finalizer.index("Install the exact same source revision into Revit")

for deployer in (energy_deploy, report_deploy, access_deploy):
    must(deployer, "$Verifier = Join-Path $Root", "verify-revex-current-release.py", "Validate full current REVEX revision")
    forbid(deployer, "PUBLISH_REVEX_R49")
must(energy_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE",
     "Energy candidate is not Ready; broker remains unchanged.",
     "Build exact current Energy worker image",
     "Cut authenticated Energy broker over to verified candidate")
must(report_deploy,
     "REVEX_SOURCE_CANDIDATE", "documentRevexRevision", "finalizeRevexDailyReport", "nodejs22")
must(access_deploy,
     "firebaserules.googleapis.com", "patch-live-firestore-rules.js", "revex-project-access-r43.rules",
     "REVEX_SOURCE_CANDIDATE=", "firestore:rules", "preserve the live ruleset",
     "allow read, write: if revexR43ProjectMember(projectId);")
# The self-hosted Qwen implementation remains preserved and independently valid, but is not a release owner.
must(render_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE", "REVEX_WARM_TOKEN",
     "Assert-Warm", "Build exact current Render worker image")

must(ui,
     "chat-convergence-r136.js?v=20260818r136-project-chat1",
     "wallt-control-plane.js?v=20260818-wallt-control2",
     "wallt-cycle-history.js?v=20260818-wallt-cycle-history1",
     "wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1",
     "wallt-ui-r138.js?v=20260818r138-wallt-ui1",
     "mobile-final-r122.js", "appearance-convergence-r126.js", "docs-convergence-r126.js",
     "docs-pages-r115.js?v=20260818r134-docs-linked-pages1",
     "issues-convergence-r126.js", "issues-inspector-r126.js", "history-daily-r126.js",
     "blocks-palette-r126.js", "render-convergence-r126.js", "bim-properties-r117.js")
must(mobile,
     "repeat(7,minmax(0,1fr))", "max-width:100vw", "r122-look", "r122-move",
     "function setWalk(on)", "function normalizeDocs()", "revex-r122-guide")
must(docs_pages,
     "fullSetAuthority:true", "legacySheetProjection:true", "function projectRows(rows)",
     "derivedFromFullSet:true", "const rows=projectRows(s.library)", "legacyStandaloneSheets:'folded-into-parent'")
must(chat_boundary,
     "owner:'secure-chat'", "projectIsolated:true", "storageOwner:'secure-chat'",
     "Project changed while Chat connection was resolving.", "Blocked a cross-project Chat connection",
     "sessionStorage.removeItem('liber_revex_chat_draft')", "CHAT_FRAME_BOUNDARY")
must(wallt_control,
     "const BUILD = '20260818-wallt-control2'", "CHANNEL_HELPER", "CHANNEL_FIXER",
     "const adapterName = type.slice(0, separator)", "Registered fixer actions (use the exact adapter:action type)",
     "A local fix may execute only a registered fixer adapter", "Never rewrite immutable Revit/Engineering revisions",
     "cycleReport", "windowHours: 24", "arbitraryDomMutation: false", "sourceMutation: false")
must(wallt_fixer,
     "reversibleLocalOnly:true", "sourceMutation:false", "registerAdapter('current'",
     "docs_reassert_owner", "chat_reset_active_project", "bim_reapply_overlays", "bim_refit_view",
     "ui_reopen_active_view", "mobile_reapply_constraints", "energy_reopen_review",
     "energyPipelineMutation:false")
must(wallt_cycle,
     "owner:'RevexStore.appendHistory'", "kind:'wallt-cycle'", "windowHours:24",
     "Store.appendHistory(projectId,historyEvent(row))", "newDatabaseOwner:false")
must(wallt_ui,
     "const BUILD='20260818r138-wallt-ui1'", "controlOwner:'wallt-control-plane'", "storageOwner:null",
     "open.id='revex-wallt-open'", "panel.id='revex-wallt-panel'",
     'data-wallt-mode="helper"', 'data-wallt-mode="fixer"', "owner[mode](request)",
     "safe-area-inset-bottom", "safe-area-inset-right", "newStorageOwner:false")
forbid(wallt_ui,
       "firebase.firestore", "localStorage.setItem", "sessionStorage.setItem",
       "walltAgent.response", "runEnergyServer(", "commitBimOverlay(")
must(blocks_palette,
     "placementDistanceFt:3", "viewer.camera.position.clone().addScaledVector(dir,3)",
     "return{x:target.x,y:-target.z,z:target.y", "type:'liber:revex-family-place-r126'")
must(blocks_bridge,
     "PendingFamilies[token] = new PendingFamily", "liber:revex-family-place-r126",
     "RevexFamilyPlacementExternalHandler", "_familyExternalEvent.Raise()")
must(family_placement,
     "double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;",
     "TryNearestFacePlacement(doc, symbol, point)", "TryNearestHostedPlacement(doc, symbol, level, point)",
     "MaxHostDistanceFt = 8.0", "MaxZipEntries = 2048", "MaxExpandedZipBytes = 512L * 1024L * 1024L",
     "destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)", "unsupported placement type")
forbid(family_placement, "ZipFile.ExtractToDirectory(path, extractedFolder)")
must(design_versions,
     "liber.revex.design-property-versions.v1", "lightweight-property-overlay",
     "Sync to Design Book", "async function syncToDesignBook",
     "propertyVersions: rows", "Version retained.")

# One current Render owner: the existing Google image client. Qwen remains a shadow enhancement.
forbid(workspace, "render-selfhost-r54.js")
must(workspace, "captureRenderReference", "googleRender: true", "selfHostedRender: false")
must(render_agent,
     "gemini-3.1-flash-image", "generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent",
     "Authorization", "x-goog-user-project", "responseModalities: ['TEXT', 'IMAGE']",
     "captureRenderReference", "saveResultToDesignBook", "Connect Google AI")
must(render_client,
     "providerOwner:'render-agent.js'", "browserInference:false", "localModelCache:false",
     "legacyIframe:false", "selfHostedEnhancementOptional:true")
forbid(render_client, "google-ai-connect')?.setAttribute('hidden'", "REVEX GPU · server warm")

must(store,
     "async createProject({ name, code, description, driveFileId })", "ownerId: uid", "memberIds: [uid]",
     "revexProject: true", "await this.ensureSpecProject(ref.id, null, project)",
     "Project creation must never be blocked by a secondary compatibility projection.",
     "await this.ensureProjectChat(ref.id)", "async addIssue(projectId, issue)", "revexIssues")
must(app, "new-project-button", "Store.createProject", "Issue save failed")
must(rules_qa,
     "memberContentAccess: true", "memberIssueWrite: true", "revexIssues', 'member_issue'",
     "assertSucceeds(updateDoc(memberIssue", "linkedSpecAccess: true", "aclProtected: true",
     "outsiderDenied: true", "crossProjectDenied: true", "adminAccess: true")

must(engineering_sync,
     "PublicationMinimum = 0.80", "QualityTarget = 0.95", 'Artifact(gbxml, "gbxml")',
     'Artifact(weather, "weather-epw")', '"revit-project-identity"', '"revit-schedule-evidence"',
     "writeBackToRevitAfterExport = false", "pdfInsertion = false")
for marker in (
    "REVEX_R125_GEOMETRY_TOUCHUPS_BEGIN", "bbox-whole-door-r125",
    "CURTAIN_PANEL_GEOMETRY_HOST_PROOF_R125", "_r125_curtain_parent_candidates",
    'TOP_COVER_SEARCH_MAX_FT = float("inf")',
):
    must(gbxml, marker)
nodes = [n for n in dyn.get("Nodes", []) if "PythonNodeModels.PythonNode" in str(n.get("ConcreteType") or "")]
assert len(nodes) == 1
assert str(nodes[0].get("Code") or "").replace("\r\n", "\n").rstrip() == gbxml.replace("\r\n", "\n").rstrip()

must(contracts,
     "class ArtifactKind", "class EvidenceBundle", "class FilingPackage",
     '"revit-project-identity": ArtifactKind.PROJECT_IDENTITY',
     '"revit-schedule-evidence": ArtifactKind.SCHEDULE_EVIDENCE',
     'ArtifactKind.EN1_PDF, "EN-1_READY_TO_INSERT.pdf", required_for_complete=True',
     '"REVEX_ENERGY_RELEASE_PACKAGE.zip"')
must(touchups,
     "MISSING_VT = 0.45", "def _actual_vt(row: dict)", "ACTIVE_ENVELOPE_EVIDENCE_VT",
     "_NON_ACTUAL_VT_AUTHORITIES", "REVEX_FIXED_MISSING_VT_0_45",
     "_artifact_by_role", 'revit-schedule-evidence',
     "Compatibility adapter only for previously-published revisions lacking role metadata")
must(pipeline,
     'CURRENT_RELEASE_PACKAGE = "REVEX_ENERGY_RELEASE_PACKAGE.zip"', "_verify_clean_zip",
     "en1.PUBLIC_REVIEW_NAMES", "CURRENT_FILING_PACKAGE",
     "FilingPackage.discover(output_root).require_complete()", '"userVisible"] = False',
     '"kind": "release-package"', '"entryCount": 9')

energy_root = ROOT / "src/Liber.Revex.Revit/Engineering/Energy"
if str(energy_root) not in sys.path:
    sys.path.insert(0, str(energy_root))
import revex_final_touchups as current_touchups
assert abs(float(current_touchups._actual_vt({"evidence": "Fenestration VT = 0.37"})) - 0.37) < 1e-9
assert abs(float(current_touchups._actual_vt({"visibleTransmittance": "0.52"})) - 0.52) < 1e-9
assert current_touchups._actual_vt({"evidence": "Fenestration U 0.30 SHGC 0.30"}) is None
assert current_touchups._actual_vt({"vt": 0.45, "visibleTransmittanceAuthority": "REVEX_FIXED_MISSING_VT_0_45"}) is None
assert current_touchups._actual_vt({"vt": 0.45, "visibleTransmittanceAuthority": "CODE_FALLBACK_CLEAR"}) is None
assert abs(float(current_touchups.MISSING_VT) - 0.45) < 1e-9

must(dev_contract,
     "One concern = one runtime owner", "BIM state lanes are separate",
     "Docs must not block the Companion UI", "Immutable Energy handoff is local data, not browser networking",
     "Current-project identity is evidence normalization, not a template value",
     "Every add-in source change must compile the real DLL in CI", "Windows deployment rules",
     "Diagnostics are evidence, not workload", "The objective is not to accumulate fixes")

expected_capabilities = {
    "projectIdentity", "wallt", "bim", "mobile", "designBook", "specBook", "docs", "chat",
    "issues", "history", "blocks", "render", "energy",
}
assert set(release.get("requiredCapabilities") or {}) == expected_capabilities

print(json.dumps({
    "REVEX_CURRENT_RELEASE": "PASSED",
    "operator": "FINALIZE_REVEX.cmd",
    "canonicalVerifierIndependentOfVersionShadows": True,
    "versionedFilesShadowOnly": True,
    "shadowIntegrityCheckoutLineEndingInvariant": True,
    "fullUiAndBimContract": True,
    "walltHelperFixerRequired": True,
    "walltBoundedFixerAdaptersRequired": True,
    "walltVisibleUiRequired": True,
    "wallt24hHistoryRequired": True,
    "docsLinkedPageRuntimeRequired": True,
    "projectIsolatedSecureChatRequired": True,
    "blocksRevitPlacementRequired": True,
    "googleRenderCanonical": True,
    "selfHostedRenderShadowOnly": True,
    "memberIssueWriteProven": True,
    "designVersionRetentionSemanticGate": True,
    "typedEvidence": True,
    "actualVtFieldPreserved": True,
    "actualVtTextEvidencePreserved": True,
    "fallbackVtNeverRelabeledActual": True,
    "missingVt": 0.45,
    "geometryCorrectionsPreserved": True,
    "completeFilingPackageRequired": True,
    "releasePackage": "REVEX_ENERGY_RELEASE_PACKAGE.zip",
    "releasePackageEntries": 9,
}, separators=(",", ":")))
