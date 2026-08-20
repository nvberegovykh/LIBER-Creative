'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const must = (text, marker, label) => assert.ok(text.includes(marker), label || `Missing ${marker}`);
const forbid = (text, marker, label) => assert.ok(!text.includes(marker), label || `Forbidden ${marker}`);

const client = read('docs/liber-apps/apps/revex/render-agent.js');
const store = read('docs/liber-apps/apps/revex/store.js');
const index = read('docs/liber-apps/apps/revex/index.html');
const broker = read('server/firebase-functions/index.js');
const main = read('server/firebase-functions/main.js');
const projectAccess = read('server/firebase-functions/project-access.js');
const deploy = read('server/revex-energy-worker/deploy-current.ps1');
const accessRules = read('firebase/revex-project-access-r43.rules');
const storageRules = read('firebase/revex-secure-chat-storage.rules');
const nativeWindow = read('src/Liber.Revex.Revit/UI/RendairWindow.cs');

must(index, 'render-agent.js?v=20260820r147-release1', 'REVEX must cache-break to the server-brokered Render client.');

// The add-in must open the same brokered REVEX surface as a browser user. Keep
// the historical provider bridge source available for rollback, but never wire
// the active native buttons or Enter shortcut to it.
for (const marker of [
  'private void OpenCompanionRender()',
  'await OpenCompanionAsync("bim")',
  'private async Task<bool> TryOpenCompanionRenderAsync()',
  "document.getElementById('render-button')",
  'window.__revexState?.projectId === expectedProject',
  'REVEX Render is ready for the current synced BIM viewport.'
]) must(nativeWindow, marker, `Native shared Render route missing: ${marker}`);
const nativeUiStart = nativeWindow.indexOf('_designControls.Children.Add(SectionTitle("REVEX AI RENDER"))');
const nativeUiEnd = nativeWindow.indexOf('BuildEngineeringControls();', nativeUiStart);
assert.ok(nativeUiStart >= 0 && nativeUiEnd > nativeUiStart, 'Could not isolate active native Render controls.');
const nativeUi = nativeWindow.slice(nativeUiStart, nativeUiEnd);
must(nativeUi, 'OpenCompanionRender()', 'Native Render controls must open the shared REVEX Render surface.');
forbid(nativeUi, 'QuickRenderCurrentView()', 'Native Enter/button route still invokes the retired provider automation.');
forbid(nativeUi, 'OpenRenderBridge()', 'Native Render controls still navigate directly to the retired provider bridge.');
forbid(nativeUi, 'Rendair', 'Active native Render copy still advertises the retired provider-specific route.');
const nativeNavStart = nativeWindow.indexOf('nav.Children.Add(MakeNavButton("BIM"');
const nativeNavEnd = nativeWindow.indexOf('nav.Children.Add(MakeNavButton("LIBER Account"', nativeNavStart);
assert.ok(nativeNavStart >= 0 && nativeNavEnd > nativeNavStart, 'Could not isolate native REVEX navigation.');
const nativeNav = nativeWindow.slice(nativeNavStart, nativeNavEnd);
must(nativeNav, 'MakeNavButton("Render", (_, _) => OpenCompanionRender())', 'Native Render navigation does not use the shared brokered surface.');
forbid(nativeNav, 'OpenRenderBridge()', 'Native navigation still exposes the retired provider bridge.');

// The browser owns capture and presentation only. Project authorization, Google
// credentials, quota and provider traffic remain on the authenticated server edge.
for (const marker of [
  "const REQUEST_SCHEMA = 'liber.revex.google-render-request.v1'",
  "const JOB_SCHEMA = 'liber.revex.google-render-job.v1'",
  "httpsCallable(functions, 'runRevexGoogleRender'",
  'Store.fileBlob(resultPath)',
  "provider: 'google-gemini-server'",
  "status: 'PREPARED'",
  'GEOMETRY LOCK',
  'captureRenderReference',
  'saveResultToDesignBook'
]) must(client, marker, `Render client contract missing: ${marker}`);
for (const forbidden of [
  'GoogleAuthProvider', 'reauthenticateWithPopup', 'linkWithPopup',
  'reauthenticateWithRedirect', 'linkWithRedirect', 'getRedirectResult',
  'x-goog-user-project', 'generativelanguage.googleapis.com',
  'google-ai-project', 'google-ai-connect', 'Authorization: `Bearer',
  'resultUrl:'
]) forbid(client, forbidden, `User OAuth/IAM or permanent result URL returned: ${forbidden}`);
assert.strictEqual((client.match(/URL\.createObjectURL\(/g) || []).length, 1, 'Render must create exactly one result object URL.');
must(client, 'disposeResultObjectUrl();\n    resultObjectUrl = URL.createObjectURL(blob);', 'Prior result object URL must be revoked before replacement.');
must(client, "root.addEventListener('pagehide', disposeResultObjectUrl", 'Result object URL must be revoked when the REVEX page leaves.');

const createStart = client.indexOf('activeJob = await Store?.createRenderJob');
const createEnd = client.indexOf('if (!activeJob?.id)', createStart);
assert.ok(createStart >= 0 && createEnd > createStart, 'Could not isolate controlled client Render job creation.');
const createJob = client.slice(createStart, createEnd);
forbid(createJob, 'prompt:', 'Raw user prompt must not be persisted in the pre-created Firestore job.');
forbid(createJob, 'refinedPrompt:', 'Refined prompt must not be persisted in the pre-created Firestore job.');
for (const marker of [
  'function controlledRenderJobId()',
  "return `render_${Date.now().toString(36)}_${nonce}`",
  "type: 'revex', hidden: true, revexKind: 'render', revexId: id",
  "status: 'PREPARED'",
  "this.api.doc(this.db, 'projects', projectId, 'revexRenders', id)",
  'await this.api.setDoc(ref, data, plain({ merge: false }))'
]) must(store, marker, `Controlled Render job writer missing: ${marker}`);
forbid(client, 'Store.updateRenderJob?.', 'The browser must not mutate a broker-owned Render record after acceptance.');

// Callable authorization and the separate server-only lease make acceptance
// one-shot even if two browser tabs race with the same controlled job identity.
for (const marker of [
  'exports.runRevexGoogleRender = onCall({',
  "region: 'us-central1'",
  'serviceAccount: GOOGLE_RENDER_SERVICE_ACCOUNT',
  "if (!uid) throw new HttpsError('unauthenticated'",
  'const access = await assertProjectAccess(projectId, uid, request.auth.token || {})',
  'job.schema === GOOGLE_RENDER_JOB_SCHEMA',
  "String(job.createdBy || '') === uid",
  "String(job.status || '').toUpperCase() === 'PREPARED'",
  'transaction.get(refs.lease)',
  'transaction.create(refs.lease',
  'projects/${projectId}/revexRenders/${jobId}',
  'projects/${projectId}/revexRenderJobs/${jobId}',
  "throw new HttpsError('already-exists'"
]) must(broker, marker, `Render acceptance boundary missing: ${marker}`);

for (const marker of [
  "new Set(['1K', '2K', '4K'])",
  "new Set(['image/png', 'image/jpeg', 'image/webp'])",
  'GOOGLE_RENDER_MAX_SOURCE_BYTES = 12 * 1024 * 1024',
  'GOOGLE_RENDER_MAX_RESULT_BYTES = 32 * 1024 * 1024',
  'GOOGLE_RENDER_MAX_PROMPT_BYTES = 24 * 1024',
  'GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES = 48 * 1024 * 1024',
  'imageMagicMatches',
  'decodeViewportDataUrl',
  'maxContentLength: GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES',
  "new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })",
  'https://generativelanguage.googleapis.com/v1/models/${GOOGLE_RENDER_MODEL}:generateContent',
  "responseModalities: ['TEXT', 'IMAGE']",
  "responseFormat: { image: { aspectRatio: '16:9', imageSize: resolution } }"
]) must(broker, marker, `Bounded Gemini execution missing: ${marker}`);

for (const marker of [
  'projects/${projectId}/revex/renders/${jobId}',
  'savePrivateRenderObject(bucket, sourcePath',
  'savePrivateRenderObject(bucket, resultPath',
  "cacheControl: 'private, max-age=0, no-store'",
  "status: 'COMPLETE', stage, resultPath",
  'resultPath,\n      resultMimeType:',
  "status: 'FAILED', stage: failure.stage",
  "error: { code: failure.code, message: failure.message, providerStatus: failure.providerStatus }"
]) must(broker, marker, `Durable path/status contract missing: ${marker}`);
for (const forbidden of ['getSignedUrl', 'getDownloadURL', 'firebaseStorageDownloadTokens'])
  forbid(broker, forbidden, `Permanent Storage capability must never be minted: ${forbidden}`);

// Execute the actual broker boundary helpers (not a rewritten test copy) against
// representative headers and hostile dimensions/encodings.
const helpersStart = broker.indexOf('function utf8Bytes');
const helpersEnd = broker.indexOf('function sanitizedUsage', helpersStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'Could not isolate Render image boundary helpers.');
class QaHttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const boundaryContext = { Buffer, HttpsError: QaHttpsError };
vm.runInNewContext(`
  const GOOGLE_RENDER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const GOOGLE_RENDER_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  const GOOGLE_RENDER_MAX_EDGE = 8192;
  const GOOGLE_RENDER_MAX_PIXELS = 48 * 1024 * 1024;
  ${broker.slice(helpersStart, helpersEnd)}
  this.boundary = { boundedUtf8, imageMagicMatches, decodeViewportDataUrl };
`, boundaryContext);
const boundary = boundaryContext.boundary;
const png = Buffer.alloc(24);
Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png, 0);
png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
assert.strictEqual(boundary.imageMagicMatches(png, 'image/png'), true, 'Valid bounded PNG header was rejected.');
assert.strictEqual(boundary.decodeViewportDataUrl(`data:image/png;base64,${png.toString('base64')}`).buffer.length, png.length);
const oversizedPng = Buffer.from(png); oversizedPng.writeUInt32BE(8193, 16);
assert.strictEqual(boundary.imageMagicMatches(oversizedPng, 'image/png'), false, 'Oversized source edge was accepted.');
const jpeg = Buffer.alloc(21); jpeg[0] = 0xff; jpeg[1] = 0xd8; jpeg[2] = 0xff; jpeg[3] = 0xc0;
jpeg.writeUInt16BE(17, 4); jpeg[6] = 8; jpeg.writeUInt16BE(1080, 7); jpeg.writeUInt16BE(1920, 9);
assert.strictEqual(boundary.imageMagicMatches(jpeg, 'image/jpeg'), true, 'Valid bounded JPEG SOF header was rejected.');
const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'ascii'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8, 'ascii');
webp.write('VP8X', 12, 'ascii'); webp.writeUInt32LE(10, 16); webp[24] = 0x7f; webp[25] = 0x07; webp[27] = 0x37; webp[28] = 0x04;
assert.strictEqual(boundary.imageMagicMatches(webp, 'image/webp'), true, 'Valid bounded WebP VP8X header was rejected.');
assert.throws(() => boundary.decodeViewportDataUrl('data:image/svg+xml;base64,PHN2Zz4='), /PNG, JPEG or WebP/);
assert.throws(() => boundary.decodeViewportDataUrl('data:image/png;base64,not_base64!'), /PNG, JPEG or WebP/);
assert.ok(Buffer.byteLength(boundary.boundedUtf8('😀'.repeat(20), 31), 'utf8') <= 31, 'UTF-8 response text boundary split past its byte limit.');

const completeStart = broker.indexOf("stage = 'COMPLETE'");
const completeEnd = broker.indexOf("renderLog('COMPLETE'", completeStart);
assert.ok(completeStart >= 0 && completeEnd > completeStart, 'Could not isolate COMPLETE Render persistence.');
const completePersistence = broker.slice(completeStart, completeEnd);
forbid(completePersistence, 'sourcePath', 'Firestore Render completion must not persist the private source path.');
forbid(completePersistence, 'imageDataUrl', 'Firestore Render completion must not persist viewport image plaintext.');
forbid(completePersistence, 'text,', 'Firestore Render completion must not persist provider response text.');

must(main, '...energy', 'Google Render must compose with every existing Energy export.');
for (const marker of ['ensureProjectChatHttp', 'recoverSecureChatIdentityHttp', 'saveFcmTokenHttp', 'onChatMessageWrite'])
  must(main, marker, `Project Chat export was lost: ${marker}`);

for (const marker of [
  'generativelanguage.googleapis.com',
  'roles/serviceusage.serviceUsageConsumer',
  'REVEX_RENDER_BROKER_SERVICE_ACCOUNT=$BrokerSa',
  "'runRevexGoogleRender'",
  'functions","describe","runRevexGoogleRender"',
  'Google Render broker source SHA does not match the release source.',
  'Google Render broker is not attached to the controlled broker identity.'
]) must(deploy, marker, `Render deploy/preflight contract missing: ${marker}`);

must(accessRules, "projectCollection == 'revexRenderJobs'", 'Render lease lane must be immutable to browser clients.');
must(accessRules, "projectCollection == 'revexRenders'", 'Render request/status lane must bypass the mutable catch-all.');
must(accessRules, 'match /revexRenders/{jobId}', 'Controlled Render request rule missing.');
must(accessRules, 'revexR43ValidRenderRequest(jobId)', 'Controlled Render request schema guard missing.');
must(accessRules, 'match /revexRenderJobs/{jobId}', 'Render lease read boundary missing.');
must(storageRules, 'function revexStorageBrokerOwnedRenderObject(objectName, projectId)', 'Broker-owned Render Storage classifier missing.');
must(storageRules, '!revexStorageBrokerOwnedRenderObject(request.resource.name, projectId)', 'Browser Render object create/update denial missing.');
must(storageRules, '!revexStorageBrokerOwnedRenderObject(resource.name, projectId)', 'Browser Render object delete denial missing.');
must(projectAccess, "'run-render'", 'Project owner/member/admin functional parity must include Render.');
must(projectAccess, 'trustedAdminClaims(authClaims)', 'Render administrator authority must use verified Auth claims.');
forbid(projectAccess, 'userData?.role', 'A mutable user profile must not grant Render administrator authority.');

console.log(JSON.stringify({
  schema: 'liber.revex.google-render-broker.v1',
  status: 'PASSED',
  client: { userGoogleOAuth: false, userCloudProject: false, authenticatedPathRead: true, objectUrls: 1 },
  broker: { region: 'us-central1', model: 'gemini-3.1-flash-image', oneShotLease: true, pathOnly: true },
  limits: { sourceMiB: 12, resultMiB: 32, providerResponseMiB: 48, promptKiB: 24, resolutions: ['1K', '2K', '4K'] },
  deploy: { generativeLanguageApi: true, serviceUsageConsumer: true, sourceBound: true }
}, null, 2));
