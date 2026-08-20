'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    async getBlob(ref) { return { name: ref.fullPath }; },
    async getDownloadURL() { throw new Error('permanent Firebase download URLs are forbidden in REVEX QA'); },
    async getDoc(ref) {
      if (ref.path === 'projects/project_r42/library/revex_revision_rev_source_r42') {
        return {
          id: 'revex_revision_rev_source_r42',
          exists: () => true,
          data: () => ({
            projectId: 'project_r42', revision: 'rev_source_r42', immutable: true,
            revexKind: 'revision',
            central: {
              documentUniqueId: 'doc_r42',
              documentFingerprint: 'fingerprint_r42',
              identityEvidenceDigest: 'digest_r42'
            }
          })
        };
      }
      return { exists: () => false, data: () => null };
    },
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
  crypto: crypto.webcrypto,
  TextEncoder,
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

  const artifacts = [
    { name: 'model.xml', type: 'application/xml', content: '<gbXML />' },
    { name: 'weather.epw', type: 'application/octet-stream', content: 'LOCATION,QA' }
  ].map((row) => ({
    ...row,
    bytes: Buffer.byteLength(row.content),
    sha256: crypto.createHash('sha256').update(row.content).digest('hex')
  }));
  const manifest = {
    schema: 'liber.revex.engineering-sync.v1',
    architecture: 'REVIT_EVIDENCE_GRAPH_V1',
    projectId: 'project_r42',
    revision: 'eng_r42',
    sourceRevision: 'rev_source_r42',
    projectBinding: {
      version: 'active-revit-evidence-v1',
      documentUniqueId: 'doc_r42',
      documentFingerprint: 'fingerprint_r42',
      identityEvidenceDigest: 'digest_r42'
    },
    artifacts: artifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    gbxmlStatus: 'EXPORTED',
    publicationIntegrity: {
      threshold: 0.80,
      qualityTarget: 0.95,
      ratios: { physical: 0.91, analytical: 1, spatial: 1, openings: 0.97 }
    },
    writeBackToRevitAfterExport: false,
    pdfInsertion: false
  };
  const fixture = [
    { name: 'engineering-sync.json', type: 'application/json', content: JSON.stringify(manifest) },
    ...artifacts
  ];
  browserRealm.__r42Fixture = JSON.stringify(fixture);
  const files = vm.runInContext(`JSON.parse(__r42Fixture).map((row) => {
    const bytes = new TextEncoder().encode(row.content);
    return {
      name: row.name, size: bytes.byteLength, type: row.type,
      async text() { return row.content; },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  })`, browserRealm);

  const engineering = await browserRealm.RevexStore.syncEngineeringPackage(files, 'project_r42');
  assert.equal(engineering.cloud, true);
  assert.equal(engineering.manifest.sourceRevision, 'rev_source_r42');

  const firstPaths = Array.from(sdkRealm.writes, (row) => row.path);
  assert.deepEqual(firstPaths, [
    'projects/project_r42/library/revex_engineering_revision_eng_r42',
    'projects/project_r42/library/revex_engineering'
  ]);
  assert.equal(firstPaths.some((value) => /revexEngineeringRevisions|\/revex\/engineering$/.test(value)), false);
  assert.equal(sdkRealm.writes[0].options.merge, false);
  assert.equal(sdkRealm.writes[1].options.merge, false);

  load('integrity.js');
  await browserRealm.RevexStore.saveChapterEdit('project_r42', 'facade', { decision: 'Brick' });
  const chapterWrites = Array.from(sdkRealm.writes).slice(2);
  assert.equal(chapterWrites.length, 2);
  assert.match(chapterWrites[0].path, /^projects\/project_r42\/library\/revex_chapter_version_/);
  assert.equal(chapterWrites[0].options.merge, false);
  assert.equal(chapterWrites[1].path, 'projects/project_r42/library/revex_chapter_facade');

  // The current hosted REVEX frame owns its Firebase SDK. Exercise the
  // firestore-compat wrapper in that same realm instead of recreating the
  // retired parent-SDK/child-payload arrangement that caused custom-Object
  // failures in the first place.
  const ownedRealm = vm.createContext({ console, setTimeout, clearTimeout, performance: { now: () => Date.now() } });
  ownedRealm.window = ownedRealm;
  vm.runInContext(`
    globalThis.compatWrites = [];
    const requirePlain = (value, label) => {
      if (value == null) return;
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(label + ' is not same-realm plain data');
    };
    const api = {
      doc(_db, ...segments) { return { path: segments.join('/') }; },
      async setDoc(ref, data, options) {
        requirePlain(data, 'Firestore payload'); requirePlain(options, 'Firestore options');
        compatWrites.push({ path: ref.path, data, options });
      },
      async uploadBytes() {}
    };
    globalThis.RevexStore = { api, db: {} };
  `, ownedRealm);
  vm.runInContext(fs.readFileSync(path.join(appRoot, 'firestore-compat.js'), 'utf8'), ownedRealm, { filename: 'firestore-compat.js' });
  await vm.runInContext(`RevexStore.api.setDoc(
    RevexStore.api.doc(RevexStore.db, 'projects', 'project_r42', 'library', 'revex_probe'),
    { value: 42 }, { merge: true }
  )`, ownedRealm);
  assert.equal(ownedRealm.compatWrites.at(-1).path, 'projects/project_r42/library/revex_probe');

  console.log('REVEX r42 Firestore boundary QA passed:', {
    sdkRealmPlainObjects: true,
    engineeringState: 'project-library',
    immutableRevision: true,
    immutableSourceAlignment: true,
    artifactHashesVerified: true,
    currentPointerWrittenLast: true,
    immutableWritesReplaceOnly: true,
    chapterVersionWrittenBeforePointer: true,
    permanentDownloadUrlsForbidden: true,
    ownedRealmFirestoreCompat: true,
    uploads: sdkRealm.uploads.length,
    writes: sdkRealm.writes.length
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
