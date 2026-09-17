#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

const designPath = ['docs','liber-apps','apps','revex','design-versions-r52.js'];
const workspacePath = ['docs','liber-apps','apps','revex','workspace-r51.js'];
const rendererPath = ['docs','liber-apps','apps','revex','render-agent.js'];
const renderBrokerPath = ['server','firebase-functions','index.js'];
const gbxmlPath = ['src','Liber.Revex.Revit','Engineering','Gbxml','LIBER_gbXML_Preflight_and_Export.py'];
const gbxmlDynPath = ['src','Liber.Revex.Revit','Engineering','Gbxml','LIBER_gbXML_Preflight_and_Export.dyn'];
const energyQaPath = ['src','Liber.Revex.Revit','Engineering','Energy','verify_revex_r49_energy.py'];

for (const p of [designPath, workspacePath, rendererPath, renderBrokerPath, gbxmlPath, gbxmlDynPath, energyQaPath]) {
  assert.ok(exists(...p), `Current REVEX generation file was removed: ${p.join('/')}`);
}

const design = read(...designPath);
assert.match(design, /liber\.revex\.design-property-versions\.v1/);
assert.match(design, /kind:\s*'lightweight-property-overlay'/);
assert.match(design, /Sync to Design Book/);
assert.match(design, /syncPreservesVersion:\s*true/);
assert.ok(!design.includes("versionKind: 'design-book-release'"), 'Rejected Design Book release-history model returned.');
assert.ok(!design.includes('immutable: true'), 'Design Book Property versions became immutable releases again.');

const workspace = read(...workspacePath);
assert.match(workspace, /import '\.\/design-versions-r52\.js';/);
assert.match(workspace, /captureRenderReference/);
assert.match(workspace, /accLikeWalk:\s*true/);
assert.match(workspace, /spatialObjectsVisible:\s*false/);

const renderer = read(...rendererPath);
const renderBroker = read(...renderBrokerPath);
assert.match(renderer, /gemini-3\.1-flash-image/);
assert.match(renderer, /runRevexGoogleRender/);
assert.match(renderer, /Store\.fileBlob\(resultPath\)/);
assert.match(renderer, /captureRenderReference/);
assert.match(renderer, /GEOMETRY LOCK/);
assert.ok(!renderer.includes('x-goog-user-project'), 'User Google Cloud IAM/quota project returned to the Render client.');
assert.ok(!renderer.includes('GoogleAuthProvider'), 'User Google OAuth returned to the Render client.');
assert.ok(!renderer.includes('rendair.com'), 'External Rendair routing returned.');
assert.match(renderBroker, /exports\.runRevexGoogleRender = onCall/);
assert.match(renderBroker, /new GoogleAuth\(\{ scopes: \['https:\/\/www\.googleapis\.com\/auth\/cloud-platform'\] \}\)/);
assert.match(renderBroker, /transaction\.create\(refs\.lease/);
assert.match(renderBroker, /projects\/\$\{projectId\}\/revex\/renders\/\$\{jobId\}/);

const gbxml = read(...gbxmlPath);
const energyQa = read(...energyQaPath);
const dyn = JSON.parse(read(...gbxmlDynPath));
const pythonNodes = (dyn.Nodes || []).filter((node) => node.NodeType === 'PythonScriptNode');
assert.equal(pythonNodes.length, 1, 'gbXML Dynamo graph must have one authoritative Python node.');
assert.equal(pythonNodes[0].Code.replace(/\r\n/g,'\n').replace(/\r/g,'\n'), gbxml.replace(/\r\n/g,'\n').replace(/\r/g,'\n'), 'gbXML Dynamo/Python engine identity drifted.');
assert.match(gbxml, /def reconcile_publication_message_severity\(/);
assert.match(gbxml, /REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW/);
assert.match(energyQa, /accepted gbXML path does not invoke publication severity reconciliation/);
assert.match(energyQa, /sub-80 geometry integrity failure was incorrectly downgraded/);

console.log(JSON.stringify({
  schema: 'liber.revex.current-generation-regression-r53.v1',
  status: 'PASSED',
  designBookPropertyVersions: 'lightweight-per-position-overlays',
  designBookExplicitSync: true,
  googleRenderer: 'gemini-3.1-flash-image',
  viewportGeometryLock: true,
  accLikeWalk: true,
  spatialObjectsVisible: false,
  midwoodAcceptedGbxmlSeverityReconciliation: true,
  gbxmlDynamoPythonIdentity: true
}, null, 2));
