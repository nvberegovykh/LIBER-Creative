'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { projectAccessRole } = require('./project-access');

if (!getApps().length) initializeApp();
const db = getFirestore();
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const SOURCE_RE = /^[0-9a-f]{40}$/i;
const CHAT_SCHEMA = 'liber.revex.project-chat.v1';
const BUILD = '20260820-project-chat4';
const SOURCE_CANDIDATE = String(process.env.REVEX_SOURCE_CANDIDATE || '').trim();

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanId(value, label = 'projectId') {
  const text = String(value || '').trim();
  if (!PROJECT_ID_RE.test(text)) throw fail(400, 'invalid-argument', `${label} is invalid.`);
  return text;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function sameArray(a, b) {
  const left = unique(a).sort();
  const right = unique(b).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function participantSalt(values) {
  return unique(values).sort().join('|');
}

function cryptoLegacySalts(existing, connId, projectKey) {
  const parts = unique(existing.participants || existing.memberIds || []);
  const prior = [];
  for (const field of ['cryptoLegacySalts', 'legacyCryptoSalts', 'legacyKeySalts', 'keyHistory']) {
    const value = existing[field];
    if (Array.isArray(value)) prior.push(...value);
    else if (typeof value === 'string') prior.push(value);
  }
  const existingKey = String(existing.key || '').trim();
  const oldParticipantSalt = participantSalt(parts);
  return unique([
    ...prior,
    existingKey && existingKey !== projectKey ? existingKey : '',
    oldParticipantSalt,
    connId
  ]).slice(0, 64);
}

async function authenticatedUid(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw fail(401, 'unauthenticated', 'Sign in to LIBER Apps before opening Project Chat.');
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    const uid = String(decoded?.uid || '').trim();
    if (!uid) throw new Error('token has no uid');
    return uid;
  } catch (_) {
    throw fail(401, 'unauthenticated', 'The Project Chat authorization token is invalid or expired.');
  }
}

async function loadProjectAccess(projectId, uid) {
  const projectRef = db.doc(`projects/${projectId}`);
  const [projectSnap, userSnap] = await Promise.all([
    projectRef.get(),
    db.doc(`users/${uid}`).get()
  ]);
  if (!projectSnap.exists) throw fail(404, 'not-found', 'REVEX project not found.');
  const project = projectSnap.data() || {};
  const user = userSnap.exists ? userSnap.data() || {} : {};
  const role = projectAccessRole(project, user, uid);
  if (!role) throw fail(403, 'permission-denied', 'You do not have access to this REVEX project.');
  return { projectRef, project: { id: projectSnap.id, ...project }, role };
}

function projectParticipants(project) {
  return unique([
    project.ownerId,
    ...(Array.isArray(project.memberIds) ? project.memberIds : [])
  ]);
}

function projectChatAdmins(project, participants) {
  const allowed = new Set(participants || []);
  return unique([
    project.ownerId,
    ...(Array.isArray(project.chatAdminIds) ? project.chatAdminIds : [])
  ]).filter((uid) => allowed.has(uid));
}

function projectChatId(projectId) {
  return `revex_project_${projectId}`;
}

function newest(rows) {
  return [...rows].sort((a, b) => {
    const time = (row) => {
      const value = row?.data?.updatedAt;
      if (value?.toMillis) return value.toMillis();
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    if (Boolean(a.data?.archived) !== Boolean(b.data?.archived)) return a.data?.archived ? 1 : -1;
    return time(b) - time(a);
  })[0] || null;
}

async function resolveExistingChat(projectId, project) {
  const linked = String(project.chatConnId || '').trim();
  if (linked) {
    const ref = db.doc(`chatConnections/${linked}`);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      const linkedProject = String(data.projectId || '').trim();
      // Preserve an explicitly linked room and its messages, but never rewrite away
      // its Secure Chat crypto lineage. ensureProjectChat stores project identity separately.
      if (!linkedProject || linkedProject === projectId) return { ref, snap, data, linked: true };
    }
  }

  const query = await db.collection('chatConnections').where('projectId', '==', projectId).limit(10).get();
  // A user-created group must not become the project's private room merely by
  // writing a known projectId. Only rooms previously bound by this controller
  // are eligible for query-based recovery; explicit legacy links are handled above.
  const candidate = newest(query.docs
    .map((doc) => ({ ref: doc.ref, snap: doc, data: doc.data() || {} }))
    .filter((row) => row.data.schema === CHAT_SCHEMA && row.data.source === 'revex-project-chat'));
  if (candidate) return { ...candidate, linked: false };

  const ref = db.doc(`chatConnections/${projectChatId(projectId)}`);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() || {};
    const linkedProject = String(data.projectId || '').trim();
    if (linkedProject && linkedProject !== projectId)
      throw fail(409, 'conflict', 'The deterministic Project Chat identifier is already bound to another project.');
    return { ref, snap, data, linked: false };
  }
  return { ref, snap, data: {}, linked: false };
}

async function ensureProjectChat(projectId, uid) {
  if (!SOURCE_RE.test(SOURCE_CANDIDATE))
    throw fail(503, 'failed-precondition', 'REVEX Project Chat is not bound to an exact release source.');
  const access = await loadProjectAccess(projectId, uid);
  // Project Chat is a project boundary. A platform-wide administrator may manage
  // project metadata through the project access service, but is never silently
  // enrolled in a private conversation.
  const participants = projectParticipants(access.project);
  if (!participants.length) throw fail(409, 'failed-precondition', 'REVEX project has no owner/member identities for Project Chat.');

  const selected = await resolveExistingChat(projectId, access.project);
  const connId = selected.ref.id;
  const existing = selected.data || {};
  const now = new Date().toISOString();
  const groupName = String(access.project.name || access.project.title || access.project.code || 'REVEX Project').trim().slice(0, 180) || 'REVEX Project';
  const chatAdmins = projectChatAdmins(access.project, participants);
  const created = !selected.snap.exists;
  const projectKey = `project:${projectId}`;
  const existingKey = String(existing.key || '').trim();
  // New REVEX project rooms use the project key. Existing Secure Chat rooms keep the
  // key under which their historical messages were created; project identity is separate.
  const connectionKey = created ? projectKey : (existingKey || projectKey);
  const legacySalts = cryptoLegacySalts(existing, connId, projectKey);
  const membershipChanged = created ||
    !sameArray(existing.participants || existing.memberIds || [], participants) ||
    !sameArray(existing.memberIds || existing.participants || [], participants);
  // The browser must generate and wrap a fresh random content key for every
  // current participant before it can send into a new or membership-changed room.
  const keyRotationRequired = membershipChanged || Boolean(existing.keyRotationRequired);
  const repaired = created ||
    String(access.project.chatConnId || '') !== connId ||
    String(existing.projectId || '') !== projectId ||
    String(existing.type || '') !== 'project' ||
    String(existing.projectKey || '') !== projectKey ||
    String(existing.groupName || '') !== groupName ||
    Boolean(existing.archived) ||
    membershipChanged ||
    !sameArray(existing.admins || [], chatAdmins) ||
    !sameArray(existing.cryptoLegacySalts || [], legacySalts) ||
    String(existing.sourceCandidate || '') !== SOURCE_CANDIDATE;

  const chatPatch = {
    schema: CHAT_SCHEMA,
    projectId,
    type: 'project',
    key: connectionKey,
    projectKey,
    cryptoLegacySalts: legacySalts,
    groupName,
    participants,
    memberIds: participants,
    admins: chatAdmins,
    keyRotationRequired,
    archived: false,
    source: 'revex-project-chat',
    sourceBuild: BUILD,
    sourceCandidate: SOURCE_CANDIDATE,
    updatedAt: now
  };
  if (created) {
    chatPatch.createdAt = now;
    chatPatch.lastMessage = '';
    chatPatch.participantUsernames = [];
  }

  const batch = db.batch();
  batch.set(selected.ref, chatPatch, { merge: true });
  batch.set(access.projectRef, {
    chatConnId: connId,
    chatProjectSchema: CHAT_SCHEMA,
    chatSourceCandidate: SOURCE_CANDIDATE,
    chatUpdatedAt: now
  }, { merge: true });
  await batch.commit();

  return {
    ok: true,
    schema: CHAT_SCHEMA,
    build: BUILD,
    sourceCandidate: SOURCE_CANDIDATE,
    projectId,
    connId,
    repaired,
    created,
    accessRole: access.role,
    participantCount: participants.length,
    cryptoLegacySaltCount: legacySalts.length,
    keyRotationRequired
  };
}

exports.ensureProjectChatHttp = onRequest({
  region: ['us-central1', 'europe-west1'],
  cors: true,
  timeoutSeconds: 60,
  memory: '256MiB',
  concurrency: 40,
  maxInstances: 4
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw fail(405, 'method-not-allowed', 'Use POST for ensureProjectChatHttp.');
    const uid = await authenticatedUid(req);
    const projectId = cleanId(req.body?.projectId, 'projectId');
    const result = await ensureProjectChat(projectId, uid);
    res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status || 500);
    const message = String(error?.message || 'REVEX Project Chat connection failed.').slice(0, 2000);
    console.error('[REVEX PROJECT CHAT]', JSON.stringify({
      at: new Date().toISOString(),
      build: BUILD,
      sourceCandidate: SOURCE_CANDIDATE || null,
      status,
      code: error?.code || 'internal',
      message
    }));
    res.status(status).json({ ok: false, error: message, code: error?.code || 'internal', build: BUILD });
  }
});

module.exports._test = Object.freeze({
  cleanId,
  unique,
  sameArray,
  participantSalt,
  cryptoLegacySalts,
  projectParticipants,
  projectChatAdmins,
  projectChatId
});
