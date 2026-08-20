#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const secureKeys = read('docs/liber-apps/js/secure-keys.js');
const email = read('docs/liber-apps/js/email-service.js');
const chat = read('docs/liber-apps/apps/secure-chat/chat.js');
const wallt = read('docs/liber-apps/js/wallt-agent.js');
const revexWallt = read('docs/liber-apps/apps/revex/wallt-agent.js');
const assistant = read('docs/liber-apps/js/chatgpt-integration.js');

for (const source of [secureKeys, email, chat, wallt, revexWallt, assistant]) new Function(source);

const memory = new Map([['liber_keys_url', 'https://attacker.invalid/config.json']]);
const context = vm.createContext({
  console, atob, btoa, URL, TextEncoder, TextDecoder,
  crypto: require('node:crypto').webcrypto,
  fetch: async () => { throw new Error('network disabled in security verifier'); },
  localStorage: {
    getItem(key) { return memory.get(key) || null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); }
  }
});
context.window = context;
vm.runInContext(secureKeys, context, { filename: 'secure-keys.js' });
const manager = context.secureKeyManager;
assert.equal(manager.getKeySource(), 'https://europe-west1-liber-apps-cca20.cloudfunctions.net/getPublicConfig');
assert.equal(manager.setKeySource('https://attacker.invalid/config.json'), false);
assert.equal(memory.has('liber_keys_url'), false);

const clean = manager.sanitizePublicConfig({
  firebase: { projectId: 'liber-apps-cca20', apiKey: 'public-firebase-key', functionsRegion: 'us-central1', privateKey: 'forbidden' },
  messaging: { vapidPublicKey: 'public-vapid', secret: 'forbidden' },
  admin: { username: 'root', passwordHash: 'forbidden' },
  system: { masterKeyHash: 'forbidden' },
  openai: { apiKey: 'forbidden' },
  turn: { username: 'forbidden', credential: 'forbidden' },
  aiProxyAuth: 'forbidden',
  aiProxyUrl: 'https://attacker.invalid/proxy'
});
assert.deepEqual(JSON.parse(JSON.stringify(clean)), {
  firebase: { apiKey: 'public-firebase-key', projectId: 'liber-apps-cca20', functionsRegion: 'us-central1' },
  messaging: { vapidPublicKey: 'public-vapid' }
});

assert.doesNotMatch(email, /api\.mailgun\.net|Authorization': `Basic|getMailgunConfig\(\)/);
assert.doesNotMatch(secureKeys, /FALLBACK_PASSWORD_|const adminPassword = 'admin'|keys\.admin|keys\.system/);
assert.match(secureKeys, /Admin authentication is Firebase-only/);
assert.match(secureKeys, /Provider credentials, admin passwords and master keys are server-only/);

assert.doesNotMatch(chat, /getDownloadURL\(|openrelayproject|keys\.turn|turnFunctionUrl/);
assert.match(chat, /getIdToken\(true\)/);
assert.match(chat, /return this\._forceRelay \? \[\] : \[ \{ urls: baseStun \} \]/);

for (const source of [wallt, revexWallt]) {
  assert.doesNotMatch(source, /keys\?\.openai\?\.apiKey|keys\?\.aiProxyAuth|keys\?\.aiProxyUrl/);
  assert.match(source, /getIdToken\(\)/);
}
assert.doesNotMatch(assistant, /keys\.openai\.apiKey|keys && keys\.aiProxyUrl|X-Proxy-Auth/);
assert.match(assistant, /mergedHeaders\.Authorization = `Bearer \$\{token\}`/);

console.log(JSON.stringify({
  schema: 'liber.revex.security-boundaries.v1',
  status: 'PASSED',
  browserProviderSecrets: false,
  browserAdminCredentials: false,
  configurableTokenExfiltrationEndpoint: false,
  authenticatedAiProxy: true,
  ephemeralTurnOnly: true,
  permanentStorageDownloadTokensForNewChatMedia: false
}));
