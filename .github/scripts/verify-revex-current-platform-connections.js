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
const store = read('docs/liber-apps/apps/revex/store.js');
const wallt = read('docs/liber-apps/apps/revex/wallt-control-plane.js');

// DOCS: one Full Set library object owns ordered linked sheet pages.
must(docsPages,
  'fullSetAuthority:true',
  "fullSetOrderAuthority:'full-set-page-number'",
  'function orderedSheets(file)',
  'function replaceSheet(file,page,next)',
  'derivedFromFullSet:true',
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
  'extension is ".rfa" or ".zip"'
);
must(manager,
  'RevexWebIntegrationBridge.ConfigureFamilyPlacement();',
  'RevexWebIntegrationBridge.ReleaseFamilyPlacement();'
);
must(familyService,
  'private const double MaxHostDistanceFt = 8.0;',
  'new Transaction(doc, "REVEX · Place BIM family")',
  'placementType.Contains("ViewBased"',
  'placementType.Contains("Adaptive"',
  'placementType.Contains("Curve"',
  'unsupported placement type',
  'TryNearestHostedPlacement',
  'REVEX could not place'
);
forbid(blocks, 'doc.Create.NewFamilyInstance', 'new Transaction(');

// CHAT: the current project owns one secure-chat connection and resets at project boundary.
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
must(ui,
  'function installChatProjectGuard()',
  "root.addEventListener('revex:authoritative-project-bound'",
  "state.chatConnId=''",
  'state.chatLoaded=false',
  "frame.src='about:blank'",
  'CHAT_PROJECT_BOUNDARY'
);

// WALLT may operate these owners, but must not become their storage/engine implementation.
must(wallt,
  "const CHANNEL_HELPER = 'helper'",
  "const CHANNEL_FIXER = 'fixer'",
  'registerAdapter',
  'helperChat',
  'helperIssue'
);
forbid(wallt,
  "callFunction('ensureProjectChat'",
  'NewFamilyInstance',
  'PDFDocument.load',
  "'projects',projectId,'library'"
);

console.log(JSON.stringify({
  REVEX_CURRENT_PLATFORM_CONNECTIONS: 'PASSED',
  docs: {
    owner: 'docs-pages-r115',
    fullSetAuthority: true,
    linkedSheetIndex: true,
    detachedSheetLibraryWrites: false
  },
  families: {
    owner: 'FamilyPlacementService via RevexWebIntegrationBridge',
    provider: 'blocks',
    opaqueDownloadToken: true,
    revitExternalEventMutation: true,
    unsupportedPlacementFailsClosed: true
  },
  chat: {
    owner: 'app.js + secure-chat connection',
    projectScoped: true,
    projectBoundaryReset: true
  },
  wallt: {
    operatorOnly: true,
    duplicateDomainOwner: false
  }
}));
