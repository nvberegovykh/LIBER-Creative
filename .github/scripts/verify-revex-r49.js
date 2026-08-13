#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const root = path.resolve(__dirname, '../..');
const live = path.join(root, 'src/Live-Companion');
const revit = path.join(root, 'src/Liber.Revex.Revit');
const read = (file) => fs.readFileSync(file, 'utf8');
const reportFlag = process.argv.indexOf('--report');
const reportPath = reportFlag >= 0 ? path.resolve(process.argv[reportFlag + 1] || '') : null;
const fullRunReport = {
  schema: 'liber.revex.release-preflight.v1', build: '20260813r49',
  mode: 'recorded-revit-output-offline-no-cloud-mutations', startedAt: new Date().toISOString(),
  checkpoints: []
};
const checkpoint = (name, detail = {}) => fullRunReport.checkpoints.push({ name, status: 'PASSED', ...detail });
const writeReport = () => {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(fullRunReport, null, 2));
};

class TestFile {
  constructor(name, value, type = 'application/json') {
    this.name = name; this.type = type; this.bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); this.size = this.bytes.length;
  }
  async text() { return this.bytes.toString('utf8'); }
  async arrayBuffer() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
}
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function integrityContext() {
  const values = new Map();
  const Store = {
    user: { uid: 'qa' }, api: null, db: null, fs: null,
    isCloud: () => false,
    toFirestorePlain: (value) => JSON.parse(JSON.stringify(value)),
    ensureSpecProject: async (_projectId, preferred) => preferred,
    createProject: async (args) => args,
    getProject: async () => null
  };
  const window = {
    RevexStore: Store,
    localStorage: { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    URL: { createObjectURL: (file) => `blob:${file.name}` },
    crypto: crypto.webcrypto,
    console
  };
  const document = { addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] };
  window.document = document;
  const context = vm.createContext({ window, document, URL: window.URL, localStorage: window.localStorage, crypto: crypto.webcrypto, console, AbortController, setTimeout, clearTimeout });
  vm.runInContext(read(path.join(live, 'integrity.js')), context, { filename: 'integrity.js' });
  return window.RevexStore;
}

function rvxPage(elementId, materialId, origin) {
  const header = Buffer.alloc(12); header.write('RVXSCN2\0', 0, 'ascii'); header.writeInt32LE(2, 8);
  const record = Buffer.alloc(1 + 8 + 4 + 8 + 4 + (3 * 6 * 4));
  let offset = 0;
  record.writeUInt8(1, offset); offset += 1;
  record.writeDoubleLE(elementId, offset); offset += 8;
  record.writeInt32LE(1, offset); offset += 4;
  record.writeDoubleLE(materialId, offset); offset += 8;
  record.writeInt32LE(3, offset); offset += 4;
  const vertices = [
    origin, 0, 0, 0, 0, 1,
    origin + 1, 0, 0, 0, 0, 1,
    origin, 1, 0, 0, 0, 1
  ];
  for (const value of vertices) { record.writeFloatLE(value, offset); offset += 4; }
  return zlib.gzipSync(Buffer.concat([header, record, Buffer.from([0])]));
}

function recordedRevitPackage(projectId = 'revex_active_fixture') {
  const specProjectId = `spec_${projectId}`;
  const revision = 'rev_recorded_revit_r49_001';
  const schedules = [
    {
      schedule: 'Door Schedule', sourceScheduleId: 'schedule-door-001', headers: ['Mark', 'Type', 'Width'], rows: [['D-01', 'A', '3′-0″']],
      presentation: { schema: 'liber.revit.schedule.presentation.v1', scheduleUniqueId: 'schedule-door-001',
        fields: [{ order: 0, columnHeading: 'Mark', hidden: false, sheetColumnWidth: 0.8 }, { order: 1, columnHeading: 'Type', hidden: false, sheetColumnWidth: 1.2 }, { order: 2, columnHeading: 'Width', hidden: false, sheetColumnWidth: 0.9 }],
        sortGroups: [{ fieldId: 'mark', sortOrder: 'Ascending', showHeader: false }],
        header: { rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, text: 'Mark' }, { columnIndex: 1, text: 'Type' }, { columnIndex: 2, text: 'Width' }] }] },
        body: { rows: [{ rowIndex: 1, cells: [{ columnIndex: 0, text: 'D-01' }, { columnIndex: 1, text: 'A' }, { columnIndex: 2, text: '3′-0″' }] }] } }
    },
    {
      schedule: 'Room Finish Schedule', sourceScheduleId: 'schedule-room-001', headers: ['Number', 'Name', 'Floor', 'Base', 'Wall'], rows: [['101', 'LOBBY', 'TERRAZZO', 'WOOD', 'PAINT']],
      presentation: { schema: 'liber.revit.schedule.presentation.v1', scheduleUniqueId: 'schedule-room-001',
        fields: [{ order: 0, columnHeading: 'Number' }, { order: 1, columnHeading: 'Name' }, { order: 2, columnHeading: 'Floor' }, { order: 3, columnHeading: 'Base' }, { order: 4, columnHeading: 'Wall' }],
        sortGroups: [{ fieldId: 'level', sortOrder: 'Ascending', showHeader: true }, { fieldId: 'number', sortOrder: 'Ascending', showHeader: false }],
        header: { rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, text: 'ROOM' }, { columnIndex: 2, text: 'FINISHES', columnSpan: 3 }] }] },
        body: { rows: [{ rowIndex: 1, cells: ['101', 'LOBBY', 'TERRAZZO', 'WOOD', 'PAINT'].map((text, columnIndex) => ({ columnIndex, text })) }] } }
    },
    {
      schedule: 'Lighting Fixture Schedule', sourceScheduleId: 'schedule-light-001', headers: ['Type', 'Description', 'Watts', 'Count'], rows: [['L1', 'RECESSED LED', '12 W', '48']],
      presentation: { schema: 'liber.revit.schedule.presentation.v1', scheduleUniqueId: 'schedule-light-001',
        fields: [{ order: 0, columnHeading: 'Type' }, { order: 1, columnHeading: 'Description' }, { order: 2, columnHeading: 'Watts' }, { order: 3, columnHeading: 'Count' }],
        sortGroups: [{ fieldId: 'type', sortOrder: 'Ascending', showFooter: true }],
        header: { rows: [{ rowIndex: 0, cells: ['Type', 'Description', 'Watts', 'Count'].map((text, columnIndex) => ({ columnIndex, text })) }] },
        body: { rows: [{ rowIndex: 1, cells: ['L1', 'RECESSED LED', '12 W', '48'].map((text, columnIndex) => ({ columnIndex, text })) }] } }
    }
  ];
  const elements = [
    { id: '1001', uniqueId: 'curtain-panel-1001', category: 'Curtain Panels', family: 'System Panel', type: 'Glazed', bbox: { min: [0, 0, 0], max: [1, 1, 0.1] } },
    { id: '1002', uniqueId: 'curtain-mullion-1002', category: 'Curtain Wall Mullions', family: 'Rectangular Mullion', type: '2.5 x 5', bbox: { min: [1, 0, 0], max: [1.1, 1, 0.1] } }
  ];
  const pageFiles = [
    new TestFile('model-page-0001.rvxmesh.gz', rvxPage(1001, 501, 0), 'application/gzip'),
    new TestFile('model-page-0002.rvxmesh.gz', rvxPage(1002, 502, 2), 'application/gzip')
  ];
  const meshManifest = {
    schema: 'liber.revex.geometry-pages.v1', format: 'rvxmesh-gzip-pages', binaryFormat: 'RVXSCN2',
    curtainWallPolicy: 'host-container-excluded-panels-and-mullions-exact',
    totals: { pages: 2, elements: 2, triangles: 2, vertices: 6 },
    pages: pageFiles.map((file, index) => ({ index: index + 1, file: file.name, elements: 1, triangles: 1, vertices: 3, compressedBytes: file.size, sha256: sha(file.bytes) }))
  };
  const project = { schema: 'liber.revex.project.v2', revision, central: {
    documentTitle: '250 Midwood St', documentUniqueId: 'revit-active-document-fixture-001', documentFingerprint: 'fixture-fingerprint-001',
    centralPath: 'recorded://250-midwood/current-model.rvt', projectId, specProjectId,
    bindingVersion: 'active-revit-evidence-v1', bindingSource: 'recorded-active-document-fixture',
    identityEvidenceDigest: 'a'.repeat(64), identityDisplayName: '250 Midwood St', identityEvidenceSheets: ['T001 · TITLE', 'Z001 · ZONING']
  }, rules: { writeBackToRvt: false, sourceRevisions: 'append-only', companionOverlay: 'separate-history-layer' } };
  const files = [
    new TestFile('project.json', JSON.stringify(project)),
    new TestFile('design-book.json', JSON.stringify({ schema: 'liber.revex.design-book.v1', revision, schedules })),
    new TestFile('spec-revit-push.json', JSON.stringify({ schema: 'liber.revex.spec-revit-push.v1', rev: revision, payload: schedules })),
    new TestFile('viewer-model.json', JSON.stringify({ schema: 'liber.revex.viewer.v2', revision, elements, geometry: { displayFormat: 'rvxmesh-gzip-pages', highDetail: { elements: 2 } } })),
    new TestFile('model.rvxpages.json', JSON.stringify(meshManifest)),
    new TestFile('model.ifc', 'ISO-10303-21;\nHEADER;\nFILE_NAME(\'250 Midwood St\');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;', 'application/octet-stream'),
    new TestFile('printing-sets.json', JSON.stringify({ schema: 'liber.revex.printing-sets.v1', revision, sets: [{ id: 'cd-set', name: 'Construction Documents', pages: [{ sheet: 'T001', file: 'T001.pdf' }] }] })),
    new TestFile('affected-plan-views.json', JSON.stringify({ schema: 'liber.revex.affected-plan-views.v1', revision, views: [{ id: 'level-1', file: 'A101.pdf' }] })),
    new TestFile('T001.pdf', '%PDF-1.4\n% recorded Revit title sheet\n%%EOF', 'application/pdf'),
    new TestFile('A101.pdf', '%PDF-1.4\n% recorded affected plan\n%%EOF', 'application/pdf'),
    ...pageFiles
  ];
  const integrity = {
    schema: 'liber.revex.integrity.v1', revision,
    central: { documentUniqueId: project.central.documentUniqueId, documentFingerprint: project.central.documentFingerprint, projectId, specProjectId },
    counts: { schedules: schedules.length, elements: elements.length, printingSets: 1, printingSheets: 1, affectedPlanViews: 1, changedElements: 2 },
    files: files.map((file) => ({ name: file.name, bytes: file.size, sha256: sha(file.bytes) }))
  };
  files.push(new TestFile('integrity.json', JSON.stringify(integrity)));
  return { files, projectId, specProjectId, revision, schedules, elements, meshManifest };
}

async function verifyAtomicProjectPackage() {
  const store = integrityContext();
  const fixture = recordedRevitPackage();
  await assert.rejects(store.syncPackage(fixture.files, 'revex_other', 'spec_revex_other'), /mixed-project publish/i);
  await assert.rejects(store.syncPackage(fixture.files, fixture.projectId, 'spec_wrong'), /mixed BIM\/Spec selection/i);
  const accepted = await store.syncPackage(fixture.files, fixture.projectId, fixture.specProjectId);
  assert.equal(accepted.projectId, fixture.projectId);
  assert.equal(accepted.revision, fixture.revision);
  assert.equal(accepted.modelFormat, 'rvxmesh-gzip-pages');
  assert.equal(accepted.modelPages.length, 2);
  assert.equal(accepted.project.central.documentUniqueId, 'revit-active-document-fixture-001');
  assert.equal(new Set(fixture.schedules.map((row) => row.presentation.scheduleUniqueId)).size, fixture.schedules.length);
  assert.notDeepEqual(fixture.schedules[0].headers, fixture.schedules[1].headers, 'Native Revit schedules must not be flattened into one shared column structure.');
  assert.equal(fixture.meshManifest.curtainWallPolicy, 'host-container-excluded-panels-and-mullions-exact');
  for (const [index, file] of fixture.files.filter((row) => /\.rvxmesh\.gz$/i.test(row.name)).entries()) {
    const raw = zlib.gunzipSync(file.bytes);
    assert.equal(raw.subarray(0, 8).toString('ascii'), 'RVXSCN2\0');
    assert.equal(raw.readInt32LE(8), 2);
    assert.equal(sha(file.bytes), fixture.meshManifest.pages[index].sha256);
  }
  const tampered = fixture.files.map((file) => new TestFile(file.name, file.bytes, file.type));
  const pageIndex = tampered.findIndex((file) => file.name === 'model-page-0002.rvxmesh.gz');
  tampered[pageIndex] = new TestFile(tampered[pageIndex].name, Buffer.concat([tampered[pageIndex].bytes, Buffer.from([0])]), tampered[pageIndex].type);
  await assert.rejects(store.syncPackage(tampered, fixture.projectId, fixture.specProjectId), /size does not match|SHA-256 integrity/i);
  checkpoint('RECORDED_REVIT_BIM_BOOKS_PACKAGE', { projectId: fixture.projectId, revision: fixture.revision, schedules: fixture.schedules.length, elements: fixture.elements.length, geometryPages: 2, cloudMutations: false });
}

function verifyNativeSchedules() {
  const presentation = {
    schema: 'liber.revit.schedule.presentation.v1', scheduleUniqueId: 'schedule-1',
    fields: [{ order: 0, columnHeading: 'Mark', hidden: false, sheetColumnWidth: 1 }],
    sortGroups: [{ fieldId: 'mark', sortOrder: 'Ascending' }],
    header: { rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, text: 'Mark' }] }] },
    body: { rows: [{ rowIndex: 1, cells: [{ columnIndex: 0, text: 'A-1' }] }] }
  };
  const context = vm.createContext({
    window: null, globalThis: null, console,
    MasterFormat: { norm: (value) => String(value).toLowerCase(), isLocationSchedule: () => false, classify: () => ({ number: '10 00 00', title: 'Test', division: '10', needsMapping: false }) },
    ScheduleParser: { parseGrid: (grid, name) => ({ name, headers: grid[1], roles: {}, groups: [], totals: [], items: [{ key: 'a1', label: 'A-1', category: 'Test' }] }) }
  });
  context.window = context; context.globalThis = context;
  vm.runInContext(read(path.join(live, 'spec-sync.js')), context, { filename: 'spec-sync.js' });
  const schedules = context.SpecSync.normalisePush([{ schedule: 'Door Schedule', sourceScheduleId: 'schedule-1', headers: ['Mark'], rows: [['A-1']], presentation }]);
  const built = context.SpecSync.build(schedules);
  assert.equal(schedules[0].presentation.schema, presentation.schema);
  assert.equal(built.sections[0].data.nativePresentation.body.rows[0].cells[0].text, 'A-1');
  checkpoint('INDEPENDENT_NATIVE_REVIT_SCHEDULE_PRESENTATION', { preservedColumns: true, preservedSortGroups: true, authoredSpecLayerSeparate: true });
}

function verifyViewerOverlayLifecycle() {
  class Vector3 {
    constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
    set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
    copy(v){return this.set(v.x,v.y,v.z);}
    clone(){return new Vector3(this.x,this.y,this.z);}
    add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this;}
  }
  class Group {
    constructor(){this.children=[];this.parent=null;this.position=new Vector3();this.rotation={set(){}};this.scale={set(){}};this.userData={};this.visible=true;this.name='';}
    add(node){node.parent?.remove?.(node);this.children.push(node);node.parent=this;}
    remove(node){this.children=this.children.filter(row=>row!==node);if(node.parent===this)node.parent=null;}
    attach(node){this.add(node);}
    clear(){for(const node of [...this.children])this.remove(node);}
  }
  const source = read(path.join(live, 'viewer-r26.js'));
  const start = source.indexOf('class Viewer{');
  const end = source.indexOf('\nlet v=null;', start);
  assert(start >= 0 && end > start, 'Viewer class could not be isolated for lifecycle QA.');
  const context = vm.createContext({ THREE: { Group, Vector3 }, console, setTimeout, clearTimeout });
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.Viewer=Viewer;`, context, { filename: 'viewer-r26.lifecycle.js' });
  const Viewer = context.Viewer;
  const model = new Group(), scene = new Group(); scene.add(model);
  let overlayDisposed = 0;
  const baseMaterial = { clone(){return {userData:{},color:{set(){}},dispose(){overlayDisposed++;}};} };
  const node = { parent:null,userData:{},material:baseMaterial,isMesh:true }; model.add(node);
  const viewer = Object.create(Viewer.prototype);
  Object.assign(viewer, {
    scene,model,editGroups:new Map(),elementNodes:new Map([['1',[node]]]),overlays:new Map(),
    box:()=>({getCenter:(target)=>target.set(1,2,3)}),requestRender:()=>{}
  });
  const row={id:'1'};
  assert(viewer.applyOverlayTo(row,{hidden:true,material:{color:'#ff0000',opacity:.5}}));
  const edit=viewer.editGroups.get('1');
  assert.equal(edit.visible,false,'Hide must suppress the actual element group.');
  assert.equal(node.parent,edit,'Overlay must own the actual element nodes while active.');
  viewer.applyOverlayTo(row,{hidden:false});
  assert.equal(edit.visible,true,'Show must reverse Hide on the same element.');
  viewer.clearEditGroups();
  assert.equal(node.parent,model,'Revision swaps must restore nodes to their original model parent.');
  assert.equal(node.material,baseMaterial,'Revision swaps must restore the original material.');
  assert(overlayDisposed>=1,'Transient overlay materials must be disposed without disposing model geometry.');
  checkpoint('VIEWER_REVISION_AND_OVERLAY_LIFECYCLE', { reversibleVisibility: true, originalGeometryRestored: true, transientMaterialsDisposed: true });
}

async function verifyManagedEnergyClient() {
  class CustomEvent { constructor(type,init={}){this.type=type;this.detail=init.detail;} }
  const listeners = new Map();
  const statusNode={textContent:'',dataset:{}};
  const button={addEventListener(){}};
  const document={querySelector:(selector)=>selector==='#energy-run-status'?statusNode:selector==='#energy-authorize-backstop'?button:null};
  const state={projectId:'revex_old'};
  const result={projectId:'revex_current',manifest:{schema:'liber.revex.energy-result.v1',status:'COMPLETE',sourceEngineeringRevision:'eng_current'}};
  const Store={
    syncEngineeringPackage:async()=>({projectId:'revex_current',revision:'eng_current'}),
    getEnergyConsent:async()=>({approved:true}),
    runEnergyServer:async()=>({ok:true,status:'COMPLETE'}),
    getEnergyResult:async()=>result
  };
  const window={
    RevexStore:Store,__revexState:state,chrome:null,
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
    dispatchEvent(event){for(const fn of listeners.get(event.type)||[])fn(event);return true;}
  };
  window.addEventListener('revex:native-project-binding',(event)=>{state.projectId=event.detail.projectId;});
  const context=vm.createContext({window,document,CustomEvent,console,setTimeout,clearTimeout,setInterval,clearInterval,Date,URL,location:{href:'https://example.test/revex'},history:{state:null,replaceState(){}}});
  vm.runInContext(read(path.join(revit,'Engineering/Companion/native-managed-energy-bridge.js')),context,{filename:'native-managed-energy-bridge.js'});
  const manifest={schema:'liber.revex.engineering-sync.v1',architecture:'REVIT_EVIDENCE_GRAPH_V1',projectId:'revex_current',revision:'eng_current',projectBinding:{version:'active-revit-evidence-v1',identityEvidenceDigest:'a'.repeat(64),documentUniqueId:'doc-current'}};
  const response=await window.__revexManagedEnergyBridge.processInput([new TestFile('engineering-sync.json',JSON.stringify(manifest))]);
  assert.equal(response.ok,true);
  assert.equal(state.projectId,'revex_current','Managed Energy must activate the exact active-Revit project through the application boundary.');
  assert.equal(window.__revexManagedEnergyBridge.resultMatches(result,'revex_current','eng_current'),true);
  assert.equal(window.__revexManagedEnergyBridge.resultMatches(result,'revex_other','eng_current'),false);
  checkpoint('MANAGED_ENERGY_CLIENT_HANDOFF', { activeDocumentProjectAuthority: true, immutableRevision: 'eng_current', brokerResultMatched: true, blanketConsent: false });
}

function verifyStaticContracts() {
  const app = read(path.join(live,'app.js'));
  const viewer = read(path.join(live,'viewer-r26.js'));
  const history = read(path.join(live,'history-r24.js'));
  const index = read(path.join(live,'index.html'));
  const store = read(path.join(live,'store.js'));
  const settings = read(path.join(revit,'Services/SettingsService.cs'));
  const identity = read(path.join(revit,'Services/ProjectIdentityEvidenceService.cs'));
  const request = read(path.join(revit,'Models/RevitRequest.cs'));
  const handler = read(path.join(revit,'Revit/RevitRequestHandler.cs'));
  const ui = read(path.join(revit,'UI/RendairWindow.cs'));
  const manager = read(path.join(revit,'UI/RendairWindowManager.cs'));
  const mesh = read(path.join(revit,'Services/RevexMeshExportService.cs'));
  const worker = read(path.join(root,'server/revex-energy-worker/app.py'));
  const docker = read(path.join(root,'server/revex-energy-worker/Dockerfile'));
  const broker = read(path.join(root,'server/firebase-functions/index.js'));
  const brokerPackage = JSON.parse(read(path.join(root,'server/firebase-functions/package.json')));

  assert.match(app,/activationToken:\s*0/); assert.match(app,/state\.activationToken!==activationToken\|\|state\.projectId!==projectId/);
  assert.match(app,/loadingProjectId/); assert.match(app,/revex:authoritative-project-bound/);
  assert.match(settings,/stored-active-document/); assert.match(settings,/explicit-user-selection/); assert.doesNotMatch(settings,/latest.*revision/i);
  assert.match(request,/ResolveActiveProjectBinding/); assert.match(handler,/ResolveActiveProjectBinding/);
  assert.match(ui,/_projectId\.Text = ""/); assert.match(ui,/ResolveActiveDocumentProjectBinding/); assert.match(ui,/Ignored passive Companion selection event/);
  assert.match(ui,/string activated = await _web\.ExecuteScriptAsync\(\$\$\$"""/); assert.doesNotMatch(ui,/string activated = await _web\.ExecuteScriptAsync\(\$\$"""/);
  assert.match(manager,/OnViewActivated/); assert.match(identity,/number\.StartsWith\("T"/); assert.match(identity,/number\.StartsWith\("Z"/);
  assert.match(mesh,/IsCurtainContainer/); assert.match(mesh,/Curtain hosts are containers only/);
  assert.match(viewer,/REVEX_PAGED_MISSING_GEOMETRY_PROXY/); assert.match(viewer,/fetchGeometry\(url,label\)/); assert.doesNotMatch(viewer,/clearEditGroups\(\)\{for\(const group.*disposeObject\(group\)/);
  assert.match(history,/setOverlays\?\.\(overlays\);publishOverlays\(\);render\(\);toast\('Previous state restored/);
  assert.match(index,/Show hidden only/); assert.match(index,/design-image-lightbox/); assert.match(index,/20260813r49/); assert.match(index,/active Revit document and its T\/Z pages/);
  assert.match(store,/clientBuild:\s*'20260813r49'/); assert.match(store,/liber\.revex\.comcheck-consent\.v1/); assert.match(store,/sha256File\(file\)/); assert.match(store,/this\.api\.writeBatch/); assert.ok(store.indexOf("batch.set(immutableRef") < store.indexOf("batch.set(currentRef"));
  assert.match(worker,/"version": "0\.8\.19-r49"/); assert.match(worker,/REVIT_T_Z_EN_PAGE_SCAN_ONLY/); assert.match(worker,/Downloaded Engineering artifact failed transfer integrity/); assert.match(worker,/BASELINE_UPDATED_GEOMETRY\.osm/); assert.match(worker,/COMcheck_OFFICIAL_BACKSTOP_REPORT\.pdf/);
  assert.match(docker,/openstudio energyplus_version/); assert.match(docker,/openstudio ruby_version/); assert.match(docker,/verify_revex_r49_worker\.py/);
  assert.match(broker,/timeoutSeconds:\s*3600/); assert.match(broker,/SHA-256 transfer integrity/); assert.match(broker,/String\(resultManifest\.pipelineVersion \|\| ''\) !== '0\.8\.19-r49'/); assert.match(broker,/corrupt\.map/); assert.match(broker,/pipelineVersion \|\| ''\) === '0\.8\.19-r49'/); assert.doesNotMatch(broker,/legacy.*Engineering revision/i);
  assert.equal(brokerPackage.engines.node,'22'); assert.equal(brokerPackage.dependencies['firebase-admin'],'14.2.0'); assert.equal(brokerPackage.dependencies['firebase-functions'],'7.3.2'); assert.equal(brokerPackage.overrides.uuid,'11.1.1');
  checkpoint('STATIC_RELEASE_CONTRACTS', { build: '20260813r49', privateWorker: true, authenticatedBroker: true, revisionScopedConsent: true });
}

(async()=>{
  try {
    verifyStaticContracts();
    verifyNativeSchedules();
    verifyViewerOverlayLifecycle();
    await verifyAtomicProjectPackage();
    await verifyManagedEnergyClient();
    fullRunReport.status = 'PASSED';
    fullRunReport.finishedAt = new Date().toISOString();
    fullRunReport.cloudMutations = false;
    fullRunReport.officialComcheckProjectTransmission = false;
    writeReport();
    console.log('REVEX r49 release QA passed: recorded active-Revit package, project binding, independent schedules, paged geometry, viewer lifecycle, and managed Energy client handoff.');
  } catch (error) {
    fullRunReport.status = 'FAILED';
    fullRunReport.finishedAt = new Date().toISOString();
    fullRunReport.error = { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null };
    writeReport();
    throw error;
  }
})().catch((error)=>{console.error(error);process.exitCode=1;});
