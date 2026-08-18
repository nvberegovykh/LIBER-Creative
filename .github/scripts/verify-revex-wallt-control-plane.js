'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const control = read('docs/liber-apps/apps/revex/wallt-control-plane.js');
const ui = read('docs/liber-apps/apps/revex/ui-integrity.js');
const wallt = read('docs/liber-apps/js/wallt-agent.js');

function must(text, ...markers) {
  for (const marker of markers) if (!text.includes(marker)) throw new Error(`missing WALLT control marker: ${marker}`);
}
function forbid(text, ...markers) {
  for (const marker of markers) if (text.includes(marker)) throw new Error(`forbidden WALLT control marker: ${marker}`);
}

must(control,
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
  "data.type !== 'liber:wallt-control'",
  "event.origin !== location.origin",
  'root.__revexWalltControl = Object.freeze',
  "arbitraryDomMutation: false",
  "sourceMutation: false"
);

must(ui,
  "loadScript('wallt-control-plane.js?v=20260818-wallt-control1','wallt-control-plane')",
  "wallt:'helper+fixer+24h-cycle'"
);

must(wallt,
  'class WalltAgent',
  'async response({',
  'root.walltAgent = root.walltAgent || new WalltAgent()'
);

// The control plane is an orchestrator, not another product implementation.
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

// Fixer cannot invent arbitrary DOM/source mutations; deeper abilities arrive only through registered owners.
if (!control.includes("A local fix may execute only a registered fixer adapter")) throw new Error('fixer adapter boundary missing');
if (!control.includes("old generation files are evidence/rollback shadows")) throw new Error('generation ownership boundary missing');

console.log(JSON.stringify({
  REVEX_WALLT_CONTROL_PLANE: 'PASSED',
  helperPipeline: true,
  fixerPipeline: true,
  exactPanelNavigation: true,
  explicitIssueCommit: true,
  deeperAdapters: true,
  rolling24hLedger: true,
  sameOriginBridge: true,
  arbitrarySourceMutation: false,
  duplicateProductOwner: false
}));
