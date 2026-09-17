#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const storeSource = read('docs/liber-apps/apps/revex/store.js');
const integrity = read('docs/liber-apps/apps/revex/integrity.js');
const docsSync = read('docs/liber-apps/apps/revex/sync-docs-r24.js');
const docsPages = read('docs/liber-apps/apps/revex/docs-pages-r115.js');
const specCompat = read('docs/liber-apps/apps/specifications/revex-source-compat-r49.js');
const app = read('docs/liber-apps/apps/revex/app.js');
const dailyHistory = read('docs/liber-apps/apps/revex/history-daily-r126.js');
const energyWorker = read('server/revex-energy-worker/app.py');
const energyBroker = read('server/firebase-functions/index.js');
const reportWorker = read('server/revex-report-functions/index.js');
const tokenRevoker = read('server/firebase-functions/revoke-revex-download-tokens.js');

for (const [label, source] of [['store', storeSource], ['integrity', integrity], ['Docs sync', docsSync], ['Docs pages', docsPages]])
  assert.doesNotMatch(source, /getDownloadURL\s*\(/, `${label} must not mint permanent Firebase download-token URLs`);
assert.match(storeSource, /async fileBlob\(storagePath\)/);
assert.match(storeSource, /getBlob\(this\.api\.ref\(this\.fs\.storage, scopedPath\)\)/);
assert.match(storeSource, /URL\.createObjectURL\(blob\)/);
assert.match(storeSource, /blobUrlCacheProjectId !== assetProjectId\) clearBlobUrlCache\(\)/);
assert.match(storeSource, /Blocked a legacy permanent Firebase download URL/);
assert.match(integrity, /immutable: true, createdAt: state\.syncedAt/);
assert.doesNotMatch(integrity, /payloadUrl:\s*storageUrl/);
assert.match(specCompat, /await bridge\?\.fileUrl\?\.\(storagePath\)/);
assert.doesNotMatch(storeSource, /manifestUrl:\s*manifestUpload\.url/);
assert.match(storeSource, /manifestPath:\s*manifestUpload\.path/);
assert.doesNotMatch(app, /updateRenderJob\([^\n]+resultUrl:/);
assert.match(app, /resultPath:\s*result\?\.path/);
assert.match(integrity, /delete data\.resultUrl/);
assert.match(integrity, /next\.resultPath\) next\.resultUrl = await Store\.fileUrl\(next\.resultPath\)/);

// The boundary applies equally to server writers. Authenticated clients cannot
// recover project isolation if a privileged worker mints a bearer URL.
for (const [label, source] of [['Energy worker', energyWorker], ['Report worker', reportWorker]]) {
  assert.doesNotMatch(source, /firebaseStorageDownloadTokens/, `${label} must not mint Firebase bearer-token metadata`);
  assert.doesNotMatch(source, /firebasestorage\.googleapis\.com[^\n]+token=/i, `${label} must not return permanent download-token URLs`);
}
assert.match(energyWorker, /def upload_private\(/);
assert.match(energyWorker, /"manifestPath": manifest_upload\["path"\]/);
assert.doesNotMatch(energyWorker, /"manifestUrl"/);
assert.match(energyWorker, /bucket_name != STORAGE_BUCKET/);
assert.match(reportWorker, /async function uploadPrivate\(/);
assert.match(reportWorker, /pdfPath:pdfUpload\.path/);
assert.match(reportWorker, /evidencePath:jsonUpload\.path/);
assert.doesNotMatch(reportWorker, /pdfUrl|evidenceUrl/);
assert.match(reportWorker, /if \(!configured\) throw new Error\('REVEX Report has no exact release-bound Firebase Storage bucket\.'/);
assert.match(reportWorker, /canonicalProjectLibraryPath\(projectId, row\?\.storagePath\)/);
assert.match(reportWorker, /bucket\(\)\.file\(policy\.path, \{ generation: policy\.generation \}\)/);
assert.match(reportWorker, /versionedFile\.download\(\{ validation: 'crc32c' \}\)/);
assert.doesNotMatch(reportWorker, /readBytes\(row\.storagePath\)/);
assert.match(energyBroker, /artifactBucket && artifactBucket !== configuredBucket/);
assert.match(energyBroker, /manifestPath: body\.manifestPath \|\| null/);
assert.doesNotMatch(energyBroker, /manifestUrl:\s*body\./);

// Legacy Daily Report rows are recovered by extracting only the project-scoped
// object name and then re-authorizing through the Firebase SDK. The old URL is
// never fetched or retained in the rendered row.
assert.match(dailyHistory, /path\.startsWith\(`projects\/\$\{projectId\}\/revex\/daily-reports\/`\)\?path:''/);
assert.match(dailyHistory, /next=\{\.\.\.row,pdfUrl:null\}/);
assert.match(dailyHistory, /next\.pdfUrl=await Store\.fileUrl\(path\)/);

// Revocation is a separately-invoked, source/project/bucket-bound controller.
// It defaults to read-only, requires two apply acknowledgements, updates with a
// metageneration CAS, and cannot delete objects or mutate Firestore.
assert.match(tokenRevoker, /const options = \{ apply: false, confirmRevoke: false \}/);
assert.match(tokenRevoker, /--apply/);
assert.match(tokenRevoker, /--confirm-revoke/);
assert.match(tokenRevoker, /sourceCandidate !== currentSource\(\)/);
assert.match(tokenRevoker, /new Set\(\[`\$\{projectId\}\.appspot\.com`, `\$\{projectId\}\.firebasestorage\.app`\]\)/);
assert.match(tokenRevoker, /energy\\\/server-results/);
assert.match(tokenRevoker, /daily-reports/);
assert.match(tokenRevoker, /TOKEN_METADATA_KEY = 'firebaseStorageDownloadTokens'/);
assert.match(tokenRevoker, /\{ ifMetagenerationMatch: metageneration \}\);/);
assert.match(tokenRevoker, /firestoreRecordsChanged: 0/);
assert.match(tokenRevoker, /objectsDeleted: 0/);
assert.doesNotMatch(tokenRevoker, /getFirestore|deleteDoc|\.delete\s*\(/);

const window = {
  location: { href: 'https://liberpict.com/liber-apps/apps/revex/' },
  addEventListener() {}, dispatchEvent() {},
  URL, crypto: globalThis.crypto
};
vm.runInNewContext(storeSource, { window, URL, FileReader: function(){}, CustomEvent: function(){}, console, setTimeout, clearTimeout }, { filename: 'store.js' });
const boundary = window.__revexStorageDataBoundary;
assert.ok(boundary, 'store must expose its executable data-boundary contract');

assert.equal(boundary.isLegacyFirebaseDownloadUrl('https://firebasestorage.googleapis.com/v0/b/demo/o/file?alt=media&token=forever'), true);
assert.equal(boundary.isLegacyFirebaseDownloadUrl('blob:https://liberpict.com/session-only'), false);
assert.equal(boundary.projectStoragePath('projects/alpha/revex/revisions/r/project.json'), 'projects/alpha/revex/revisions/r/project.json');
assert.throws(() => boundary.projectStoragePath('../outside'), /project file path is invalid|project-scoped/);
window.__revexState = { projectId:'beta' };
assert.throws(() => boundary.projectStoragePath('projects/alpha/revex/revisions/r/project.json'), /cross-project/);
assert.equal(boundary.projectStoragePath('projects/beta/revex/revisions/r/project.json'), 'projects/beta/revex/revisions/r/project.json');
window.__revexState = null;

const manifest = {
  projectId: 'alpha', sourceRevision: 'rev_1',
  projectBinding: {
    documentUniqueId: 'doc-1', documentFingerprint: 'revitdoc_1', identityEvidenceDigest: 'a'.repeat(64)
  }
};
const source = {
  projectId: 'alpha', revision: 'rev_1', revexKind: 'revision', immutable: true,
  central: {
    documentUniqueId: 'doc-1', documentFingerprint: 'revitdoc_1', identityEvidenceDigest: 'a'.repeat(64)
  }
};
assert.equal(boundary.assertEngineeringSourceAlignment(source, manifest, 'alpha'), 'rev_1');
assert.throws(() => boundary.assertEngineeringSourceAlignment({ ...source, immutable: false }, manifest, 'alpha'), /not the exact immutable/);
assert.throws(() => boundary.assertEngineeringSourceAlignment(source, { ...manifest, sourceRevision: 'rev_2' }, 'alpha'), /not the exact immutable/);
assert.throws(() => boundary.assertEngineeringSourceAlignment(source, { ...manifest, projectId: 'beta' }, 'alpha'), /different projects/);
assert.throws(() => boundary.assertEngineeringSourceAlignment(source, {
  ...manifest, projectBinding: { ...manifest.projectBinding, documentFingerprint: 'revitdoc_other' }
}, 'alpha'), /fingerprint does not match/);

const validationAt = storeSource.indexOf('assertEngineeringSourceAlignment({ id: sourceSnap.id');
const engineeringUploadAt = storeSource.indexOf('const base = `projects/${projectId}/revex/engineering/revisions/${revision}`');
assert.ok(validationAt > 0 && engineeringUploadAt > validationAt, 'source-envelope validation must finish before the first Engineering upload path is opened');

for (const marker of [
  'attemptId', '__liberRevexNativeSyncEnvelope', 'liberRevexNativeAttemptId', 'projectId', 'revision', 'documentUniqueId', 'documentFingerprint', 'identityEvidenceDigest',
  "type: 'liber:revex-sync-result', ok: true", "type: 'liber:revex-sync-result', ok: false"
]) assert.ok(app.includes(marker), `sync result is missing exact envelope marker ${marker}`);

console.log(JSON.stringify({
  REVEX_STORAGE_DATA_BOUNDARY: 'PASSED',
  persistedFirebaseDownloadTokens: false,
  serverMintedPermanentDownloadTokens: false,
  legacyRevocationController: 'dry-run-default; explicit source-bound apply',
  authenticatedBlobHydration: true,
  dailyReportLegacyCompatibility: 'authenticated-path-derivation-only',
  legacyTokenUrlsFailClosed: true,
  crossProjectBlobCacheReuseDenied: true,
  renderResultPersistence: 'path-only',
  exactSourceEngineeringEnvelope: true,
  nativeAttemptEnvelopeEcho: true
}));
