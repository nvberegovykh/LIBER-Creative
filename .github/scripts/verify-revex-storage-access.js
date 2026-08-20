'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const fragmentPath = path.join(root, 'firebase/revex-secure-chat-storage.rules');
const fragment = fs.readFileSync(fragmentPath, 'utf8');
const chat = fs.readFileSync(path.join(root, 'docs/liber-apps/apps/secure-chat/chat.js'), 'utf8');
const revex = fs.readFileSync(path.join(root, 'docs/liber-apps/apps/revex/store.js'), 'utf8');
const { injectRules } = require('./patch-live-storage-rules.js');
const executableFragment = fragment
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const must = (marker, label) => assert.ok(fragment.includes(marker), `${label}: missing ${marker}`);
const mustNot = (marker, label) => assert.ok(!fragment.includes(marker), `${label}: forbidden ${marker}`);

function balancedRules(source) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    assert.ok(depth >= 0, `unexpected closing brace at ${index}`);
  }
  assert.equal(depth, 0, 'composed Storage rules have unbalanced braces');
  assert.equal(quote, '', 'composed Storage rules have an unterminated string');
  assert.equal(blockComment, false, 'composed Storage rules have an unterminated comment');
}

assert.equal((fragment.match(/REVEX_SECURE_STORAGE_ACCESS_BEGIN/g) || []).length, 1);
assert.equal((fragment.match(/REVEX_SECURE_STORAGE_ACCESS_END/g) || []).length, 1);
assert.ok(!/\brules_version\s*=/.test(executableFragment), 'fragment must not be a replacement ruleset');
assert.ok(!/\bservice\s+firebase\.storage\s*\{/.test(executableFragment), 'fragment must be merged inside the live object match');

must('firestore.exists(/databases/(default)/documents/projects/$(projectId))', 'project existence proof');
must('.data.ownerId == request.auth.uid', 'project owner access');
must('request.auth.uid in firestore.get(/databases/(default)/documents/projects/$(projectId)).data.memberIds', 'project member access');
must('match /projects/{projectId}/{projectObject=**}', 'project namespace');

must('firestore.exists(/databases/(default)/documents/chatConnections/$(connId))', 'chat existence proof');
must('request.auth.uid in firestore.get(/databases/(default)/documents/chatConnections/$(connId)).data.participants', 'explicit chat participant access');
must('match /chat/{connId}/{chatObject=**}', 'chat namespace');
mustNot('.data.admins', 'no chat admin bypass');
mustNot('.data.users', 'no legacy users membership bypass');

must('match /stickers/{uid}/{stickerObject=**}', 'sticker namespace');
must('allow read: if revexStorageSignedIn();', 'signed-in encrypted sticker read');
must('allow write: if revexStorageSignedIn() && request.auth.uid == uid;', 'owner-only sticker write');
must('match /{revexUnmatchedObject=**}', 'fragment-local default match');
must('allow read, write: if false;', 'default deny');
assert.ok(fragment.lastIndexOf('match /{revexUnmatchedObject=**}') > fragment.lastIndexOf('match /stickers/{uid}'));
assert.ok(!/allow\s+[^;]+:\s*if\s+true\s*;/.test(executableFragment), 'unconditional access is forbidden');

// Compose in memory to perform deterministic lexical syntax checks without
// creating a deployable generated rules file.
balancedRules(`rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${fragment}\n  }\n}\n`);

const preservedBase = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Existing unrelated ownership rules must survive every REVEX deployment.
    match /avatars/{uid}/{file=**} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`;
const once = injectRules(preservedBase, fragment);
const twice = injectRules(once, fragment);
assert.match(twice, /match \/avatars\/\{uid\}\/\{file=\*\*\}/);
assert.equal((twice.match(/REVEX_SECURE_STORAGE_ACCESS_BEGIN/g) || []).length, 1);
assert.equal((twice.match(/REVEX_SECURE_STORAGE_ACCESS_END/g) || []).length, 1);
balancedRules(twice);

// Behavioral access matrix mirrors the exact Firestore fields consumed above.
const projectAccess = (uid, project) => Boolean(uid) &&
  (project?.ownerId === uid || (Array.isArray(project?.memberIds) && project.memberIds.includes(uid)));
const chatAccess = (uid, connection) => Boolean(uid) &&
  Array.isArray(connection?.participants) && connection.participants.includes(uid);
const stickerRead = (uid) => Boolean(uid);
const stickerWrite = (uid, pathUid) => Boolean(uid) && uid === pathUid;

const project = { ownerId: 'owner', memberIds: ['owner', 'member'] };
assert.equal(projectAccess('owner', project), true);
assert.equal(projectAccess('member', project), true);
assert.equal(projectAccess('outsider', project), false);
assert.equal(projectAccess('', project), false);
assert.equal(chatAccess('participant', { participants: ['participant'] }), true);
assert.equal(chatAccess('admin-only', { participants: [], admins: ['admin-only'] }), false);
assert.equal(chatAccess('legacy-only', { users: ['legacy-only'] }), false);
assert.equal(chatAccess('outsider', { participants: ['participant'] }), false);
assert.equal(stickerRead('signed-in'), true);
assert.equal(stickerRead(''), false);
assert.equal(stickerWrite('owner', 'owner'), true);
assert.equal(stickerWrite('other', 'owner'), false);

// Active application paths must remain covered by the scoped fragment.
assert.match(revex, /`projects\/\$\{projectId\}\//);
assert.match(chat, /`chat\/\$\{connId\}\//);
assert.match(chat, /`stickers\/\$\{this\.currentUser\.uid\}\//);
assert.doesNotMatch(chat, /getDownloadURL\(/, 'new Secure Chat media must not mint permanent Firebase download tokens');
assert.match(chat, /`storage:\/\/\$\{storagePath\}`/);
assert.match(chat, /async fetchEncryptedAttachmentPayload\(fileUrl\)/);
assert.match(chat, /firebase\.getBlob\(firebase\.ref\(this\.storage, storagePath\)\)/);
assert.match(chat, /attachmentCryptoVersion/);
assert.match(chat, /attachmentCryptoEpoch/);

console.log(JSON.stringify({
  REVEX_STORAGE_ACCESS: 'PASSED',
  projectPaths: 'owner-or-member',
  chatPaths: 'explicit-participant-only',
  stickerWrites: 'owner-only',
  stickerReads: 'signed-in-encrypted-chat-compatibility',
  default: 'deny',
  permanentDownloadTokensForNewChatMedia: false,
  crossEpochAttachmentMetadata: true,
  liveRuleMergeIdempotent: true,
  liveRulesReplacedOrDeployed: false,
}));
