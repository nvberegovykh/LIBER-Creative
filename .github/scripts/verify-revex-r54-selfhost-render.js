'use strict';

// Historical workflow compatibility gate. r54's Qwen renderer is preserved as a
// non-owning enhancement, while the current product owner is the authenticated
// runRevexGoogleRender server broker. Keep the old filename so older workflows
// converge on current security/interaction QA instead of silently dropping coverage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const must = (text, marker, label) => assert.ok(text.includes(marker), label || `Missing ${marker}`);
const forbid = (text, marker, label) => assert.ok(!text.includes(marker), label || `Forbidden ${marker}`);

const index = read('docs/liber-apps/apps/revex/index.html');
const workspace = read('docs/liber-apps/apps/revex/workspace-r51.js');
const client = read('docs/liber-apps/apps/revex/render-agent.js');
const broker = read('server/firebase-functions/index.js');
const functionsMain = read('server/firebase-functions/main.js');
const selfhost = read('docs/liber-apps/apps/revex/render-selfhost-r54.js');
const modelManifest = JSON.parse(read('server/revex-render-worker/model-manifest.json'));
const release = JSON.parse(read('REVEX_CURRENT_RELEASE.json'));

// The browser loads exactly one canonical Render owner, and it cannot return to
// direct Google OAuth, a user-supplied Cloud project, or the preserved GPU path.
must(index, 'render-agent.js?v=20260820r147-release1');
forbid(index, 'render-selfhost-r54.js');
forbid(workspace, "import './render-selfhost-r54.js");
must(client, "httpsCallable(functions, 'runRevexGoogleRender'");
must(client, 'Store.fileBlob(resultPath)');
must(client, "provider: 'google-gemini-server'");
for (const marker of [
  'GoogleAuthProvider', 'reauthenticateWithPopup', 'linkWithPopup',
  'x-goog-user-project', 'generativelanguage.googleapis.com'
]) forbid(client, marker, `current Render client must not own Google credential/quota traffic: ${marker}`);

// Server authority remains explicit and source-bound.
must(broker, 'exports.runRevexGoogleRender = onCall({');
must(broker, "region: 'us-central1'");
must(broker, 'const bucket = getStorage().bucket(bucketName)');
must(broker, "String(job.provider || '') === 'google-gemini-server'");
must(functionsMain, "const energy = require('./index')");
must(functionsMain, '...energy');
assert.equal(release.current.renderRuntime, 'docs/liber-apps/apps/revex/render-agent.js');
assert.equal(release.current.renderBrokerRuntime, 'server/firebase-functions/index.js');
assert.equal(release.current.renderBrokerFunction, 'runRevexGoogleRender');
assert.equal(release.current.renderBrokerRegion, 'us-central1');
must(release.preservedShadows.cloud, 'Qwen Render worker remains preserved as a non-owning enhancement');

// Preserve the pinned public Qwen implementation without allowing it to become
// the default product owner or require browser/provider credentials.
must(selfhost, "provider: 'revex-selfhosted'");
must(selfhost, 'browserInference: false');
must(selfhost, 'extraLogin: false');
forbid(selfhost, 'new MutationObserver');
assert.equal(modelManifest.model, 'Qwen/Qwen-Image-Edit-2511');
assert.equal(modelManifest.revision, '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9');
assert.equal(modelManifest.integrity.revisionPinned, true);
assert.equal(modelManifest.integrity.allowMovingMain, false);

// Reuse current canonical gates. This intentionally fails closed if broker
// security, viewport geometry locking, Measure/Section, mobile Docs, or accepted
// Energy/current-generation behavior regresses.
require('./verify-revex-google-render-broker.js');
require('./verify-revex-r144-experience.js');
require('./verify-revex-current-generation-r53.js');

console.log(JSON.stringify({
  schema: 'liber.revex.current-render-energy-viewer-compat.v1',
  status: 'PASSED',
  historicalWorkflowName: 'r54',
  canonicalRenderer: 'firebase-authenticated-runRevexGoogleRender',
  selfHostedRenderer: 'preserved-non-owning-shadow',
  userGoogleOAuth: false,
  browserInference: false,
  currentInteractionAndEnergyGates: true
}, null, 2));
