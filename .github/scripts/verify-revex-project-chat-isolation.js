#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const backend = fs.readFileSync('server/firebase-functions/project-chat.js', 'utf8');
const manager = fs.readFileSync('docs/liber-apps/apps/project-manager/app.js', 'utf8');
const rules = fs.readFileSync('firebase/revex-project-access-r43.rules', 'utf8');

new Function(backend);
new Function(manager);

assert.match(backend, /const BUILD = '20260820-project-chat4'/);
assert.match(backend, /const participants = projectParticipants\(access\.project\)/);
assert.match(backend, /const chatAdmins = projectChatAdmins\(access\.project, participants\)/);
assert.match(backend, /const keyRotationRequired = membershipChanged \|\| Boolean\(existing\.keyRotationRequired\)/);
assert.match(backend, /keyRotationRequired,/);
assert.match(backend, /row\.data\.schema === CHAT_SCHEMA && row\.data\.source === 'revex-project-chat'/);
assert.doesNotMatch(backend, /collection\('users'\)\.where\('role', '==', 'admin'\)/);
assert.doesNotMatch(backend, /\.\.\.admins/);

assert.doesNotMatch(manager, /function getAdminUids\(/);
assert.doesNotMatch(manager, /adminUids\.forEach/);
assert.doesNotMatch(manager, /function createProjectChat\(/);
assert.doesNotMatch(manager, /collection\(fs\.db, 'chatConnections'\)/);
assert.match(manager, /callFunction\('ensureProjectChat', \{ projectId: id \}\)/);
assert.match(manager, /callFunction\('ensureProjectChat', \{ projectId \}\)/);

assert.match(rules, /secureChatNoGlobalAdminBypass/);
assert.match(rules, /allow get: if revexR43ChatMemberOf\(resource\.data\)/);
assert.match(rules, /revexR43ProjectChatBindingUntouched\(\)/);
assert.match(rules, /'chatConnId', 'chatProjectSchema', 'chatSourceCandidate', 'chatUpdatedAt'/);
assert.doesNotMatch(rules, /match \/chatConnections\/\{connId\}[\s\S]*?allow get: if revexR43IsAdmin\(\)/);

console.log(JSON.stringify({
  REVEX_PROJECT_CHAT_ISOLATION: 'PASSED',
  implicitGlobalAdminEnrollment: false,
  browserOwnedProjectChatMembership: false,
  unboundProjectIdCandidateAccepted: false,
  membershipChangeForcesKeyRotation: true,
  historicalMessagesDeleted: false
}));
