#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appRoot = path.join(root, 'docs/liber-apps/apps/revex');
const read = (name) => fs.readFileSync(path.join(appRoot, name), 'utf8');
const app = read('app.js');
const viewer = read('viewer-r26.js');
const history = read('history-r24.js');
const store = read('store.js');
const integrity = read('integrity.js');
const html = read('index.html');
const readme = read('README.txt');
const energy = read('energy-r27.js');

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}
function rejectText(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label}: forbidden ${pattern}`);
}

for (const [name, source] of Object.entries({ app, viewer, store, integrity, html })) {
  requireText(source, '20260813r44', `${name} build pin`);
  rejectText(source, /20260813r4[123]/, `${name} stale build pin`);
}

requireText(history, 'window.__revexViewerR26Instance', 'history current viewer binding');
requireText(history, "new CustomEvent('revex:bim-overlays-changed'", 'overlay state publication');
requireText(app, "button.textContent = state.showHiddenOnly ? 'Show visible' : 'Show hidden'", 'inverse visibility control');
requireText(app, 'elements.filter(modelRowInVisibilityMode)', 'tree visibility filter');
requireText(app, "setVisibilityMode?.(state.showHiddenOnly ? 'hidden-only' : 'normal')", 'viewer visibility mode binding');
requireText(viewer, "this.visibilityMode==='hidden-only'?hidden:!hidden&&!overlay?.deleted", 'viewer inverse visibility rule');
requireText(viewer, 'revexBaseInstanceMatrices', 'instance matrix preservation');
requireText(viewer, 'if(!visible)scale.set(0,0,0)', 'per-instance hide implementation');
requireText(viewer, 'this.instanceSlots.get(key)?.length', 'instanced transform eligibility');
requireText(store, "modular.getFunctions(fs.app, 'us-central1')", 'direct broker region');
requireText(store, "modular.httpsCallable(functions, 'runRevexEnergy', { timeout: 3600000 })", 'bounded managed retry');
requireText(store, 'throw energyCallableError(error)', 'broker error propagation');
requireText(integrity, "firestorePlain({ merge", 'same-realm Firestore options');
requireText(energy, 'const resultComplete = resultSource === currentSource', 'failed-result retry eligibility');
requireText(energy, 'autoRetryRevision !== currentSource', 'single automatic retry per page session');

const userVisible = [html, readme, read('energy-r27.js'), read('energy-contract-r40.js')].join('\n');
rejectText(userVisible, /79\s+Winthrop|2306\s+Ocean|31-00\s+47th|Faybyshenko|Chosen\s+MEP|B01304513/i, 'user-visible reference identity');

const visible = (mode, overlay) => {
  const hidden = Boolean(overlay?.hidden) && !overlay?.deleted;
  return mode === 'hidden-only' ? hidden : !hidden && !overlay?.deleted;
};
const cases = [
  ['normal', null, true],
  ['normal', { hidden: true }, false],
  ['normal', { deleted: true }, false],
  ['hidden-only', { hidden: true }, true],
  ['hidden-only', { hidden: false }, false],
  ['hidden-only', { hidden: true, deleted: true }, false],
];
for (const [mode, overlay, expected] of cases) {
  if (visible(mode, overlay) !== expected) throw new Error(`visibility truth table failed for ${mode} ${JSON.stringify(overlay)}`);
}

console.log('REVEX r44 Companion QA passed:', {
  currentViewerBinding: true,
  hideAndInverseShow: true,
  instancedVisibility: true,
  directManagedRetry: true,
  sameRealmFirestoreWrites: true,
  referenceIdentityExcluded: true,
});
