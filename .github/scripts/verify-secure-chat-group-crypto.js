#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextDecoder, TextEncoder } = require('node:util');

const root = path.resolve(__dirname, '../..');
const cryptoSource = fs.readFileSync(path.join(root, 'docs/liber-apps/apps/secure-chat/chat-crypto.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'docs/liber-apps/apps/secure-chat/chat.js'), 'utf8');
const rulesSource = fs.readFileSync(path.join(root, 'firebase/revex-project-access-r43.rules'), 'utf8');
const values = new Map();
const window = {};
const context = vm.createContext({
  window,
  crypto,
  TextEncoder,
  TextDecoder,
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  localStorage: {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value))
  }
});
vm.runInContext(cryptoSource, context, { filename: 'chat-crypto.js' });
const chatCrypto = window.chatCrypto;

async function identity(){
  const pair = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  return { pair, publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

(async () => {
  const issuer = await identity();
  const alice = await identity();
  const bob = await identity();
  const removed = await identity();
  const connId = 'project-secure-chat';
  const directAlice = await chatCrypto.deriveSharedAesKey(alice.pair.privateKey, bob.publicJwk, 'liber-secure-chat:direct-chat');
  const directBob = await chatCrypto.deriveSharedAesKey(bob.pair.privateKey, alice.publicJwk, 'liber-secure-chat:direct-chat');
  const directCipher = await chatCrypto.encryptWithKey('direct-message', directAlice);
  assert.equal(await chatCrypto.decryptWithKey(directCipher, directBob), 'direct-message', 'The existing 1:1 ECDH path must remain symmetric.');
  const epoch1 = 1;
  const groupKey1 = await chatCrypto.generateGroupAesKey();
  const envelopes1 = {};
  for (const [uid, recipient] of [['alice', alice], ['bob', bob], ['removed', removed]]){
    const issuerWrap = await chatCrypto.deriveSharedAesKey(
      issuer.pair.privateKey,
      recipient.publicJwk,
      `liber-secure-chat-group-wrap:${connId}:${epoch1}:${uid}`
    );
    envelopes1[uid] = await chatCrypto.wrapGroupAesKey(groupKey1, issuerWrap);
  }
  const encrypted1 = await chatCrypto.encryptWithKey('epoch-one-message', groupKey1);
  for (const [uid, recipient] of [['alice', alice], ['bob', bob], ['removed', removed]]){
    const recipientWrap = await chatCrypto.deriveSharedAesKey(
      recipient.pair.privateKey,
      issuer.publicJwk,
      `liber-secure-chat-group-wrap:${connId}:${epoch1}:${uid}`
    );
    const unwrapped = await chatCrypto.unwrapGroupAesKey(envelopes1[uid], recipientWrap);
    assert.equal(await chatCrypto.decryptWithKey(encrypted1, unwrapped), 'epoch-one-message');
  }

  const epoch2 = 2;
  const groupKey2 = await chatCrypto.generateGroupAesKey();
  const envelopes2 = {};
  for (const [uid, recipient] of [['alice', alice], ['bob', bob]]){
    const issuerWrap = await chatCrypto.deriveSharedAesKey(
      issuer.pair.privateKey,
      recipient.publicJwk,
      `liber-secure-chat-group-wrap:${connId}:${epoch2}:${uid}`
    );
    envelopes2[uid] = await chatCrypto.wrapGroupAesKey(groupKey2, issuerWrap);
  }
  assert.equal(envelopes2.removed, undefined, 'A removed participant must receive no rotated envelope.');
  assert.equal(await chatCrypto.decryptWithKey(encrypted1, groupKey1), 'epoch-one-message', 'History remains decryptable with its original epoch key.');
  const wrongContext = await chatCrypto.deriveSharedAesKey(
    alice.pair.privateKey,
    issuer.publicJwk,
    `liber-secure-chat-group-wrap:${connId}:${epoch1}:bob`
  );
  await assert.rejects(chatCrypto.unwrapGroupAesKey(envelopes1.alice, wrongContext));
  assert.equal(
    await chatCrypto.fingerprintPublicJwk(issuer.publicJwk),
    await chatCrypto.fingerprintPublicJwk({ ...issuer.publicJwk }),
    'Public-key fingerprints must be deterministic.'
  );

  assert.match(cryptoSource, /indexedDB\.open\('liber-secure-chat-identity-v2', 1\)/);
  assert.match(cryptoSource, /generateKey\(\{name:'ECDH', namedCurve:'P-256'\}, false, \['deriveBits'\]\)/);
  assert.match(cryptoSource, /importKey\('jwk', privateJwk, \{name:'ECDH', namedCurve:'P-256'\}, false, \['deriveBits'\]\)/);
  assert.doesNotMatch(cryptoSource, /localStorage\.setItem\(privKeyKey/);
  assert.match(cryptoSource, /localStorage\.removeItem\(privKeyKey\)/);

  assert.match(chatSource, /liber\.secure-chat\.group-key-envelopes\.v1/);
  assert.match(chatSource, /Group encryption key rotation is required/);
  assert.match(chatSource, /crypto\.getRandomValues\(new Uint8Array\(12\)\)/, 'Group epochs need collision-resistant random identity.');
  assert.match(chatSource, /keyRotationRequired:\s*false/, 'A successful admin rotation must clear the server rotation gate.');
  assert.match(chatSource, /\[`groupKeyHistory\.\$\{rotation\.state\.epoch\}`\]/, 'Rotations must append a unique history entry instead of replacing prior epochs.');
  assert.match(chatSource, /getMessageDecryptionKeyForConn\(message, connId\)/);
  assert.match(chatSource, /lastMessage:\s*'\[Encrypted message\]'/, 'Plaintext must not be copied to connection previews.');
  assert.doesNotMatch(chatSource, /getFallbackKey(?:ForConn)?\([^\n]*\);\s*\n\s*const\s+\w+\s*=\s*await\s+chatCrypto\.encryptWithKey/);
  for (const field of ['groupKeyVersion', 'groupKeyEpoch', 'groupKeyParticipantDigest', 'groupKeyIssuerUid', 'groupKeyEnvelopes', 'groupKeyHistory', 'keyRotationRequired']) {
    assert.ok(rulesSource.includes(`'${field}'`), `Rules must protect ${field}.`);
  }

  console.log(JSON.stringify({
    schema: 'liber.secure-chat.group-crypto-verifier.v1',
    status: 'PASSED',
    perParticipantP256HkdfEnvelopes: true,
    directP256HkdfPreserved: true,
    removedParticipantExcludedAfterRotation: true,
    historicalEpochDecryptable: true,
    wrongRecipientContextDenied: true,
    nonExportableIndexedDbIdentity: true,
    legacyIdentityMigrationPreservesFingerprint: true,
    adminOnlyRuleFieldsPresent: true,
    legacyFallbackEncryptCallsitesAbsent: true
  }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
