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
const energyReplay = read('energy-replay-r95.js');
const energyDiagnostics = read('energy-diagnostics-r68.js');
const sharedFirebase = fs.readFileSync(path.join(root, 'docs/liber-apps/js/firebase-service.js'), 'utf8');
const energyBroker = fs.readFileSync(path.join(root, 'server/firebase-functions/index.js'), 'utf8');
const nativeMesh = fs.readFileSync(path.join(root, 'src/Liber.Revex.Revit/Services/RevexMeshExportService.cs'), 'utf8');
const nativeBridge = fs.readFileSync(path.join(root, 'src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js'), 'utf8');

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}
function rejectText(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`${label}: forbidden ${pattern}`);
}

requireText(viewer, "const BUILD='20260813r49'", 'current viewer build pin');
requireText(integrity, "const BUILD = '20260813r49'", 'current publication-integrity build pin');
requireText(store, "clientBuild: '20260813r49'", 'current managed broker client pin');
for (const asset of ['viewer-r26.js']) {
  requireText(html, `${asset}?v=20260813r49`, `${asset} current hosted cache pin`);
}
for (const asset of ['store.js', 'integrity.js', 'app.js']) {
  requireText(html, `${asset}?v=20260820r147-release1`, `${asset} final release cache pin`);
}
rejectText(html, /(?:store|integrity|app|viewer-r26)\.js\?v=20260813r4[1-8]\b/, 'stale active core-runtime cache pin');

requireText(history, 'window.__revexViewerR26Instance', 'history current viewer binding');
requireText(history, "new CustomEvent('revex:bim-overlays-changed'", 'overlay state publication');
requireText(app, "event.currentTarget.textContent = state.showHiddenOnly ? 'Show all elements' : 'Show hidden only'", 'inverse visibility control');
requireText(app, 'const elements = state.showHiddenOnly ? allElements.filter', 'tree hidden-only filter');
requireText(app, 'row=>hiddenIds.has(String(row.uniqueId||\'\'))||hiddenIds.has(String(row.id))', 'tree hidden identity filter');
requireText(viewer, 'group.visible=!(overlay?.hidden||overlay?.deleted)', 'viewer reversible visibility rule');
requireText(viewer, 'revexOriginalParent', 'original geometry parent preservation');
requireText(viewer, 'clearEditGroups()', 'overlay group teardown on revision replacement');
requireText(viewer, 'const token=++this.loadToken', 'revision load token isolation');
requireText(viewer, 'if(token!==this.loadToken)', 'stale asynchronous geometry rejection');
requireText(viewer, 'revexFallbackOnly=true', 'bounded fallback tagging for unsupported physical rows');
requireText(nativeMesh, 'Curtain hosts are containers only; their real panels and mullions are exported', 'curtain host/container policy');
requireText(nativeMesh, 'host-container-excluded-panels-and-mullions-exact', 'exact curtain panel and mullion export policy');
requireText(store, "modular.getFunctions(fs.app, 'us-central1')", 'direct broker region');
requireText(store, "modular.httpsCallable(functions, 'runRevexEnergy', { timeout: 3600000 })", 'bounded managed retry');
requireText(store, 'throw energyCallableError(error)', 'broker error propagation');
requireText(store, '`revex_engineering_revision_${revision}`', 'immutable Engineering revision record');
requireText(store, '`revex_revision_${docId(sourceRevision)}`', 'exact immutable BIM source lookup');
requireText(store, 'assertEngineeringSourceAlignment({ id: sourceSnap.id, ...sourceSnap.data() }, manifest, projectId)', 'Engineering/source identity alignment gate');
requireText(store, 'Engineering artifact failed immutable byte/hash validation', 'Engineering artifact byte/hash gate');
requireText(store, 'Legacy r41-r48 records never establish project identity', 'legacy Engineering fail-closed policy');
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
requireText(integrity, "modelFormat: meshManifestFile ? 'rvxmesh-gzip-pages' : 'rvxmesh-gzip'", 'exact paged-or-legacy geometry activation');
requireText(integrity, "schema: 'liber.revex.cloud-state.v3'", 'atomic revision state schema');
requireText(integrity, "await setRecord(projectId, 'revex_state', 'state', state, false)", 'complete current pointer replacement');
requireText(integrity, "await verifyUploadedAsset(uploads[rvxMeshFile.name]", 'geometry readability before activation');
requireText(integrity, "'design-item-version'", 'append-only Design Book item versions');
requireText(integrity, "'design-chapter-version'", 'append-only Design Book chapter versions');
requireText(app, 'Revision data unavailable · previous revision retained', 'incomplete revision must retain prior complete screen state');
requireText(app, 'if(state.activationToken!==activationToken||state.projectId!==projectId||state.loadingProjectId!==projectId||state.loadingRevision!==revision)return', 'revision/project asynchronous identity guard');
requireText(app, "new CustomEvent('revex:source-revision-loaded', { detail: { revision, cloudState, localPackage, viewerData } })", 'complete revision activation event');
requireText(app, 'sourceRevision: state.cloudState?.revision || null', 'overlay revision provenance');
requireText(energy, 'const complete = clean(manifest.status).toUpperCase() === \'COMPLETE\'', 'Energy output COMPLETE gate');
requireText(energy, 'complete ? allRows.filter((row) => row?.userVisible !== false) : allRows', 'complete-output visibility and failed-evidence preservation');
requireText(energy, 'predates the verified active-Revit-document evidence contract and cannot run downstream Energy', 'stale Engineering revision execution block');
requireText(energyReplay, 'function exactResult(result,id,revision,expected=\'\')', 'exact project/source/result revision binding');
requireText(energyReplay, "if(status!=='COMPLETE')throw new Error", 'strict COMPLETE-only Energy success');
requireText(energyReplay, "if(auto&&!consent)return {ok:false,skipped:'no-consent'}", 'automatic Energy execution without revision consent');
requireText(energyReplay, 'return runHosted({auto:false,forcePrompt:true})', 'manual retry must reopen revision authorization');
requireText(energyDiagnostics, 'PREVIOUS ATTEMPT FAILURE', 'historical failure evidence labeling');
for (const required of ['BASELINE_UPDATED_GEOMETRY.osm', 'PROPOSED_UPDATED_GEOMETRY.osm', 'COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf']) {
  requireText(energyBroker, required, `strict Energy package output ${required}`);
}
requireText(energyBroker, "ok: pipelineStatus === 'COMPLETE'", 'broker strict COMPLETE-only result');
requireText(html, 'id="energy-consent-dialog"', 'native modal dialog');
requireText(html, 'Authorization applies only to this immutable Engineering revision', 'revision-only consent explanation');
requireText(html, 'A later Energy Sync creates a new revision and asks again.', 'no future-revision authorization');
requireText(html, 'value="cancel">Keep evidence only', 'non-transmission evidence path');
requireText(html, 'value="approve">Authorize this revision', 'explicit revision authorization action');

const consentSurface = [store, energy, energyReplay, nativeBridge, html].join('\n');
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
  state.revision === state.modelRevision && ['rvxmesh-gzip', 'rvxmesh-gzip-pages'].includes(state.modelFormat) &&
  Boolean(state.modelUrl && state.viewerUrl && state.designUrl) &&
  (state.modelFormat !== 'rvxmesh-gzip-pages' ||
    Boolean(state.modelPages?.length && state.modelPages.every((page) => page.url)))
);
if (!revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_new', modelFormat: 'rvxmesh-gzip', modelUrl: 'mesh', viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('complete latest revision was rejected');
if (!revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_new', modelFormat: 'rvxmesh-gzip-pages', modelUrl: 'manifest', modelPages: [{ url: 'page-1' }, { url: 'page-2' }], viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('complete paged geometry revision was rejected');
if (revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_new', modelFormat: 'rvxmesh-gzip-pages', modelUrl: 'manifest', modelPages: [], viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('paged geometry revision without page URLs was accepted');
if (revisionAccepted({ schema: 'liber.revex.cloud-state.v3', revision: 'rev_new', latestRevision: 'rev_new', assetRevision: 'rev_new', modelRevision: 'rev_old', modelFormat: 'rvxmesh-gzip', modelUrl: 'old-mesh', viewerUrl: 'viewer', designUrl: 'design' }))
  throw new Error('mixed old/new geometry revision was accepted');

async function verifyLegacyRevisionRejected() {
  const sandbox = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(store, sandbox, { filename: 'store.js' });
  const candidate = sandbox.window.RevexStore;
  const reads = [];
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
    getDoc: async (ref) => {
      reads.push(ref.path);
      return ref.path.endsWith('/library/revex_engineering')
        ? { exists: () => false }
        : ref.path.endsWith('/revex/engineering')
          ? { exists: () => true, data: () => legacy }
          : { exists: () => false };
    },
    setDoc: async (ref, data, options) => writes.push({ ref, data, options })
  };
  const recovered = await candidate.getEngineeringState('project_qa');
  if (recovered !== null) throw new Error('legacy Engineering state bypassed current immutable source-identity gates');
  if (reads.length !== 1 || reads[0] !== 'projects/project_qa/library/revex_engineering')
    throw new Error(`legacy Engineering path was consulted: ${JSON.stringify(reads)}`);
  if (writes.length !== 0) throw new Error(`legacy Engineering state was promoted through ${writes.length} canonical writes`);
}

verifyLegacyRevisionRejected().then(() => {
  console.log('REVEX r47 Companion QA passed:', {
    currentViewerBinding: true,
    hiddenOnlyTreeFilter: true,
    reversibleOverlayVisibility: true,
    editableNodeLifecycle: true,
    latestRevisionIsolation: true,
    exactGeometryActivation: true,
    curtainPanelsAndMullions: true,
    designOverlayVersions: true,
    directManagedRetry: true,
    legacyRevisionRejected: true,
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
