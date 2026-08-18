'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const must = (text, ...markers) => { for (const marker of markers) if (!text.includes(marker)) throw new Error(`missing current connection marker: ${marker}`); };
const forbid = (text, ...markers) => { for (const marker of markers) if (text.includes(marker)) throw new Error(`forbidden current connection marker: ${marker}`); };

const docsPages = read('docs/liber-apps/apps/revex/docs-pages-r115.js');
const docsConvergence = read('docs/liber-apps/apps/revex/docs-convergence-r126.js');
const syncDocs = read('docs/liber-apps/apps/revex/sync-docs-r24.js');
const blocks = read('docs/liber-apps/apps/revex/blocks-palette-r126.js');
const bridge = read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const manager = read('src/Liber.Revex.Revit/UI/RendairWindowManager.cs');
const familyService = read('src/Liber.Revex.Revit/Services/FamilyPlacementService.cs');
const app = read('docs/liber-apps/apps/revex/app.js');
const ui = read('docs/liber-apps/apps/revex/ui-integrity.js');
const chatBoundary = read('docs/liber-apps/apps/revex/chat-convergence-r136.js');
const store = read('docs/liber-apps/apps/revex/store.js');
const firebaseService = read('docs/liber-apps/js/firebase-service.js');
const wallt = read('docs/liber-apps/apps/revex/wallt-control-plane.js');
const walltFixer = read('docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js');
const projectAccess = read('server/firebase-functions/project-access.js');
const projectChat = read('server/firebase-functions/project-chat.js');
const functionsMain = read('server/firebase-functions/main.js');
const functionsPackage = JSON.parse(read('server/firebase-functions/package.json'));
const projectRuntimeDeploy = read('server/revex-report-functions/deploy-current.ps1');

// DOCS: one Full Set library object owns ordered linked sheet pages, including legacy projection.
must(docsPages,
  "BUILD='20260818r134-docs-linked-pages1'",
  'fullSetAuthority:true',
  "fullSetOrderAuthority:'full-set-page-number'",
  'legacySheetProjection:true',
  'function orderedSheets(file)',
  'function projectRows(rows)',
  'function mergeLegacySheet(file,row)',
  'derivedFromFullSet:true',
  'const rows=projectRows(s.library)',
  'singlePageStoragePath',
  'sheetIndex',
  'async function openFull(file)',
  'async function openSheet(file,sheet)'
);
must(docsConvergence,
  "owner:'docs-pages-r115'",
  'fullSetAuthority:true',
  'Docs ownership converged: r115 is the only final printing-set renderer.'
);
must(syncDocs,
  'async function publishSheetPages(projectId,revision,set,files)',
  "revexDocKind:'printing-set'",
  'const sheetIndex=await publishSheetPages',
  'printingSetId:set.id||null',
  'printingSetName:set.name||\'Printing Set\'',
  'sheetIndex,createdAt:at'
);
const publishStart = syncDocs.indexOf('async function publishSheetPages');
const publishEnd = syncDocs.indexOf('  const original=Store.syncPackage', publishStart);
if (publishStart < 0 || publishEnd <= publishStart) throw new Error('could not isolate Docs page-publish boundary');
const publishBody = syncDocs.slice(publishStart, publishEnd);
if (publishBody.includes('setDoc(')) throw new Error('sheet-page publisher must not create detached top-level Library documents');
if (publishBody.includes("revexDocKind:'printing-sheet'")) throw new Error('sheet-page publisher recreated detached printing-sheet objects');

// FAMILIES/BLOCKS: browser provider handoff stays opaque; Revit ExternalEvent owns mutation.
must(blocks,
  "provider:'blocks'",
  'walkOnly:true',
  'placementDistanceFt:3',
  'viewer.camera.position.clone().addScaledVector(dir,3)',
  'return{x:target.x,y:-target.z,z:target.y',
  "type:'liber:revex-integration-open'",
  "type:'liber:revex-integration-arm'",
  "type:'liber:revex-family-place-r126'",
  "type:'liber:revex-family-transform-r126'",
  "data.type==='liber:revex-integration-family-r126'"
);
must(bridge,
  'ConcurrentDictionary<string, PendingFamily> PendingFamilies',
  'ExternalEvent.Create(_familyHandler)',
  'liber:revex-family-place-r126',
  'liber:revex-family-transform-r126',
  'liber:revex-integration-arm',
  'liber:revex-integration-open',
  'BlocksFamilies',
  'host == "blocksrvt.com" || host.EndsWith(".blocksrvt.com"',
  'extension is ".rfa" or ".zip"',
  'PendingFamilies[token] = new PendingFamily(path, suggested, info.Length, DateTime.UtcNow, target)'
);
must(manager,
  'RevexWebIntegrationBridge.ConfigureFamilyPlacement();',
  'RevexWebIntegrationBridge.ReleaseFamilyPlacement();'
);
must(familyService,
  'private const double MaxHostDistanceFt = 8.0;',
  'private const int MaxZipEntries = 2048;',
  'private const long MaxExpandedZipBytes = 512L * 1024L * 1024L;',
  'double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;',
  'TryNearestFacePlacement(doc, symbol, point)',
  'TryNearestHostedPlacement(doc, symbol, level, point)',
  'ComputeReferences = true',
  'destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)',
  'new Transaction(doc, "REVEX · Place BIM family")',
  'placementType.Contains("ViewBased"',
  'placementType.Contains("Adaptive"',
  'placementType.Contains("Curve"',
  'unsupported placement type',
  'REVEX could not place'
);
forbid(blocks, 'doc.Create.NewFamilyInstance', 'new Transaction(');
forbid(familyService, 'ZipFile.ExtractToDirectory(path, extractedFolder)');

// CHAT: Secure Chat owns messages/storage; r136 owns exact active-project boundary.
must(app,
  'async function ensureChatEmbedded(context = state.selectedContext)',
  'Store.ensureProjectChat(state.projectId)',
  "frame.src = appUrl('secure-chat', { connId: state.chatConnId, embedded: 'revex' })",
  "type: 'liber:revex-chat-context'",
  'projectId: state.projectId'
);
must(store,
  'async ensureProjectChat(projectId)',
  "return this.fs.callFunction('ensureProjectChat', { projectId });"
);
must(firebaseService,
  "if (name === 'ensureProjectChat' && this.auth?.currentUser)",
  'async _callEnsureProjectChatHttp(payload)',
  'ensureProjectChatHttp'
);
must(chatBoundary,
  "BUILD='20260818r136-project-chat1'",
  "owner:'secure-chat'",
  'projectIsolated:true',
  "Project changed while Chat connection was resolving.",
  'Blocked a cross-project Chat connection',
  "sessionStorage.removeItem('liber_revex_chat_draft')",
  'frame.dataset.revexProjectId=projectId',
  'CHAT_FRAME_BOUNDARY'
);
must(ui,
  "loadScript('chat-convergence-r136.js?v=20260818r136-project-chat1','chat-convergence-r136')"
);
forbid(ui, 'function installChatProjectGuard()');

// CHAT backend is source-bound: preserve valid linked history, otherwise deterministic repair.
if (functionsPackage.main !== 'main.js') throw new Error('Firebase function composition must use main.js');
must(functionsMain,
  "const energy = require('./index')",
  "const projectChat = require('./project-chat')",
  'ensureProjectChatHttp: projectChat.ensureProjectChatHttp'
);
must(projectAccess, "'chat'", 'function projectAccessRole');
must(projectChat,
  "const CHAT_SCHEMA = 'liber.revex.project-chat.v1'",
  "getAuth().verifyIdToken",
  'projectAccessRole(project, user, uid)',
  "db.collection('users').where('role', '==', 'admin')",
  'project.chatConnId',
  "db.collection('chatConnections').where('projectId', '==', projectId)",
  'return `revex_project_${projectId}`',
  "key: `project:${projectId}`",
  "type: 'project'",
  'participants,',
  'memberIds: participants',
  'admins: chatAdmins',
  'batch.set(selected.ref, chatPatch, { merge: true })',
  'chatConnId: connId',
  "region: ['us-central1', 'europe-west1']",
  'cors: true',
  'exports.ensureProjectChatHttp = onRequest'
);
forbid(projectChat,
  'delete(',
  'recursiveDelete',
  "collection('messages')",
  "collection('chatMessages')"
);

// The one-command release must deploy that exact source-bound resolver; browser isolation alone is not enough.
must(projectRuntimeDeploy,
  "$ChatSource = Join-Path $Root 'server\\firebase-functions'",
  "Deploy source-bound authenticated Project Chat resolver",
  "'functions','deploy','ensureProjectChatHttp'",
  "'--source',$ChatSource",
  "REVEX_SOURCE_CANDIDATE=$SourceCandidate",
  "Verify-Function $GCloud 'ensureProjectChatHttp'",
  "Daily Report + revision documentation + Project Chat resolver are ACTIVE and source-bound"
);

// WALLT operates existing owners and exposes only bounded registered Fixer actions.
must(wallt,
  "const BUILD = '20260818-wallt-control2'",
  "const CHANNEL_HELPER = 'helper'",
  "const CHANNEL_FIXER = 'fixer'",
  'registerAdapter',
  'const adapterName = type.slice(0, separator)',
  'helperChat',
  'helperIssue'
);
must(walltFixer,
  "registerAdapter('current'",
  'reversibleLocalOnly:true',
  'sourceMutation:false',
  'docs_reassert_owner',
  'chat_reset_active_project',
  'bim_reapply_overlays',
  'energy_reopen_review'
);
forbid(wallt,
  "callFunction('ensureProjectChat'",
  'NewFamilyInstance',
  'PDFDocument.load',
  "'projects',projectId,'library'"
);
forbid(walltFixer, 'firebase.firestore', 'NewFamilyInstance', 'PDFDocument.load');

console.log(JSON.stringify({
  REVEX_CURRENT_PLATFORM_CONNECTIONS: 'PASSED',
  docs: {
    owner: 'docs-pages-r115',
    build: 'r134',
    fullSetAuthority: true,
    linkedSheetIndex: true,
    legacyDetachedSheetsFolded: true,
    detachedSheetLibraryWrites: false
  },
  families: {
    owner: 'FamilyPlacementService via RevexWebIntegrationBridge',
    provider: 'blocks',
    opaqueDownloadToken: true,
    revitExternalEventMutation: true,
    exactWalkZ: true,
    faceAndElementHostFallback: true,
    boundedZip: true,
    unsupportedPlacementFailsClosed: true
  },
  chat: {
    owner: 'secure-chat messages/storage + r136 project boundary',
    projectScoped: true,
    asyncRaceBlocked: true,
    serverMismatchFailsClosed: true,
    sourceBoundDeploymentRequired: true,
    existingHistoryPreserved: true,
    deterministicRepair: true,
    regions: ['us-central1','europe-west1']
  },
  wallt: {
    controlBuild: 'control2',
    executableFixerAdapters: true,
    operatorOnly: true,
    duplicateDomainOwner: false
  }
}));
