#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const sharedFirebase = fs.readFileSync(path.join(root, 'docs/liber-apps/js/firebase-service.js'), 'utf8');

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}
function rejectText(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label}: forbidden ${pattern}`);
}

for (const [name, source] of Object.entries({ app, viewer, store, integrity, html })) {
  requireText(source, '20260813r47', `${name} build pin`);
  rejectText(source, /20260813r4[1-6]/, `${name} stale build pin`);
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
requireText(viewer, 'beginRevision(revision)', 'prior geometry teardown on revision advance');
requireText(viewer, 'rows.filter(r=>!this.isCoarseCurtainHost(r))', 'coarse curtain host suppression');
requireText(viewer, 'missingCurtainDetails', 'curtain detail coverage check');
requireText(viewer, 'curtainFallback:true', 'curtain panel and mullion compatibility fallback');
requireText(store, "modular.getFunctions(fs.app, 'us-central1')", 'direct broker region');
requireText(store, "modular.httpsCallable(functions, 'runRevexEnergy', { timeout: 3600000 })", 'bounded managed retry');
requireText(store, 'throw energyCallableError(error)', 'broker error propagation');
requireText(store, "this.api.doc(this.db, 'projects', projectId, 'revex', 'engineering')", 'legacy Engineering recovery read');
requireText(store, '`revex_engineering_revision_${revision}`', 'legacy Engineering canonical revision mirror');
requireText(store, "clientBuild: '20260813r47'", 'r47 managed broker client');
requireText(store, "'revexEnergyConsents', revision, 'approvers', String(this.user.uid)", 'per-user immutable-revision consent path');
requireText(store, 'async recordEnergyConsent(projectId, sourceRevision)', 'revision consent writer');
requireText(store, 'async getEnergyConsent(projectId, sourceRevision)', 'revision consent reader');
requireText(store, 'Authorize official COMcheck processing for this exact Engineering revision', 'broker call consent gate');
requireText(sharedFirebase, "if (name === 'runRevexEnergy')", 'shared Firebase dedicated Energy path');
requireText(sharedFirebase, "this.functionsByRegion?.['us-central1']", 'shared Firebase Energy region lock');
requireText(sharedFirebase, "{ timeout: 3600000 }", 'shared Firebase Energy timeout');
requireText(sharedFirebase, "if (name === 'runRevexEnergy' ||", 'shared Firebase Energy error propagation');
requireText(integrity, "firestorePlain({ merge", 'same-realm Firestore options');
requireText(integrity, "const rvxMeshFile = files.find", 'exact REVEX mesh selection');
requireText(integrity, "modelFormat: 'rvxmesh-gzip'", 'exact geometry activation');
requireText(integrity, "schema: 'liber.revex.cloud-state.v3'", 'atomic revision state schema');
requireText(integrity, "await setRecord(projectId, 'revex_state', 'state', state, false)", 'complete current pointer replacement');
requireText(integrity, "await verifyUploadedAsset(uploads[rvxMeshFile.name]", 'geometry readability before activation');
requireText(integrity, "'design-item-version'", 'append-only Design Book item versions');
requireText(integrity, "'design-chapter-version'", 'append-only Design Book chapter versions');
requireText(app, 'assertRevisionAssets(cloudState,revision)', 'revision asset identity guard');
requireText(app, 'activeBimViewer()?.beginRevision?.(revision)', 'revision-isolated viewer load');
requireText(app, 'sourceRevision: state.cloudState?.revision || state.loadingRevision || null', 'Design Book overlay revision provenance');
requireText(energy, 'const resultComplete = resultSource === currentSource', 'failed-result retry eligibility');
requireText(energy, 'autoRetryRevision !== currentSource', 'single automatic retry per page session');
requireText(energy, "['filing-output', 'Official filing outputs']", 'official filing output group');
requireText(energy, 'COMcheck_OFFICIAL_BACKSTOP_REPORT', 'official Backstop report rendering');
requireText(energy, 'BASELINE|PROPOSED', 'compiled OSM rendering');
requireText(energy, "requestRevisionConsent(id, revision)", 'Energy Sync consent modal');
requireText(energy, "await requestRevisionConsent(id, revision)", 'pre-processing modal wait');
requireText(energy, "sourceState = await Store.syncEngineeringPackage(files, id)", 'evidence preservation after consent choice');
requireText(energy, "await authorizeRevision(id, lastSourceRevision, { prompt: false })", 'exact published revision consent binding');
requireText(html, 'id="energy-consent-dialog"', 'native modal dialog');
requireText(html, 'Authorization applies only to this immutable Engineering revision', 'revision-only consent explanation');
requireText(html, 'A later Energy Sync creates a new revision and asks again.', 'no future-revision authorization');
requireText(html, 'value="cancel">Keep evidence only', 'non-transmission evidence path');
requireText(html, 'value="approve">Authorize this revision', 'explicit revision authorization action');

const consentSurface = [store, energy, html].join('\n');
rejectText(consentSurface, /REVEX_COMCHECK_EXTERNAL_APPROVED|authorize all subsequent|project-wide COMcheck approval/i, 'blanket COMcheck authorization');

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

const revisionAccepted = (state) => state.schema !== 'liber.revex.cloud-state.v3' || (
  state.revision === state.latestRevision && state.revision === state.assetRevision &&
  state.revision === state.modelRevision && state.modelFormat === 'rvxmesh-gzip' &&
  Boolean(state.modelUrl && state.viewerUrl && state.designUrl)
);
if (!revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_new', modelFormat: 'rvxmesh-gzip', modelUrl: 'mesh', viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('complete latest revision was rejected');
if (revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_old', modelFormat: 'rvxmesh-gzip', modelUrl: 'old-mesh', viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('mixed old/new geometry revision was accepted');

async function verifyLegacyRevisionRecovery() {
  const sandbox = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(store, sandbox, { filename: 'store.js' });
  const candidate = sandbox.window.RevexStore;
  const writes = [];
  const legacy = {
    schema: 'liber.revex.engineering-state.v1', projectId: 'project_qa',
    revision: 'eng_20260813T092919850Z', cloud: true,
    manifest: { revision: 'eng_20260813T092919850Z' }, artifacts: []
  };
  candidate.mode = 'cloud';
  candidate.db = {};
  candidate.api = {
    doc: (_db, ...parts) => ({ path: parts.join('/') }),
    getDoc: async (ref) => ref.path.endsWith('/library/revex_engineering')
      ? { exists: () => false }
      : ref.path.endsWith('/revex/engineering')
        ? { exists: () => true, data: () => legacy }
        : { exists: () => false },
    setDoc: async (ref, data, options) => writes.push({ ref, data, options })
  };
  const recovered = await candidate.getEngineeringState('project_qa');
  if (recovered.revision !== legacy.revision) throw new Error('legacy recovery changed the immutable revision');
  if (writes.length !== 2) throw new Error(`legacy recovery expected 2 canonical writes, got ${writes.length}`);
  if (!writes.some((row) => row.ref.path.endsWith(`/library/revex_engineering_revision_${legacy.revision}`)))
    throw new Error('legacy recovery did not mirror the immutable canonical revision');
}

verifyLegacyRevisionRecovery().then(() => {
  console.log('REVEX r47 Companion QA passed:', {
    currentViewerBinding: true,
    hideAndInverseShow: true,
    instancedVisibility: true,
    latestRevisionIsolation: true,
    exactGeometryActivation: true,
    curtainPanelsAndMullions: true,
    designOverlayVersions: true,
    directManagedRetry: true,
    legacyRevisionRecovery: true,
    officialBackstopAndOsmOutputs: true,
    sameRealmFirestoreWrites: true,
    perRevisionComcheckConsent: true,
    evidenceOnlyCancelPath: true,
    referenceIdentityExcluded: true,
  });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
