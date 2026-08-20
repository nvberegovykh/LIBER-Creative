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
storage_access_deploy = read("firebase/deploy-current-storage-access.ps1")
contracts = read("src/Liber.Revex.Revit/Engineering/Energy/revex_energy_contracts.py")
touchups = read("src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups.py")
pipeline = read("server/revex-energy-worker/revex_energy_pipeline_current.py")
energy_docker = read("server/revex-energy-worker/Dockerfile")
energy_entry = read("server/revex-energy-worker/app_entry.py")
energy_app = read("server/revex-energy-worker/app.py")
identity_boundary = read("server/revex-energy-worker/verify_r95_consumer_boundary.py")
gbxml = read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py")
dyn = json.loads(read("src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn"))
ui = read("docs/liber-apps/apps/revex/ui-integrity.js")
experience = read("docs/liber-apps/apps/revex/experience-r144.js")
viewer_interaction = read("docs/liber-apps/apps/revex/viewer-interaction-r85.js")
mobile = read("docs/liber-apps/apps/revex/mobile-final-r122.js")
docs_pages = read("docs/liber-apps/apps/revex/docs-pages-r115.js")
chat_boundary = read("docs/liber-apps/apps/revex/chat-convergence-r136.js")
secure_chat = read("docs/liber-apps/apps/secure-chat/chat.js")
secure_chat_crypto = read("docs/liber-apps/apps/secure-chat/chat-crypto.js")
firebase_service = read("docs/liber-apps/js/firebase-service.js")
project_functions = read("server/firebase-functions/main.js")
project_security = read("server/firebase-functions/project-chat.js")
energy_broker = read("server/firebase-functions/index.js")
wallt_control = read("docs/liber-apps/apps/revex/wallt-control-plane.js")
wallt_fixer = read("docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js")
wallt_cycle = read("docs/liber-apps/apps/revex/wallt-cycle-history.js")
wallt_ui = read("docs/liber-apps/apps/revex/wallt-ui-r138.js")
blocks_palette = read("docs/liber-apps/apps/revex/blocks-palette-r126.js")
blocks_bridge = read("src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs")
revit_window = read("src/Liber.Revex.Revit/UI/RendairWindow.cs")
family_handler = read("src/Liber.Revex.Revit/Revit/RevexFamilyPlacementExternalHandler.cs")
family_placement = read("src/Liber.Revex.Revit/Services/FamilyPlacementService.cs")
en1_amendment = read("src/Liber.Revex.Revit/Engineering/Energy/revex_en1_amendment.py")
en1_identity_ui = read("docs/liber-apps/apps/revex/energy-identity-en1-r89.js")
durable_energy = read("server/revex-energy-worker/durable_execution.py")
family_receipts = read("src/Liber.Revex.Revit/Services/FamilyMutationReceiptService.cs")
design_versions = read("docs/liber-apps/apps/revex/design-versions-r52.js")
workspace = read("docs/liber-apps/apps/revex/workspace-r51.js")
render_agent = read("docs/liber-apps/apps/revex/render-agent.js")
render_client = read("docs/liber-apps/apps/revex/render-convergence-r126.js")
engineering_sync = read("src/Liber.Revex.Revit/Services/EngineeringSyncService.cs")
geometry_evidence = read("server/revex-energy-worker/revex_geometry_evidence.py")
store = read("docs/liber-apps/apps/revex/store.js")
app = read("docs/liber-apps/apps/revex/app.js")
dev_contract = read("REVEX-DEVELOPMENT-CONTRACT.md")
rules_qa = read(".github/scripts/verify-revex-r43-rules.js")

assert release["schema"] == "liber.revex.current-release.v2"
assert release["authority"] == "canonical-current-files"
assert release["operatorEntrypoint"] == "FINALIZE_REVEX.cmd"
assert release["acceptanceAction"] == "one fresh SYNC PROJECT after successful finalization"
assert release["current"]["releaseVerifier"] == ".github/scripts/verify-revex-current-release.py"
assert release["current"]["experienceRuntime"] == "docs/liber-apps/apps/revex/experience-r144.js"
assert release["current"]["viewerInteractionRuntime"] == "docs/liber-apps/apps/revex/viewer-interaction-r85.js"
assert release["current"]["walltControlRuntime"] == "docs/liber-apps/apps/revex/wallt-control-plane.js"
assert release["current"]["walltFixerAdaptersRuntime"] == "docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js"
assert release["current"]["walltCycleHistoryRuntime"] == "docs/liber-apps/apps/revex/wallt-cycle-history.js"
assert release["current"]["walltUiRuntime"] == "docs/liber-apps/apps/revex/wallt-ui-r138.js"
assert release["current"]["chatBoundaryRuntime"] == "docs/liber-apps/apps/revex/chat-convergence-r136.js"
assert release["current"]["secureChatRuntime"] == "docs/liber-apps/apps/secure-chat/chat.js"
assert release["current"]["secureChatCryptoRuntime"] == "docs/liber-apps/apps/secure-chat/chat-crypto.js"
assert release["current"]["firebaseServiceRuntime"] == "docs/liber-apps/js/firebase-service.js"
assert release["current"]["projectRuntimeFunctions"] == "server/firebase-functions/main.js"
assert release["current"]["projectRuntimeSecurity"] == "server/firebase-functions/project-chat.js"
assert release["current"]["renderRuntime"] == "docs/liber-apps/apps/revex/render-agent.js"
assert release["current"]["renderBrokerRuntime"] == "server/firebase-functions/index.js"
assert release["current"]["renderBrokerFunction"] == "runRevexGoogleRender"
assert release["current"]["renderBrokerRegion"] == "us-central1"
assert release["current"]["energyDeployer"] == "server/revex-energy-worker/deploy-current.ps1"
assert release["current"]["reportDeployer"] == "server/revex-report-functions/deploy-current.ps1"
assert release["current"]["accessDeployer"] == "firebase/deploy-current-access.ps1"
assert release["current"]["storageAccessDeployer"] == "firebase/deploy-current-storage-access.ps1"
assert release["current"]["legacyDownloadTokenRevoker"] == "server/firebase-functions/revoke-revex-download-tokens.js"
assert release["current"]["familyMutationReceipts"] == "src/Liber.Revex.Revit/Services/FamilyMutationReceiptService.cs"
assert release["current"]["geometryEvidenceValidator"] == "server/revex-energy-worker/revex_geometry_evidence.py"
for principle in (
    "oneSourceCommitPerRelease", "versionedImplementationsAreShadows",
    "shadowFilesAreNeverDeletedByFinalization", "shadowControllersAreNeverInvokedByFinalization",
    "installedPreviousAddinBecomesTimestampedShadow", "immutableProjectRevisionsAreNeverRewritten",
    "currentRuntimeUsesCanonicalFacades", "packageFilenamesAreBoundaryAdaptersNotInternalArchitecture",
    "candidateWorkersProveReadyBeforeBrokerCutover", "liveFirestoreRulesArePreservedBeforeRevexAccessPatch",
    "liveStorageRulesArePreservedBeforeRevexAccessPatch",
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
     "firebase\\deploy-current-storage-access.ps1",
     '$StorageBucket = "liber-apps-cca20.firebasestorage.app"',
     "REVEX one-command full current release finalizer",
     "Scope: Companion + WALLT Helper/Fixer + BIM + Design Book + Spec Book + Docs + Chat + Issues + History + Blocks + Render + Revit add-in + Energy + Report + access.",
     "Docs Full Set + linked-page behavioral contract",
     "Project-isolated Secure Chat contract",
     "Project Chat membership isolation contract",
     "REVEX and Secure Chat Storage access contract",
     "Bounded Report PDF and exact-project object boundary contract",
     "Single-realm Firebase SDK and Auth instance contract",
     "Secure Chat direct/group encryption contract",
     "Secure Chat identity recovery and Firebase realm ownership contract",
     "Browser credential and authenticated proxy boundary contract",
     "Responsive and accessible UI recovery contract",
     "Non-destructive Revit Space recovery contract",
     "Publication-only Applicant/Modeler Apply-to-EN-1 contract",
     "Executable WALLT Helper/Fixer adapter contract",
     "Visible WALLT Helper/Fixer UI contract",
     "docs-pages-r115.js",
     "experience-r144.js",
     "viewer-interaction-r85.js",
     "verify-revex-r144-experience.js",
     "verify-revex-google-render-broker.js",
     "every changed Companion/Chat/Spec runtime asset is byte-exact",
     "wallt-fixer-adapters-r137.js",
     "wallt-ui-r138.js",
     "Verify canonical server-side Google Render provider prerequisite",
     "authenticated runRevexGoogleRender broker",
     "gemini-3.1-flash-image",
     "Stage and verify current Energy candidate without broker cutover",
     "Verify current Companion UI and Render runtime are live before access/Energy cutover",
     "Deploy preserved source-bound project access rules",
     "Deploy preserved source-bound Storage access rules",
     "Deploy source-bound Report, Daily Report, Project Chat and secure device services",
     "ensureProjectChatHttp",
     "recoverSecureChatIdentityHttp",
     "saveFcmTokenHttp",
     "Cut Energy broker to the already-verified current candidate",
     "Capture-RulesReleasePointers",
     "Restore-RulesReleasePointers",
     "Previous Firestore and Storage release pointers restored.",
     '"-StorageBucket",$StorageBucket',
     '$verifyFunction "runRevexEnergy" "us-central1" $BrokerSa $StorageBucket',
     '& $verifyFunction $functionName $Region $ReportSa $StorageBucket',
     "Install-AddinAtomically",
     "previousInstalledRevisionShadow",
     "run ONE fresh SYNC PROJECT")
forbid(finalizer,
       "RenderDeferredFirstIssuance", "Render is deferred", "Stage, warm and verify current Render candidate",
       "Cut Render broker", "DEPLOY_ENERGY_R127.ps1", "DEPLOY_RENDER_R126.ps1", "DEPLOY_REPORT_R126.ps1",
       "RECOVER_REVEX_ENERGY_CURRENT", "FINALIZE_REVEX_CURRENT", "PUBLISH_REVEX_R49",
       '"firebase\\r49-live-rules\\firestore.rules"')
assert finalizer.index("Stage and verify current Energy candidate") < finalizer.index("Verify current Companion UI and Render runtime")
assert finalizer.index("Deploy preserved source-bound project access rules") < finalizer.index("Cut Energy broker to the already-verified current candidate")
assert finalizer.index("Deploy preserved source-bound Storage access rules") < finalizer.index("Cut Energy broker to the already-verified current candidate")
assert finalizer.index("Cut Energy broker to the already-verified current candidate") < finalizer.index("Install the exact same source revision into Revit")

for deployer in (energy_deploy, report_deploy, access_deploy):
    must(deployer, "$Verifier = Join-Path $Root", "verify-revex-current-release.py", "Validate full current REVEX revision")
    forbid(deployer, "PUBLISH_REVEX_R49")
must(access_deploy,
     "PreviousRulesetName", "ReleaseChanged", "Set-ReleaseRuleset",
     "Firebase Firestore project/chat emulator denial gate failed.",
     "Firestore rules rollback pointer verification failed.",
     "Previous Firestore ruleset restored.")
must(storage_access_deploy,
     "patch-live-storage-rules.js", "REVEX_SOURCE_CANDIDATE=$SourceCandidate",
     "request.auth.token.revexAdmin == true", "function revexStorageChatProjectBoundary(data)",
     "Expected exactly one live Storage release", "Previous Storage ruleset restored",
     "Storage rules rollback pointer verification failed.",
     "firebaserules.googleapis.com/v1/projects/$ProjectId/rulesets")
forbid(storage_access_deploy, "firebase deploy --only storage", "PUBLISH_REVEX_R49")
must(energy_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE",
     "REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_current.py",
     "REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py",
     "Energy candidate is not Ready; broker remains unchanged.",
     "Build exact current Energy worker image",
     "Deploy only the authenticated Energy and Google Render brokers",
     "functions:revex-energy:runRevexEnergy,functions:revex-energy:runRevexGoogleRender",
     "Energy broker is not attached to the controlled broker identity.",
     "Energy broker Storage bucket does not match the selected release bucket.")
must(energy_docker,
     "REVEX_PIPELINE=/opt/revex/server/revex_energy_pipeline_current.py",
     "REVEX_PIPELINE_IMPL=/opt/revex/energy/revex_energy_pipeline.py",
     "COPY server/revex-energy-worker/revex_geometry_evidence.py /opt/revex/server/revex_geometry_evidence.py",
     "assert callable(revex_geometry_evidence.validate_geometry_evidence)",
     "assert app.PIPELINE==Path('/opt/revex/server/revex_energy_pipeline_current.py')")
must(energy_entry,
     'os.environ.setdefault("REVEX_PIPELINE", "/opt/revex/server/revex_energy_pipeline_current.py")',
     'os.environ.setdefault("REVEX_PIPELINE_IMPL", "/opt/revex/energy/revex_energy_pipeline.py")')
must(energy_app,
     'PIPELINE = Path(os.environ.get("REVEX_PIPELINE", "/opt/revex/server/revex_energy_pipeline_current.py"))')
must(identity_boundary,
     "REVEX_R95_CONSUMER_BOUNDARY", "REVEX_PIPELINE_IMPL", "identity['missing']==[]")
must(report_deploy,
     "REVEX_SOURCE_CANDIDATE", "documentRevexRevision", "finalizeRevexDailyReport", "nodejs22",
     "verify-revex-report-security.js", "npm audit --omit=dev --audit-level=high",
     "pdf-parse@2.4.5", "pdfjs-dist@5.4.296", "uuid@11.1.1",
     "controlled project-runtime identity", "eventTrigger.serviceAccountEmail-ne $ReportSa",
     "$ChatSource = Join-Path $Root 'server\\firebase-functions'",
     "Deploy source-bound authenticated Project Chat resolver",
     "'functions','deploy','ensureProjectChatHttp'",
     "'functions','deploy','recoverSecureChatIdentityHttp'",
     "'functions','deploy','saveFcmTokenHttp'",
     "'--source',$ChatSource",
     "Verify-Function $GCloud 'ensureProjectChatHttp'",
     "Verify-Function $GCloud 'recoverSecureChatIdentityHttp'",
     "Verify-Function $GCloud 'saveFcmTokenHttp'",
     "Daily Report, revision documentation, Project Chat and secure device services are ACTIVE and source-bound")
must(access_deploy,
     "firebaserules.googleapis.com", "patch-live-firestore-rules.js", "revex-project-access-r43.rules",
     "REVEX_SOURCE_CANDIDATE=", "firestore:rules", "preserve the live ruleset",
     "request.auth.token.revexAdmin == true",
     "function revexR43ChatProjectBoundary(data)",
     "function revexR43ImmutableProjectLane(projectCollection)",
     "function revexR43ProjectChatBindingAbsent(data)",
     "function revexR43BrowserChatCreateAllowed(data)",
     "projectCollection == 'revexRenderJobs'",
     "match /revexRenderJobs/{jobId}",
     "immutableRevisionUpdateDeleteDenied")
# The self-hosted Qwen implementation remains preserved and independently valid, but is not a release owner.
must(render_deploy,
     "CandidateOnly", "BrokerOnly", "REVEX_SOURCE_CANDIDATE", "REVEX_WARM_TOKEN",
     "Assert-Warm", "Build exact current Render worker image")

must(ui,
     "chat-convergence-r136.js?v=20260818r136-project-chat1",
     "wallt-control-plane.js?v=20260818-wallt-control2",
     "wallt-cycle-history.js?v=20260818-wallt-cycle-history1",
     "wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1",
     "wallt-ui-r138.js?v=20260820r147-release1",
     "mobile-final-r122.js", "appearance-convergence-r126.js", "docs-convergence-r126.js",
     "docs-pages-r115.js?v=20260820r147-release1",
     "viewer-interaction-r85-loader.js?v=20260820r147-release1",
     "review-integrity-r50.js?v=20260820r147-release1",
     "experience-r144.js?v=20260820r147-release1",
     "issues-convergence-r126.js", "issues-inspector-r126.js", "history-daily-r126.js",
     "blocks-palette-r126.js?v=20260820r147-release1", "render-convergence-r126.js", "bim-properties-r117.js")
must(mobile,
     "repeat(7,minmax(0,1fr))", "max-width:100vw", "r122-look", "r122-move",
     "function setWalk(on)", "function normalizeDocs()", "revex-r122-guide")
must(docs_pages,
     "BUILD='20260820r144-docs-disclosure1'", "fullSetAuthority:true", "legacySheetProjection:true", "function projectRows(rows)",
     "derivedFromFullSet:true", "const rows=projectRows(s.library)", "legacyStandaloneSheets:'folded-into-parent'")
must(experience,
     "BUILD='20260820r144-experience1'", "presentationOnly:true", "mobileDocsDisclosure:true",
     "prefers-reduced-motion", "#measure-toggle", "revex-doc-preview-expanded")
must(viewer_interaction,
     "BUILD='20260820r145-viewer-interaction3'", "measurePoints:2", "measurePrecisionInches:1/16",
     "function formatArchitecturalDistance", "function visibleSurfaceHits", "function syntheticCutHit", "function mergeCutOccluder",
     "pointInsideCompositeMeshes(group.meshes,sample)", "function measureGeometryAuthority")
must(chat_boundary,
     "owner:'secure-chat'", "projectIsolated:true", "storageOwner:'secure-chat'",
     "Project changed while Chat connection was resolving.", "Blocked a cross-project Chat connection",
     "sessionStorage.removeItem('liber_revex_chat_draft')", "CHAT_FRAME_BOUNDARY")
must(secure_chat,
     "secure-chat/identity-mismatch", "expectedPublishedFingerprint", "cannot be reconstructed",
     "reauthenticateWithPopup", "reauthenticateWithCredential", "requirePublishedSelf:false",
     "identityFingerprints: cryptoMeta.identityFingerprints || null")
must(secure_chat_crypto,
     "generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits'])",
     "JSON.stringify({ crv:'P-256', kty:'EC', x:jwk.x, y:jwk.y })")
must(firebase_service,
     "if (window.self !== window.top) return;",
     "this.registerMessaging(user).catch(()=>{});",
     "_callAuthenticatedHttp('saveFcmTokenHttp', payload)",
     "_callAuthenticatedHttp('recoverSecureChatIdentityHttp', payload)")
must(project_functions,
     "recoverSecureChatIdentityHttp: projectChat.recoverSecureChatIdentityHttp",
     "saveFcmTokenHttp: projectChat.saveFcmTokenHttp")
must(project_security,
     "authenticatedToken(req, { checkRevoked:true })", "RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60",
     "expectedPublishedFingerprint !== currentFingerprint", "secureChatIdentityRecoveryAudit",
     "serverSecureState/${uid}/pushTokens")
forbid(project_security, "privateKey")
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
     "const BUILD='20260820r144-wallt-context1'", "controlOwner:'wallt-control-plane'", "storageOwner:null",
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
     "RevexFamilyPlacementExternalHandler", "handler.AttachExternalEvent(externalEvent)",
     "handler?.Close();", "receiptStatus,", "IsTrustedCompanionMessageSource(e.Source)",
     "_trustedCompanionSource = trustedSource")
must(revit_window, "RevexWebIntegrationBridge.IsTrustedCompanionMessageSource(e.Source)")
forbid(blocks_bridge, "_familyExternalEvent.Raise()")
must(family_handler,
     "enum PumpState { Idle, WakeOutstanding, Executing, Closed }", "MaxQueuedRequests = 16",
     "response == ExternalEventRequest.Pending || response == ExternalEventRequest.TimedOut",
     "abandoned = _queue.ToList()", "FailRemainingAfterPendingTransaction()", "ReceiptRecoveryPending",
     "ReceiptBlockedNotStarted", "FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None",
     "FileMode.Open, FileAccess.Read, FileShare.Read", "SHA256.HashData(lockedSnapshot)",
     "item.Placement with { Path = verifiedAsset!.Path }")
must(family_placement,
     "double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;",
     "TryNearestFacePlacement(doc, symbol, point)", "TryNearestHostedPlacement(doc, symbol, level, point)",
     "MaxHostDistanceFt = 8.0", "MaxZipEntries = 2048", "MaxExpandedZipBytes = 512L * 1024L * 1024L",
     "destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)", "unsupported placement type",
     "FileStream directLock = new(path, FileMode.Open, FileAccess.Read, FileShare.Read)",
     "FileStream familyLock = new(family.Path, FileMode.Open, FileAccess.Read, FileShare.Read)",
     "SHA256.HashData(familyLock)")
forbid(family_placement, "ZipFile.ExtractToDirectory(path, extractedFolder)")
must(en1_amendment,
     'MODE = "EN1_IDENTITY_AMENDMENT"', "fill_people_identity_preserving_package",
     '"geometryCoRerun": False', '"energyPlusRerun": False', '"comcheckRerun": False',
     '"signatureSealChanged": False')
must(en1_identity_ui,
     "energy-en1-publication", "Apply to EN-1", "applyEn1IdentityAmendment",
     "GeometryCo, OpenStudio/EnergyPlus and COMcheck do not rerun",
     "signature and seal remain unchanged")
must(energy_broker,
     "EN1_AMENDMENT_MODE", "parentResultRevision", "signatureSealChanged !== false")
must(durable_energy,
     'str(state.get("workerResponsePath") or "") == cache_path')
must(family_receipts,
     "COMPLETED_PENDING_SOURCE_SYNC", "internal static void Reserve", "internal static void Complete",
     "CompletedForSync", "internal static void Acknowledge",
     "liber.revex.family-mutation-receipt.v2", "PREPARED_AWAITING_REVIT_COMMIT",
     "RevitDataStorage = Autodesk.Revit.DB.ExtensibleStorage.DataStorage",
     'WitnessVendorId = "LIBR"', 'FieldIdentityDigest = "IdentityDigest"',
     "RecordCommittedWitness", "MutationIdentityDigest(context, operation, request)",
     "immutable source sync was blocked", "WriteNewAtomic(acknowledged, amended)",
     "Never return a mutable local result as authority")
forbid(family_receipts, "return local.Clone()")
must(geometry_evidence,
     "def validate_geometry_evidence", "active-revit-document-processed-energy-geometry",
     "documentFingerprint", "linearUnit", "square-foot")
must(design_versions,
     "liber.revex.design-property-versions.v1", "lightweight-property-overlay",
     "Sync to Design Book", "async function syncToDesignBook",
     "propertyVersions: rows", "Version retained.")

# One current Render owner: the project-authenticated Google image broker. Qwen
# remains preserved as a non-owning shadow and is not used by this release path.
forbid(workspace, "render-selfhost-r54.js")
must(workspace, "captureRenderReference", "googleRender: true", "selfHostedRender: false")
must(render_agent,
     "gemini-3.1-flash-image", "runRevexGoogleRender", "Store.fileBlob(resultPath)",
     "captureRenderReference", "GEOMETRY LOCK", "saveResultToDesignBook",
     "Google AI · project secured", "Sign in to LIBER Apps before rendering")
for forbidden in ("GoogleAuthProvider", "reauthenticateWithPopup", "linkWithPopup",
                  "x-goog-user-project", "google-ai-project", "google-ai-connect"):
    forbid(render_agent, forbidden)
must(energy_broker,
     "exports.runRevexGoogleRender = onCall", "assertProjectAccess(projectId, uid, request.auth.token || {})",
     "acceptGoogleRenderJob", "transaction.create(refs.lease",
     "GOOGLE_RENDER_MAX_SOURCE_BYTES", "GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES",
     "new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })",
     "projects/${projectId}/revex/renders/${jobId}", "resultPath")
must(project_functions, "...energy")
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
render_capabilities = release["requiredCapabilities"]["render"]
for marker in (
    "Firebase-authenticated runRevexGoogleRender project broker",
    "ordinary users receive no Google Cloud IAM",
    "server-only one-shot lease",
    "never permanent tokenized download URLs",
):
    assert any(marker in capability for capability in render_capabilities), marker
blocks_capabilities = release["requiredCapabilities"]["blocks"]
for marker in (
    "in-transaction Revit DataStorage witness",
    "blocks altered replay",
    "acknowledgement publishes the terminal acknowledged receipt before deleting pending state",
):
    assert any(marker in capability for capability in blocks_capabilities), marker

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
    "projectChatSourceBoundDeploymentRequired": True,
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
