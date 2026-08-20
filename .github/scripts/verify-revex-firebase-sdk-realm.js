#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const requireText = (source, marker, label) => {
  if (!source.includes(marker)) throw new Error(`${label} is missing: ${marker}`);
};
const rejectText = (source, marker, label) => {
  if (source.includes(marker)) throw new Error(`${label} still contains: ${marker}`);
};

const loader = read('docs/liber-apps/js/firebase-loader.js');
const service = read('docs/liber-apps/js/firebase-service.js');
const shell = read('docs/liber-apps/index.html');
const revex = read('docs/liber-apps/apps/revex/index.html');
const chat = read('docs/liber-apps/apps/secure-chat/index.html');
const projectTracker = read('docs/liber-apps/apps/project-tracker/index.html');
const projectTrackerApp = read('docs/liber-apps/apps/project-tracker/app.js');

for (const marker of [
  "'12.17.1'",
  "'12.17.0'",
  'window.__liberFirebaseSdkPromise',
  'function liberFirebaseLoader()',
  'getApps',
  'getApp'
]) requireText(loader, marker, 'Firebase loader');
rejectText(loader, "'12.1.0'", 'Firebase loader');
rejectText(loader, "'13.1.0'", 'Firebase loader');

requireText(service, "existingApps.find((candidate) => candidate?.name === '[DEFAULT]')", 'Firebase service');
requireText(service, '|| firebase.initializeApp(firebaseConfig)', 'Firebase service');

for (const document of [shell, revex]) {
  requireText(document, 'firebase-loader.js?v=20260820r147-release1', 'Firebase host document');
}
requireText(revex, 'firebase-service.js?v=20260820r147-release1', 'REVEX host document');
requireText(shell, "window.LIBER_APP_VERSION = '20260820r147-release1'", 'LIBER shell');
requireText(chat, 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js', 'Secure Chat import map');
requireText(chat, "window.LIBER_CHAT_VERSION = '20260820v56-firebase-realm'", 'Secure Chat cache boundary');
rejectText(shell, 'firebasejs/13.1.0/', 'LIBER shell diagnostics');
rejectText(shell, 'firebasejs/12.1.0/', 'LIBER shell diagnostics');

for (const [name, document] of [
  ['REVEX', revex],
  ['Secure Chat', chat],
  ['Project Tracker', projectTracker]
]) {
  if (document.includes('firebase-loader.js') && document.includes('firebase-service.js'))
    rejectText(document, 'chat-iframe-bridge.js', `${name} Firebase realm ownership`);
}
requireText(projectTrackerApp, 'if (window.firebaseService)', 'Project Tracker local Firebase owner');
requireText(projectTrackerApp, 'return window.firebaseService;', 'Project Tracker local Firebase owner');

for (const file of fs.readdirSync(path.join(root, 'docs/liber-apps/apps'), { withFileTypes: true })) {
  if (!file.isDirectory()) continue;
  const htmlPath = path.join(root, 'docs/liber-apps/apps', file.name, 'index.html');
  if (!fs.existsSync(htmlPath)) continue;
  const document = fs.readFileSync(htmlPath, 'utf8');
  if (document.includes('firebase-loader.js') && document.includes('firebase-service.js'))
    rejectText(document, 'chat-iframe-bridge.js', `${file.name} Firebase realm ownership`);
}

console.log(JSON.stringify({
  REVEX_FIREBASE_SDK_REALM: 'PASSED',
  sdk: '12.17.1',
  fallback: '12.17.0',
  singletonLoaderPerWindow: true,
  defaultAppReuse: true,
  secureChatVersionAligned: true,
  crossWindowSdkBridges: false
}));
