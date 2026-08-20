'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const appRoot = path.join(root, 'docs/liber-apps/apps/revex');

const parentRealm = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(`
  globalThis.parentWrites = [];
  globalThis.firebase = {
    collection() {},
    firestore() { return globalThis.firebaseService.db; },
    doc(_db, ...segments) { return { path: segments.join('/') }; },
    async setDoc(ref) { parentWrites.push(ref.path); throw new Error('Parent SDK must not receive REVEX writes'); }
  };
  globalThis.firebaseService = {
    isInitialized: true, firebase, app: {}, db: {}, storage: {},
    auth: { currentUser: { uid: 'parent_user' } }
  };
`, parentRealm);

const memory = new Map();
const childRealm = vm.createContext({
  console, setTimeout, clearTimeout,
  crypto: webcrypto, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  parent: parentRealm, top: parentRealm,
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); }
  },
  URL: { createObjectURL(file) { return `blob:${file.name}`; } }
});
childRealm.window = childRealm;

vm.runInContext(`
  globalThis.JSON = JSON;
  globalThis.writes = [];
  globalThis.uploads = [];
  const requireOwnPlain = (value, label) => {
    if (value == null) return;
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error(label + ' was not created in the REVEX SDK realm');
  };
  globalThis.firebase = {
    collection() {},
    firestore() { return globalThis.firebaseService.db; },
    doc(_db, ...segments) { return { path: segments.join('/') }; },
    ref(_storage, fullPath) { return { fullPath }; },
    async uploadBytes(ref, file, metadata) {
      requireOwnPlain(metadata, 'Storage metadata');
      uploads.push({ path: ref.fullPath, name: file.name });
      return { ref };
    },
    async getDownloadURL(ref) { return 'https://storage.invalid/' + ref.fullPath; },
    async setDoc(ref, data, options) {
      requireOwnPlain(data, 'Firestore payload');
      requireOwnPlain(options, 'Firestore options');
      writes.push({ path: ref.path, data, options });
    }
  };
  globalThis.firebaseService = { isInitialized: false, firebase: null, app: null, db: null };
  setTimeout(() => Object.assign(globalThis.firebaseService, {
    isInitialized: true, firebase, app: {}, db: {}, storage: {},
    auth: { currentUser: { uid: 'project_member_r43' } },
    async callFunction() { return { ok: true }; }
  }), 30);
`, childRealm);

function load(name) {
  const source = fs.readFileSync(path.join(appRoot, name), 'utf8');
  vm.runInContext(source, childRealm, { filename: name });
}

(async () => {
  load('store.js');
  await childRealm.RevexStore.init();
  assert.equal(childRealm.RevexStore.fs, childRealm.firebaseService);
  assert.equal(childRealm.RevexStore.api, childRealm.firebase);
  assert.equal(childRealm.RevexStore.user.uid, 'project_member_r43');

  const gbxml = '<gbXML />';
  const weather = '';
  const gbxmlHash = createHash('sha256').update(gbxml).digest('hex');
  const weatherHash = createHash('sha256').update(weather).digest('hex');
  const files = vm.runInContext(`[
    {
      name: 'engineering-sync.json', type: 'application/json',
      async text() { return JSON.stringify({
        schema: 'liber.revex.engineering-sync.v1',
        architecture: 'REVIT_EVIDENCE_GRAPH_V1',
        projectId: 'project_r43', revision: 'eng_preserved_r43', gbxmlStatus: 'EXPORTED',
        projectBinding: {
          version: 'active-revit-evidence-v1',
          identityEvidenceDigest: '${'a'.repeat(64)}',
          documentUniqueId: 'revit-document-r43'
        },
        publicationIntegrity: {
          threshold: 0.80, qualityTarget: 0.95,
          ratios: { physical: 0.91, analytical: 1, spatial: 1, openings: 0.97 }
        },
        artifacts: [
          { name: 'model.xml', bytes: ${Buffer.byteLength(gbxml)}, sha256: '${gbxmlHash}' },
          { name: 'weather.epw', bytes: ${Buffer.byteLength(weather)}, sha256: '${weatherHash}' }
        ],
        writeBackToRevitAfterExport: false, pdfInsertion: false
      }); },
      async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; },
      get size() { return new TextEncoder().encode(JSON.stringify({})).byteLength; }
    },
    { name: 'model.xml', size: ${Buffer.byteLength(gbxml)}, type: 'application/xml', async text() { return ${JSON.stringify(gbxml)}; }, async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; } },
    { name: 'weather.epw', size: ${Buffer.byteLength(weather)}, type: 'application/octet-stream', async text() { return ${JSON.stringify(weather)}; }, async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; } }
  ]`, childRealm);

  const engineering = await childRealm.RevexStore.syncEngineeringPackage(files, 'project_r43');
  assert.equal(engineering.cloud, true);
  assert.deepEqual(Array.from(childRealm.writes, (row) => row.path), [
    'projects/project_r43/library/revex_engineering_revision_eng_preserved_r43',
    'projects/project_r43/library/revex_engineering'
  ]);

  load('integrity.js');
  await childRealm.RevexStore.saveChapterEdit('project_r43', 'facade', { decision: 'Brick' });
  assert.equal(childRealm.writes.at(-1).path, 'projects/project_r43/library/revex_chapter_facade');
  assert.equal(parentRealm.parentWrites.length, 0);

  console.log('REVEX r43 Firestore realm QA passed:', {
    ownSdkRealm: true,
    parentWrites: parentRealm.parentWrites.length,
    preservedEngineeringRevision: true,
    projectMemberWrites: childRealm.writes.length
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
