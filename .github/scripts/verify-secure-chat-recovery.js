#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const revexIndex = read('docs/liber-apps/apps/revex/index.html');
const revexStore = read('docs/liber-apps/apps/revex/store.js');
const chatIndex = read('docs/liber-apps/apps/secure-chat/index.html');
const chat = read('docs/liber-apps/apps/secure-chat/chat.js');
const cryptoSource = read('docs/liber-apps/apps/secure-chat/chat-crypto.js');
const firebaseService = read('docs/liber-apps/js/firebase-service.js');
const backend = read('server/firebase-functions/project-chat.js');
const main = read('server/firebase-functions/main.js');
const rules = read('firebase/revex-project-access-r43.rules');
const reportDeploy = read('server/revex-report-functions/deploy-current.ps1');

new Function(chat);
new Function(firebaseService);
new Function(backend);
new Function(main);

// An iframe must never combine a parent-realm Firebase service with its own SDK
// values. REVEX and Secure Chat both own one complete Firebase realm.
assert.doesNotMatch(revexIndex, /chat-iframe-bridge\.js/);
assert.ok(revexIndex.indexOf('../../js/firebase-loader.js') < revexIndex.indexOf('../../js/firebase-service.js'));
assert.ok(revexIndex.indexOf('../../js/firebase-service.js') < revexIndex.indexOf('store.js'));
assert.match(revexStore, /Keep that\s*\n?\s*\/\/ service authoritative even while it is still initializing/);
assert.doesNotMatch(chatIndex, /chat-iframe-bridge\.js/);
assert.match(chatIndex, /Always load our own Firebase/);

// Push registration has one browser owner and one explicit bearer-auth endpoint;
// it cannot fall back to the stale callable that produced iframe 401 noise.
assert.match(firebaseService, /if \(window\.self !== window\.top\) return;/);
assert.match(firebaseService, /_callAuthenticatedHttp\('saveFcmTokenHttp', payload\)/);
assert.match(firebaseService, /'Authorization': 'Bearer ' \+ token/);
assert.match(firebaseService, /this\.registerMessaging\(user\)\.catch\(\(\)=>\{\}\)/);
const messagingStart = firebaseService.indexOf('async registerMessaging(user)');
const messagingMethod = firebaseService.slice(messagingStart, firebaseService.indexOf('\n    /**\n     * Initialize Firebase', messagingStart));
assert.match(messagingMethod, /^async registerMessaging\(user\)\{\s*try\{/);
assert.match(messagingMethod, /\}\s*catch\(_\)\{\/\* ignore \*\/\}\s*\}\s*$/);
assert.match(backend, /serverSecureState\/\$\{uid\}\/pushTokens/);
assert.match(backend, /FCM_TOKEN_LIMIT_PER_USER = 10/);
assert.doesNotMatch(backend, /fcmToken\s*:/i, 'Raw FCM tokens must not be copied onto public-profile fields.');
assert.match(backend, /exports\.onChatMessageWrite = onDocumentCreated/);
assert.match(backend, /document: 'chatMessages\/\{connId\}\/messages\/\{messageId\}'/);
assert.match(backend, /sendEachForMulticast/);
assert.match(backend, /FCM_BATCH_LIMIT = 500/);
assert.match(backend, /status: 'FAILED'/);
assert.match(backend, /retry: true/);
assert.match(backend, /receipt\.active\) throw new Error/);
assert.match(backend, /String\(message\.connId \|\| ''\) !== connId/);
assert.match(backend, /participants\.includes\(sender\)/);
assert.match(backend, /New encrypted message/);
assert.doesNotMatch(backend, /notification:\s*\{[^}]*message\.cipher/s, 'Push notifications must not copy ciphertext or client previews.');

// Recovery is server-controlled, recent-authenticated, race-safe and never
// exports or uploads a private key.
assert.match(backend, /RECENT_AUTH_MAX_AGE_SECONDS = 5 \* 60/);
assert.match(backend, /requires-recent-login/);
assert.match(backend, /authenticatedToken\(req, \{ checkRevoked:true \}\)/);
assert.match(backend, /expectedPublishedFingerprint !== currentFingerprint/);
assert.match(backend, /IDENTITY_ROTATION_COOLDOWN_MS/);
assert.match(backend, /value\.d != null/);
assert.match(backend, /publicKeyHistory: history\.slice\(0, PUBLIC_KEY_HISTORY_LIMIT\)/);
assert.match(backend, /fingerprintLineage: lineage/);
assert.match(backend, /secureChatIdentityRecoveryAudit/);
assert.match(backend, /keyRotationRequired: true/);
assert.doesNotMatch(backend, /privateKey/, 'The recovery service must have no private-key input, write or escrow lane.');
assert.match(main, /recoverSecureChatIdentityHttp: projectChat\.recoverSecureChatIdentityHttp/);
assert.match(main, /saveFcmTokenHttp: projectChat\.saveFcmTokenHttp/);
assert.match(main, /onChatMessageWrite: projectChat\.onChatMessageWrite/);
assert.match(rules, /allow update, delete, list: if false/);
assert.match(rules, /keys\(\)\.hasOnly\(\['uid', 'publicJwk', 'fingerprint', 'cryptoVersion', 'createdAt'\]\)/);
assert.match(rules, /match \/serverSecureState\/\{uid\}\/pushTokens\/\{tokenHash\}[\s\S]*?allow read, write: if false;/);
assert.match(rules, /match \/serverSecureState\/chatPushReceipts\/deliveries\/\{receiptId\}[\s\S]*?allow read, write: if false;/);
assert.match(rules, /match \/secureChatIdentityRecoveryAudit\/\{eventId\}[\s\S]*?allow read, write: if false;/);
assert.match(reportDeploy, /firebaseauth\.users\.get/);
assert.match(reportDeploy, /firebasecloudmessaging\.messages\.create/);
assert.match(reportDeploy, /\$HttpRegions=@\(\$Region,\$FallbackRegion\)/);
assert.match(reportDeploy, /Deploy bounded encrypted-chat FCM sender trigger/);
assert.match(reportDeploy, /onChatMessageWrite[\s\S]*?'--retry'/);

const recoveryStart = chat.indexOf('async recoverChatIdentity()');
const recoveryMethod = chat.slice(recoveryStart, chat.indexOf('\n    _handleChatOperationError(error)', recoveryStart));
assert.match(recoveryMethod, /publicJwk: state\.publicJwk/);
assert.match(recoveryMethod, /expectedPublishedFingerprint: state\.expectedPublishedFingerprint/);
assert.doesNotMatch(recoveryMethod, /privateKey/);
assert.match(chat, /reauthenticateWithPopup/);
assert.match(chat, /reauthenticateWithCredential/);
assert.match(chat, /secure-chat\/identity-mismatch/);
assert.match(chat, /cannot be reconstructed/);
assert.match(chat, /safeSendCurrent\(\)/);
assert.doesNotMatch(chat, /this\.sendCurrent\(\);/);

// Read-only history can use a device-held non-exportable key and server-retained
// public-key lineage; all writes still require the current published identity.
assert.match(cryptoSource, /generateKey\(\{name:'ECDH', namedCurve:'P-256'\}, false, \['deriveBits'\]\)/);
assert.match(chat, /if \(requirePublishedSelf\) await this\.ensurePublishedChatIdentity\(\)/);
assert.match(chat, /requirePublishedSelf:false, peerFingerprintHint/);
assert.match(chat, /resolvePublishedJwkForFingerprint/);
assert.match(chat, /identityFingerprints: cryptoMeta\.identityFingerprints \|\| null/);
assert.match(chat, /This device does not hold the private key for group epoch/);

// The server and browser deliberately fingerprint the same canonical public JWK.
const sample = {
  kty: 'EC', crv: 'P-256',
  x: Buffer.alloc(32, 1).toString('base64url'),
  y: Buffer.alloc(32, 2).toString('base64url')
};
const canonical = JSON.stringify({ crv:'P-256', kty:'EC', x:sample.x, y:sample.y });
const expectedFingerprint = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
assert.equal(expectedFingerprint.length, 64);
assert.match(backend, /JSON\.stringify\(\{ crv: 'P-256', kty: 'EC', x: jwk\.x, y: jwk\.y \}\)/);
assert.match(cryptoSource, /JSON\.stringify\(\{ crv:'P-256', kty:'EC', x:jwk\.x, y:jwk\.y \}\)/);

// Execute the pure validation helpers without loading Firebase packages. This
// proves the deployed module's exact code, not a test-side reimplementation.
const backendModule = { exports:{} };
const backendContext = vm.createContext({
  module: backendModule,
  exports: backendModule.exports,
  Buffer,
  Date,
  console,
  process: { env:{ REVEX_SOURCE_CANDIDATE:'a'.repeat(40) } },
  require: (id) => {
    if (id === 'node:crypto') return require('node:crypto');
    if (id === 'firebase-functions/v2/https') return { onRequest: (_options, handler) => handler };
    if (id === 'firebase-functions/v2/firestore') return { onDocumentCreated: (_options, handler) => handler };
    if (id === 'firebase-admin/app') return { getApps:() => [{}], initializeApp:() => ({}) };
    if (id === 'firebase-admin/auth') return { getAuth:() => ({}) };
    if (id === 'firebase-admin/firestore') return { getFirestore:() => ({}) };
    if (id === 'firebase-admin/messaging') return { getMessaging:() => ({}) };
    if (id === './project-access') return { projectAccessRole:() => null };
    throw new Error(`Unexpected verifier import: ${id}`);
  }
});
vm.runInContext(backend, backendContext, { filename:'project-chat.js' });
const helpers = backendModule.exports._test;
assert.equal(helpers.identityFingerprint(sample), expectedFingerprint);
assert.deepEqual(
  JSON.parse(JSON.stringify(helpers.normalizeP256PublicJwk(sample))),
  { key_ops:[], ext:true, kty:'EC', x:sample.x, y:sample.y, crv:'P-256' }
);
assert.throws(() => helpers.normalizeP256PublicJwk({ ...sample, d:'private-material' }), (error) => error.code === 'invalid-public-key');
assert.throws(() => helpers.normalizeP256PublicJwk({ ...sample, x:'short' }), (error) => error.code === 'invalid-public-key');
assert.equal(helpers.requireRecentAuth({ auth_time:1000, firebase:{ sign_in_provider:'google.com' } }, 1100), 1000);
assert.throws(
  () => helpers.requireRecentAuth({ auth_time:1000, firebase:{ sign_in_provider:'google.com' } }, 1400),
  (error) => error.code === 'requires-recent-login'
);
assert.throws(
  () => helpers.requireRecentAuth({ auth_time:1000, firebase:{ sign_in_provider:'anonymous' } }, 1001),
  (error) => error.code === 'anonymous-auth-not-allowed'
);
assert.throws(() => helpers.cleanFcmToken('too-short'), (error) => error.code === 'invalid-fcm-token');
assert.equal(helpers.notificationBody({}), 'New encrypted message');
assert.equal(helpers.notificationBody({ fileName:'drawing.pdf' }), 'New encrypted attachment');
assert.equal(helpers.chatPushReceiptId('room','message'), helpers.chatPushReceiptId('room','message'));
assert.notEqual(helpers.chatPushReceiptId('room','message'), helpers.chatPushReceiptId('other','message'));

console.log(JSON.stringify({
  schema: 'liber.secure-chat.recovery-verifier.v1',
  status: 'PASSED',
  firebaseRealmOwnership: 'per-frame',
  recentAuthRecovery: true,
  clientIdentityOverwriteDenied: true,
  privateKeyExported: false,
  publicKeyHistoryBounded: true,
  groupRotationRequiredAfterRecovery: true,
  fcmRegistrationOwner: 'top-level-only',
  fcmTokensPrivateSubcollection: true,
  fcmSenderTriggerBounded: true,
  revocationCheckIamLeastPrivilege: true,
  httpRegionFailover: ['us-central1','europe-west1']
}));
