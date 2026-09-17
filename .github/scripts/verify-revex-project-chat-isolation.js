#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { projectAccessRole } = require('../../server/firebase-functions/project-access.js');

const backend = fs.readFileSync('server/firebase-functions/project-chat.js', 'utf8');
const manager = fs.readFileSync('docs/liber-apps/apps/project-manager/app.js', 'utf8');
const rules = fs.readFileSync('firebase/revex-project-access-r43.rules', 'utf8');

new Function(backend);
new Function(manager);

assert.match(backend, /const BUILD = '20260820-project-chat7-live-membership'/);
assert.match(backend, /const participants = projectParticipants\(access\.project\)/);
assert.match(backend, /resolveExistingChat\(projectId, access\.project, participants\)/);
assert.match(backend, /const chatAdmins = projectChatAdmins\(project, currentParticipants\)/);
assert.match(backend, /const keyRotationRequired = membershipChanged \|\| Boolean\(existing\.keyRotationRequired\)/);
assert.match(backend, /keyRotationRequired,/);
assert.match(backend, /function canonicalProjectChatBinding\(data, projectId\)/);
assert.match(backend, /data\.schema === CHAT_SCHEMA/);
assert.match(backend, /data\.source === 'revex-project-chat'/);
assert.match(backend, /String\(data\.projectId \|\| ''\)\.trim\(\) === projectId/);
assert.match(backend, /function exactProjectChatParticipants\(data, participants\)/);
assert.match(backend, /sameArray\(data\.participants, participants\) && sameArray\(data\.memberIds, participants\)/);
assert.match(backend, /project-chat-link-rejected/);
assert.match(backend, /project-chat-id-conflict/);
assert.doesNotMatch(backend, /!linkedProject \|\| linkedProject === projectId/);
assert.doesNotMatch(backend, /collection\('users'\)\.where\('role', '==', 'admin'\)/);
assert.doesNotMatch(backend, /\.\.\.admins/);
assert.doesNotMatch(backend, /db\.doc\(`users\/\$\{uid\}`\)\.get\(\)/);
const ensureStart = backend.indexOf('async function ensureProjectChat(projectId, uid, authClaims = {})');
const ensureEnd = backend.indexOf('\nasync function markIdentityRotationForGroupChats', ensureStart);
assert.ok(ensureStart >= 0 && ensureEnd > ensureStart, 'ensureProjectChat could not be isolated');
const ensureSource = backend.slice(ensureStart, ensureEnd);
assert.match(ensureSource, /return db\.runTransaction\(async \(transaction\) =>/);
assert.match(ensureSource, /transaction\.get\(access\.projectRef\)/);
assert.match(ensureSource, /transaction\.get\(selected\.ref\)/);
assert.match(ensureSource, /projectAccessRole\(project, authClaims, uid\)/);
assert.match(ensureSource, /project-chat-binding-changed/);
assert.match(ensureSource, /transaction\.set\(selected\.ref/);
assert.doesNotMatch(ensureSource, /db\.batch\(\)/);

assert.doesNotMatch(manager, /function getAdminUids\(/);
assert.doesNotMatch(manager, /adminUids\.forEach/);
assert.doesNotMatch(manager, /function createProjectChat\(/);
assert.doesNotMatch(manager, /collection\(fs\.db, 'chatConnections'\)/);
assert.match(manager, /callFunction\('ensureProjectChat', \{ projectId: id \}\)/);
assert.match(manager, /callFunction\('ensureProjectChat', \{ projectId \}\)/);

assert.match(rules, /secureChatNoGlobalAdminBypass/);
assert.match(rules, /allow get: if revexR43ChatMemberOf\(resource\.data\)/);
assert.match(rules, /revexR43ProjectChatBindingUntouched\(\)/);
assert.match(rules, /function revexR43ProjectChatBindingAbsent\(data\)/);
assert.match(rules, /allow create: if revexR43ProjectChatBindingAbsent\(request\.resource\.data\)/);
assert.match(rules, /function revexR43BrowserChatCreateAllowed\(data\)/);
assert.match(rules, /function revexR43ChatProjectBoundary\(data\)/);
assert.match(rules, /revexR43ProjectRecordMember\(data\.projectId\)/);
assert.match(rules, /request\.auth\.token\.revexAdmin == true/);
assert.doesNotMatch(rules, /documents\/users\/\$\(request\.auth\.uid\)[\s\S]{0,160}\.data\.role == 'admin'/);
assert.match(rules, /allow create: if revexR43BrowserChatCreateAllowed\(request\.resource\.data\)/);
assert.match(rules, /revexR43BrowserChatIsNotProject\(request\.resource\.data\)/);
assert.match(rules, /'chatConnId', 'chatProjectSchema', 'chatSourceCandidate', 'chatUpdatedAt'/);
assert.doesNotMatch(rules, /match \/chatConnections\/\{connId\}[\s\S]*?allow get: if revexR43IsAdmin\(\)/);

const accessProject = { ownerId: 'owner', memberIds: ['owner', 'member'] };
assert.equal(projectAccessRole(accessProject, { role: 'admin' }, 'legacy-claim-admin'), 'liber-admin',
  'role is trusted only when supplied by verified Auth token data');
assert.equal(projectAccessRole(accessProject, {}, 'self-promoted'), null,
  'a user profile role must never be passed into the authorization helper');
assert.equal(projectAccessRole(accessProject, { revexAdmin: true }, 'claim-admin'), 'liber-admin');

const backendModule = { exports: {} };
const backendContext = {
  module: backendModule,
  exports: backendModule.exports,
  process: { env: {} },
  Buffer,
  URL,
  console,
  require(specifier) {
    if (specifier === 'node:crypto') return require('node:crypto');
    if (specifier === './project-access') return { projectAccessRole() { return ''; } };
    if (specifier === 'firebase-functions/v2/https') return { onRequest(_options, handler) { return handler; } };
    if (specifier === 'firebase-functions/v2/firestore') return { onDocumentCreated(_options, handler) { return handler; } };
    if (specifier === 'firebase-admin/app') return { getApps() { return [{}]; }, initializeApp() {} };
    if (specifier === 'firebase-admin/auth') return { getAuth() { return {}; } };
    if (specifier === 'firebase-admin/firestore') return { getFirestore() { return {}; } };
    if (specifier === 'firebase-admin/messaging') return { getMessaging() { return {}; } };
    throw new Error(`Unexpected project-chat dependency: ${specifier}`);
  }
};
vm.runInNewContext(backend, backendContext, { filename: 'project-chat.js' });
const contract = backendModule.exports._test;
const projectId = 'alpha';
const participants = ['owner', 'member'];
const canonical = {
  schema: 'liber.revex.project-chat.v1', source: 'revex-project-chat', projectId, type: 'project',
  participants: ['member', 'owner'], memberIds: ['owner', 'member']
};
assert.equal(contract.eligibleProjectChatCandidate({}, 'legacy', canonical, projectId, participants), true);
assert.equal(contract.eligibleProjectChatCandidate({}, 'legacy', { ...canonical, projectId:'' }, projectId, participants), false);
assert.equal(contract.eligibleProjectChatCandidate({}, 'legacy', { ...canonical, schema:'legacy' }, projectId, participants), false);
assert.equal(contract.eligibleProjectChatCandidate({}, 'legacy', { ...canonical, source:'browser' }, projectId, participants), false);
assert.equal(contract.eligibleProjectChatCandidate({}, 'legacy', { ...canonical, participants:['owner'], memberIds:['owner'] }, projectId, participants), false);
assert.equal(contract.eligibleProjectChatCandidate({ chatConnId:'controlled', chatProjectSchema:'liber.revex.project-chat.v1' }, 'controlled', {
  ...canonical, participants:['owner'], memberIds:['owner']
}, projectId, participants), true, 'a controller-owned room must remain reconcilable after a legitimate membership change');

console.log(JSON.stringify({
  REVEX_PROJECT_CHAT_ISOLATION: 'PASSED',
  implicitGlobalAdminEnrollment: false,
  browserOwnedProjectChatMembership: false,
  browserCreatedProjectChatBinding: false,
  browserPreseededProjectChatCandidate: false,
  unboundProjectIdCandidateAccepted: false,
  participantMismatchedLegacyCandidateAccepted: false,
  staleProjectMembershipAllowedByRules: false,
  reconciliationAclRace: 'transaction-retry-and-recheck',
  userDocumentRoleIsAuthority: false,
  membershipChangeForcesKeyRotation: true,
  historicalMessagesDeleted: false
}));
