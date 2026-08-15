#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const runtime = path.join(root, 'docs', 'liber-apps', 'apps', 'revex', 'design-release-r51.js');
if (!fs.existsSync(runtime)) throw new Error(`Missing Design Book release runtime: ${runtime}`);

const memory = new Map();
global.window = global;
global.localStorage = {
  getItem(key) { return memory.has(key) ? memory.get(key) : null; },
  setItem(key, value) { memory.set(key, value); }
};
global.document = {
  readyState: 'loading',
  addEventListener() {},
  querySelectorAll() { return []; },
  getElementById() { return null; },
  head: { appendChild() {} },
  createElement() { return { dataset: {}, appendChild() {}, set textContent(_) {} }; }
};
global.addEventListener = () => {};
global.queueMicrotask = () => {};
global.setTimeout = () => 0;
global.CustomEvent = function CustomEvent() {};
global.__revexBrowserDiagnostics = { emit() {} };
global.RevexStore = {
  isCloud: () => false,
  user: { uid: 'qa-user' },
  toFirestorePlain: (value) => JSON.parse(JSON.stringify(value)),
  appendHistory: async () => null
};
global.__revexState = {
  projectId: 'qa-project',
  cloudState: { revision: 'rev_qa' },
  designData: {
    chapters: [{
      id: 'main-lobby', title: 'MAIN LOBBY', items: [{
        id: 'flooring', label: 'FLOORING', status: 'Not Selected', description: '', source: '', images: [],
        candidateMaterials: ['Oak Flooring'], revit: { category: 'Floors', family: 'Floor', type: 'Oak Flooring' }
      }]
    }]
  },
  designEdits: new Map(),
  selectedDesign: { id: 'flooring', label: 'FLOORING', chapterTitle: 'MAIN LOBBY', candidateMaterials: ['Oak Flooring'] }
};

vm.runInThisContext(fs.readFileSync(runtime, 'utf8'), { filename: runtime });

async function run() {
  const Store = global.RevexStore;
  const state = global.__revexState;

  let saved = await Store.saveDesignEdit('qa-project', 'flooring', {
    status: 'Proposed', description: 'White oak', source: 'https://example.test/oak'
  });
  assert.strictEqual(saved.status, 'Not Selected', 'Working edit leaked into released Design Book projection.');
  assert.strictEqual(saved.workingSnapshot.status, 'Proposed');
  assert.strictEqual(saved.releasedSnapshot, null);

  const release1 = await Store.releaseDesignPosition('qa-project', 'flooring');
  assert.strictEqual(release1.record.status, 'Proposed');
  assert.strictEqual(release1.record.description, 'White oak');
  assert.strictEqual(release1.version.releaseNumber, 1);
  assert.strictEqual(release1.version.versionKind, 'design-book-release');
  assert.strictEqual(release1.version.immutable, true);

  saved = await Store.saveDesignEdit('qa-project', 'flooring', {
    status: 'Approved', description: 'Natural white oak'
  });
  assert.strictEqual(saved.status, 'Proposed', 'Working draft changed the released card before Sync to Design Book.');
  assert.strictEqual(saved.description, 'White oak');
  assert.strictEqual(saved.workingSnapshot.status, 'Approved');
  assert.strictEqual(saved.draftDirty, true);

  let versions = await Store.listDesignVersions('qa-project', 'flooring');
  assert.strictEqual(versions.length, 1);
  assert.strictEqual(versions[0].snapshot.status, 'Proposed');

  const release2 = await Store.releaseDesignPosition('qa-project', 'flooring');
  assert.strictEqual(release2.record.status, 'Approved');
  assert.strictEqual(release2.record.description, 'Natural white oak');
  assert.strictEqual(release2.version.releaseNumber, 2);

  versions = await Store.listDesignVersions('qa-project', 'flooring');
  assert.strictEqual(versions.length, 2);
  assert.strictEqual(versions[0].snapshot.status, 'Approved');
  assert.strictEqual(versions[1].snapshot.status, 'Proposed');

  state.designEdits.set('legacy', {
    revexId: 'legacy', status: 'Approved', description: 'Existing released selection', source: 'legacy', images: [],
    updatedAt: '2026-08-14T00:00:00Z'
  });
  state.designData.chapters[0].items.push({ id: 'legacy', label: 'LEGACY ITEM', status: 'Not Selected', description: '', source: '', images: [] });
  saved = await Store.saveDesignEdit('qa-project', 'legacy', { status: 'Proposed', description: 'New working change' });
  assert.strictEqual(saved.status, 'Approved', 'Legacy current book state was not preserved as the migration release.');
  assert.strictEqual(saved.description, 'Existing released selection');
  assert.strictEqual(saved.workingSnapshot.status, 'Proposed');
  assert.strictEqual(saved.releaseNumber, 1);

  console.log(JSON.stringify({
    schema: 'liber.revex.design-release-r51.qa.v1',
    status: 'PASSED',
    workingPropertiesDoNotPublish: true,
    explicitSyncCreatesImmutableRelease: true,
    releasedCardUnaffectedByLaterDraft: true,
    fullPositionVersionSnapshots: true,
    releaseCount: versions.length,
    legacyBookStatePreserved: true
  }, null, 2));
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
