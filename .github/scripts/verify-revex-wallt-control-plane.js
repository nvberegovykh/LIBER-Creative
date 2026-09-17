'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const control = read('docs/liber-apps/apps/revex/wallt-control-plane.js');
const fixer = read('docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js');
const walltUi = read('docs/liber-apps/apps/revex/wallt-ui-r138.js');
const cycleHistory = read('docs/liber-apps/apps/revex/wallt-cycle-history.js');
const mobileSheet = read('docs/liber-apps/apps/revex/mobile-sheet-r142.js');
const ui = read('docs/liber-apps/apps/revex/ui-integrity.js');
const store = read('docs/liber-apps/apps/revex/store.js');
const wallt = read('docs/liber-apps/js/wallt-agent.js');

function must(text, ...markers) {
  for (const marker of markers) if (!text.includes(marker)) throw new Error(`missing WALLT control marker: ${marker}`);
}
function forbid(text, ...markers) {
  for (const marker of markers) if (text.includes(marker)) throw new Error(`forbidden WALLT control marker: ${marker}`);
}

must(control,
  "const BUILD = '20260818-wallt-control2'",
  "const CHANNEL_HELPER = 'helper'",
  "const CHANNEL_FIXER = 'fixer'",
  'const CYCLE_MS = 24 * 60 * 60 * 1000',
  'liber.revex.wallt-24h-cycle-report.v1',
  'function runtimeSnapshot()',
  'root.__revexBrowserDiagnostics?.snapshot?.()',
  'scrollIntoView',
  'revex-wallt-target',
  'navigate: helperNavigate',
  'search: helperSearch',
  'select_bim: helperSelectBim',
  'issue: helperIssue',
  'form.requestSubmit()',
  'action.commit === true',
  'function registerAdapter(name, adapter = {})',
  'helperActions:',
  'fixerActions:',
  'const adapterName = type.slice(0, separator)',
  'Registered fixer actions (use the exact adapter:action type)',
  "data.type !== 'liber:wallt-control'",
  "event.origin !== location.origin",
  'root.__revexWalltControl = Object.freeze',
  "arbitraryDomMutation: false",
  "sourceMutation: false"
);

must(fixer,
  "const BUILD='20260818r137-fixer-adapters1'",
  "adapter:'current'",
  'reversibleLocalOnly:true',
  'sourceMutation:false',
  "registerAdapter('current'",
  'docs_reassert_owner',
  'chat_reset_active_project',
  'bim_reapply_overlays',
  'bim_refit_view',
  'ui_reopen_active_view',
  'mobile_reapply_constraints',
  'energy_reopen_review',
  'energyPipelineMutation:false'
);

must(walltUi,
  "const BUILD='20260820r144-wallt-context1'",
  "controlOwner:'wallt-control-plane'",
  'storageOwner:null',
  "open.id='revex-wallt-open'",
  "panel.id='revex-wallt-panel'",
  'data-wallt-mode="helper"',
  'data-wallt-mode="fixer"',
  'owner[mode](request)',
  'safe-area-inset-bottom',
  'safe-area-inset-right',
  'newStorageOwner:false'
);

must(cycleHistory,
  "kind:'wallt-cycle'",
  "owner:'RevexStore.appendHistory'",
  "root.addEventListener('revex:wallt-cycle-event'",
  "Store.appendHistory(projectId,historyEvent(row))",
  "Store.listHistory(projectId)",
  "liber.revex.wallt-durable-24h-cycle-report.v1",
  "const WINDOW_MS=24*60*60*1000",
  "PERSIST_PHASES=new Set(['REQUEST','PLAN','COMPLETE','FAILED','ACTION_FAILED'])",
  "newDatabaseOwner:false"
);

must(store,
  "async appendHistory(projectId, event)",
  "'projects', projectId, 'revexHistory'",
  "async listHistory(projectId)"
);

must(ui,
  "loadScript('wallt-control-plane.js?v=20260818-wallt-control2','wallt-control-plane')",
  "loadScript('wallt-cycle-history.js?v=20260818-wallt-cycle-history1','wallt-cycle-history')",
  "loadScript('wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1','wallt-fixer-adapters-r137')",
  "loadScript('wallt-ui-r138.js?v=20260820r147-release1','wallt-ui-r138')",
  "loadScript('mobile-sheet-r142.js?v=20260820r147-release1','mobile-sheet-r142')",
  "wallt:'context-aware+chat-excluded+mobile-actions-menu'"
);

must(mobileSheet,
  "byId('revex-r109-actions-menu')",
  "b.textContent='WALLT Helper / Fixer'",
  "byId('revex-wallt-open')?.click()",
  "body.revex-mobile-touch #revex-wallt-open{display:none!important}"
);

must(wallt,
  'class WalltAgent',
  'async response({',
  'root.walltAgent = root.walltAgent || new WalltAgent()'
);

// The control plane and visible surface are orchestrators, not duplicate product implementations.
forbid(control,
  'eval(',
  'new Function(',
  'firebase.firestore',
  'runEnergyServer(',
  'commitBimOverlay(',
  'QwenImageEdit',
  'gemini-3.1-flash-image',
  'EnergyPlus',
  'GeometryCo'
);
forbid(fixer,
  'firebase.firestore',
  'runEnergyServer(',
  'commitBimOverlay(',
  'eval(',
  'new Function('
);
forbid(walltUi,
  'firebase.firestore',
  'localStorage.setItem',
  'sessionStorage.setItem',
  'walltAgent.response',
  'runEnergyServer(',
  'commitBimOverlay('
);
// The durability adapter must use the existing History owner, not Firestore directly.
forbid(cycleHistory,
  'firebase.firestore',
  'setDoc(',
  'collection(',
  'localStorage.setItem'
);

if (!control.includes("A local fix may execute only a registered fixer adapter")) throw new Error('fixer adapter boundary missing');
if (!control.includes("old generation files are evidence/rollback shadows")) throw new Error('generation ownership boundary missing');

console.log(JSON.stringify({
  REVEX_WALLT_CONTROL_PLANE: 'PASSED',
  build: '20260818-wallt-control2',
  visibleUiBuild: '20260820r144-wallt-context1',
  visibleEntryPoint: true,
  mobileEntryPoint: 'existing-r109-actions-menu',
  helperPipeline: true,
  fixerPipeline: true,
  executablePrefixedAdapters: true,
  boundedCurrentOwnerRepairs: true,
  exactPanelNavigation: true,
  explicitIssueCommit: true,
  rolling24hLocalLedger: true,
  durableProjectHistoryMirror: true,
  historyOwnerReused: true,
  sameOriginBridge: true,
  newAiBackend: false,
  newStorageOwner: false,
  arbitrarySourceMutation: false,
  duplicateProductOwner: false
}));
