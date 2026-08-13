'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const appRoot = path.join(root, 'docs/liber-apps/apps/revex');
const sdkRealm = vm.createContext({ console, setTimeout, clearTimeout });

vm.runInContext(`
  globalThis.JSON = JSON;
  globalThis.writes = [];
  globalThis.uploads = [];
  const requirePlain = (value, label) => {
    if (value == null) return;
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(label + ' was not created in the Firebase SDK realm');
    }
  };
  const api = {
    collection() {},
    firestore() { return globalThis.firebaseService.db; },
    doc(_db, ...segments) { return { path: segments.join('/') }; },
    ref(_storage, fullPath) { return { fullPath }; },
    async uploadBytes(ref, file, metadata) {
      requirePlain(metadata, 'Storage metadata');
      uploads.push({ path: ref.fullPath, name: file.name });
      return { ref };
    },
    async getDownloadURL(ref) { return 'https://storage.invalid/' + ref.fullPath; },
    async setDoc(ref, data, options) {
      requirePlain(data, 'Firestore payload');
      requirePlain(options, 'Firestore options');
      writes.push({ path: ref.path, data, options });
    }
  };
  globalThis.firebaseService = {
    isInitialized: true,
    firebase: api,
    app: {},
    db: {},
    storage: {},
    auth: { currentUser: { uid: 'user_r42' } },
    async callFunction() { return { ok: true }; }
  };
`, sdkRealm);

const memory = new Map();
const browserRealm = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  performance: { now: () => Date.now() },
  parent: sdkRealm,
  top: sdkRealm,
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: {
    getItem(key) { return memory.has(key) ? memory.get(key) : null; },
    setItem(key, value) { memory.set(key, String(value)); }
  },
  URL: { createObjectURL(file) { return `blob:${file.name}`; } }
});
browserRealm.window = browserRealm;

function load(name) {
  const source = fs.readFileSync(path.join(appRoot, name), 'utf8');
  vm.runInContext(source, browserRealm, { filename: name });
}

(async () => {
  load('store.js');
  await browserRealm.RevexStore.init();

  const files = vm.runInContext(`[
    {
      name: 'engineering-sync.json', size: 512, type: 'application/json',
      async text() { return JSON.stringify({
        schema: 'liber.revex.engineering-sync.v1',
        architecture: 'REVIT_EVIDENCE_GRAPH_V1',
        projectId: 'project_r42',
        revision: 'eng_r42',
        gbxmlStatus: 'EXPORTED',
        publicationIntegrity: {
          threshold: 0.80,
          qualityTarget: 0.95,
          ratios: { physical: 0.91, analytical: 1, spatial: 1, openings: 0.97 }
        },
        writeBackToRevitAfterExport: false,
        pdfInsertion: false
      }); }
    },
    { name: 'model.xml', size: 1024, type: 'application/xml', async text() { return '<gbXML />'; } },
    { name: 'weather.epw', size: 2048, type: 'application/octet-stream', async text() { return ''; } }
  ]`, browserRealm);

  const engineering = await browserRealm.RevexStore.syncEngineeringPackage(files, 'project_r42');
  assert.equal(engineering.cloud, true);

  const firstPaths = Array.from(sdkRealm.writes, (row) => row.path);
  assert.deepEqual(firstPaths, [
    'projects/project_r42/library/revex_engineering',
    'projects/project_r42/library/revex_engineering_revision_eng_r42'
  ]);
  assert.equal(firstPaths.some((value) => /revexEngineeringRevisions|\/revex\/engineering$/.test(value)), false);

  load('integrity.js');
  await browserRealm.RevexStore.saveChapterEdit('project_r42', 'facade', { decision: 'Brick' });
  assert.equal(sdkRealm.writes.at(-1).path, 'projects/project_r42/library/revex_chapter_facade');

  load('firestore-compat.js');
  const localPayload = vm.runInContext('({ value: 42 })', browserRealm);
  const localOptions = vm.runInContext('({ merge: true })', browserRealm);
  const ref = browserRealm.RevexStore.api.doc(browserRealm.RevexStore.db, 'projects', 'project_r42', 'library', 'revex_probe');
  await browserRealm.RevexStore.api.setDoc(ref, localPayload, localOptions);
  assert.equal(sdkRealm.writes.at(-1).path, 'projects/project_r42/library/revex_probe');

  console.log('REVEX r42 Firestore boundary QA passed:', {
    sdkRealmPlainObjects: true,
    engineeringState: 'project-library',
    immutableRevision: true,
    uploads: sdkRealm.uploads.length,
    writes: sdkRealm.writes.length
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
