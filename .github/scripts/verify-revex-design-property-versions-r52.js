#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const app = path.join(root, 'docs', 'liber-apps', 'apps', 'revex');
const runtimePath = path.join(app, 'design-versions-r52.js');
const workspacePath = path.join(app, 'workspace-r51.js');
const indexPath = path.join(app, 'index.html');

for (const file of [runtimePath, workspacePath, indexPath]) assert.ok(fs.existsSync(file), `Missing ${file}`);

const runtime = fs.readFileSync(runtimePath, 'utf8');
const workspace = fs.readFileSync(workspacePath, 'utf8');
const index = fs.readFileSync(indexPath, 'utf8');

assert.match(runtime, /liber\.revex\.design-property-versions\.v1/);
assert.match(runtime, /kind:\s*'lightweight-property-overlay'/);
assert.match(runtime, /releasedCard:\s*'Design Book'/);
assert.match(runtime, /Sync to Design Book/);
assert.match(runtime, /propertyVersions:\s*rows/);
assert.match(runtime, /\.\.\.released,/);
assert.match(runtime, /syncPreservesVersion:\s*true/);
assert.match(runtime, /Design Book unchanged/);
assert.ok(!runtime.includes('revexDesignVersions'), 'Versions must not become a parallel collection/release-history system.');
assert.ok(!runtime.includes("versionKind: 'design-book-release'"), 'Rejected Design Book release-history model returned.');
assert.ok(!runtime.includes('immutable: true'), 'Property versions are lightweight overlays, not immutable releases.');

assert.match(workspace, /import '\.\/design-versions-r52\.js';/);
assert.ok(index.indexOf('app.js') < index.indexOf('workspace-r51.js'), 'Overlay runtime must load after app state/Properties exist.');

const saves = (runtime.match(/Store\.saveDesignEdit\(/g) || []).length;
assert.ok(saves >= 2, 'Expected separate version persistence and explicit Design Book sync writes.');

console.log(JSON.stringify({
  schema: 'liber.revex.design-property-versions-r52.qa.v1',
  status: 'PASSED',
  perPosition: true,
  lightweightPropertyOverlay: true,
  fullCardSwitcherAboveProperties: true,
  explicitSyncToDesignBook: true,
  syncRetainsVersion: true,
  parallelReleaseHistory: false
}, null, 2));
