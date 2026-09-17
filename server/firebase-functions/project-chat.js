'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { createHash } = require('node:crypto');
const { projectAccessRole } = require('./project-access');

if (!getApps().length) initializeApp();
const db = getFirestore();
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const SOURCE_RE = /^[0-9a-f]{40}$/i;
const CHAT_SCHEMA = 'liber.revex.project-chat.v1';
const BUILD = '20260820-project-chat7-live-membership';
const SOURCE_CANDIDATE = String(process.env.REVEX_SOURCE_CANDIDATE || '').trim();
const CHAT_IDENTITY_SCHEMA = 'liber.secure-chat.identity-p256.v2';
const CHAT_IDENTITY_ROTATION_SCHEMA = 'liber.secure-chat.identity-rotation.v1';
const RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60;
const IDENTITY_ROTATION_COOLDOWN_MS = 60 * 1000;
const PUBLIC_KEY_HISTORY_LIMIT = 8;
const FINGERPRINT_LINEAGE_LIMIT = 16;
const FCM_TOKEN_LIMIT_PER_USER = 10;
const FCM_RECIPIENT_LIMIT = 200;
const FCM_BATCH_LIMIT = 500;
const CHAT_PUSH_RECEIPT_SCHEMA = 'liber.secure-chat.push-receipt.v1';

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

async function authenticatedToken(req, options = {}) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw fail(401, 'unauthenticated', 'Sign in to LIBER Apps before using this service.');
  try {
    const decoded = await getAuth().verifyIdToken(match[1], options?.checkRevoked === true);
    const uid = String(decoded?.uid || '').trim();
    if (!uid) throw new Error('token has no uid');
    return { ...decoded, uid };
  } catch (_) {
    throw fail(401, 'unauthenticated', 'The LIBER Apps authorization token is invalid or expired.');
  }
}

async function authenticatedUid(req) {
  return (await authenticatedToken(req)).uid;
}

function requireRecentAuth(decoded, nowSeconds = Math.floor(Date.now() / 1000)) {
  const provider = String(decoded?.firebase?.sign_in_provider || '').trim();
  const authTime = Number(decoded?.auth_time);
  const age = nowSeconds - authTime;
  if (provider === 'anonymous')
    throw fail(403, 'anonymous-auth-not-allowed', 'Anonymous sessions cannot rotate a Secure Chat identity.');
  if (!Number.isFinite(authTime) || age < -60 || age > RECENT_AUTH_MAX_AGE_SECONDS)
    throw fail(401, 'requires-recent-login', 'Re-authenticate before re-enrolling this Secure Chat device.');
  return authTime;
}

function decodeP256Coordinate(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(text) || text.includes('='))
    throw fail(400, 'invalid-public-key', 'Secure Chat requires an unpadded P-256 public key.');
  let bytes;
  try { bytes = Buffer.from(text, 'base64url'); }
  catch (_) { throw fail(400, 'invalid-public-key', 'Secure Chat public-key coordinates are invalid.'); }
  if (bytes.length !== 32)
    throw fail(400, 'invalid-public-key', 'Secure Chat public-key coordinates must be 256 bits.');
  return text;
}

function normalizeP256PublicJwk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kty !== 'EC' || value.crv !== 'P-256' || value.d != null)
    throw fail(400, 'invalid-public-key', 'Secure Chat recovery accepts only a public P-256 JWK.');
  return {
    key_ops: [],
    ext: true,
    kty: 'EC',
    x: decodeP256Coordinate(value.x),
    y: decodeP256Coordinate(value.y),
    crv: 'P-256'
  };
}

function identityFingerprint(publicJwk) {
  const jwk = normalizeP256PublicJwk(publicJwk);
  const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function cleanFingerprint(value, label = 'fingerprint') {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw fail(400, 'invalid-argument', `${label} is invalid.`);
  return text;
}

function validHistoryEntry(value) {
  try {
    const publicJwk = normalizeP256PublicJwk(value?.publicJwk);
    const fingerprint = identityFingerprint(publicJwk);
    if (value?.fingerprint && cleanFingerprint(value.fingerprint) !== fingerprint) return null;
    return {
      fingerprint,
      publicJwk,
      retiredAt: String(value?.retiredAt || '').slice(0, 40) || null
    };
  } catch (_) {
    return null;
  }
}

function cleanFcmToken(value) {
  const token = String(value || '').trim();
  if (token.length < 20 || token.length > 4096 || !/^[A-Za-z0-9:_-]+$/.test(token))
    throw fail(400, 'invalid-fcm-token', 'The push registration token is invalid.');
  return token;
}

function cleanDeviceId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || null;
}

async function loadProjectAccess(projectId, uid, authClaims = {}) {
  const projectRef = db.doc(`projects/${projectId}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) throw fail(404, 'not-found', 'REVEX project not found.');
  const project = projectSnap.data() || {};
  const role = projectAccessRole(project, authClaims, uid);
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

function canonicalProjectChatBinding(data, projectId) {
  return Boolean(data &&
    data.schema === CHAT_SCHEMA &&
    data.source === 'revex-project-chat' &&
    String(data.projectId || '').trim() === projectId &&
    data.type === 'project');
}

function exactProjectChatParticipants(data, participants) {
  return Array.isArray(data?.participants) && Array.isArray(data?.memberIds) &&
    sameArray(data.participants, participants) && sameArray(data.memberIds, participants);
}

function controllerOwnsProjectChat(project, connId, data, projectId) {
  return String(project?.chatConnId || '').trim() === connId &&
    String(project?.chatProjectSchema || '').trim() === CHAT_SCHEMA &&
    canonicalProjectChatBinding(data, projectId);
}

function eligibleProjectChatCandidate(project, connId, data, projectId, participants) {
  if (!canonicalProjectChatBinding(data, projectId)) return false;
  // A previously controller-bound room may have stale participants precisely so
  // ensureProjectChat can reconcile a legitimate project membership change.
  // Any legacy/unlinked candidate must already match both normalized arrays.
  return controllerOwnsProjectChat(project, connId, data, projectId) ||
    exactProjectChatParticipants(data, participants);
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

async function resolveExistingChat(projectId, project, participants) {
  const linked = String(project.chatConnId || '').trim();
  if (linked) {
    const ref = db.doc(`chatConnections/${linked}`);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (!eligibleProjectChatCandidate(project, ref.id, data, projectId, participants))
        throw fail(409, 'project-chat-link-rejected', 'The linked Secure Chat room is not an exact controller-owned Project Chat binding. It was not adopted or modified.');
      return { ref, snap, data, linked: true };
    }
  }

  const query = await db.collection('chatConnections').where('projectId', '==', projectId).limit(10).get();
  // A user-created group must not become the project's private room merely by
  // writing a known projectId. Only rooms previously bound by this controller
  // are eligible for query-based recovery; explicit legacy links are handled above.
  const candidate = newest(query.docs
    .map((doc) => ({ ref: doc.ref, snap: doc, data: doc.data() || {} }))
    .filter((row) => eligibleProjectChatCandidate(project, row.ref.id, row.data, projectId, participants)));
  if (candidate) return { ...candidate, linked: false };

  const ref = db.doc(`chatConnections/${projectChatId(projectId)}`);
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() || {};
    if (!eligibleProjectChatCandidate(project, ref.id, data, projectId, participants))
      throw fail(409, 'project-chat-id-conflict', 'The deterministic Project Chat identifier is occupied by a noncanonical or participant-mismatched room. It was not adopted or modified.');
    return { ref, snap, data, linked: false };
  }
  return { ref, snap, data: {}, linked: false };
}

async function ensureProjectChat(projectId, uid, authClaims = {}) {
  if (!SOURCE_RE.test(SOURCE_CANDIDATE))
    throw fail(503, 'failed-precondition', 'REVEX Project Chat is not bound to an exact release source.');
  const access = await loadProjectAccess(projectId, uid, authClaims);
  // Project Chat is a project boundary. A platform-wide administrator may manage
  // project metadata through the project access service, but is never silently
  // enrolled in a private conversation.
  const participants = projectParticipants(access.project);
  if (!participants.length) throw fail(409, 'failed-precondition', 'REVEX project has no owner/member identities for Project Chat.');

  const selected = await resolveExistingChat(projectId, access.project, participants);
  const connId = selected.ref.id;

  // Membership and the controller-owned room binding are re-read in one
  // transaction. Firestore retries if a project ACL changes while reconciliation
  // is running, so a removed caller can never commit a stale participant list.
  return db.runTransaction(async (transaction) => {
    const projectSnap = await transaction.get(access.projectRef);
    if (!projectSnap.exists) throw fail(404, 'not-found', 'REVEX project not found.');
    const project = { id: projectSnap.id, ...(projectSnap.data() || {}) };
    const accessRole = projectAccessRole(project, authClaims, uid);
    if (!accessRole) throw fail(403, 'permission-denied', 'You no longer have access to this REVEX project.');
    const currentParticipants = projectParticipants(project);
    if (!currentParticipants.length)
      throw fail(409, 'failed-precondition', 'REVEX project has no owner/member identities for Project Chat.');

    const chatSnap = await transaction.get(selected.ref);
    const existing = chatSnap.exists ? (chatSnap.data() || {}) : {};
    const linked = String(project.chatConnId || '').trim();
    if (linked && linked !== connId)
      throw fail(409, 'project-chat-binding-changed', 'The Project Chat binding changed during reconciliation. Retry against the current project revision.');
    if (chatSnap.exists && !eligibleProjectChatCandidate(project, connId, existing, projectId, currentParticipants))
      throw fail(409, 'project-chat-link-rejected', 'The selected Secure Chat room no longer matches the exact controller-owned Project Chat binding. It was not modified.');
    if (!chatSnap.exists && linked && String(project.chatProjectSchema || '').trim() !== CHAT_SCHEMA)
      throw fail(409, 'project-chat-link-rejected', 'The linked Project Chat metadata is not controller-owned. It was not recreated.');

    const now = new Date().toISOString();
    const groupName = String(project.name || project.title || project.code || 'REVEX Project').trim().slice(0, 180) || 'REVEX Project';
    const chatAdmins = projectChatAdmins(project, currentParticipants);
    const created = !chatSnap.exists;
    const projectKey = `project:${projectId}`;
    const existingKey = String(existing.key || '').trim();
    // New REVEX project rooms use the project key. Existing Secure Chat rooms keep
    // the key under which their historical messages were created.
    const connectionKey = created ? projectKey : (existingKey || projectKey);
    const legacySalts = cryptoLegacySalts(existing, connId, projectKey);
    const membershipChanged = created ||
      !sameArray(existing.participants || existing.memberIds || [], currentParticipants) ||
      !sameArray(existing.memberIds || existing.participants || [], currentParticipants);
    const keyRotationRequired = membershipChanged || Boolean(existing.keyRotationRequired);
    const repaired = created ||
      linked !== connId ||
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
      participants: currentParticipants,
      memberIds: currentParticipants,
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

    transaction.set(selected.ref, chatPatch, { merge: true });
    transaction.set(access.projectRef, {
      chatConnId: connId,
      chatProjectSchema: CHAT_SCHEMA,
      chatSourceCandidate: SOURCE_CANDIDATE,
      chatUpdatedAt: now
    }, { merge: true });

    return {
      ok: true,
      schema: CHAT_SCHEMA,
      build: BUILD,
      sourceCandidate: SOURCE_CANDIDATE,
      projectId,
      connId,
      repaired,
      created,
      accessRole,
      participantCount: currentParticipants.length,
      cryptoLegacySaltCount: legacySalts.length,
      keyRotationRequired
    };
  });
}

async function markIdentityRotationForGroupChats(uid, fingerprint) {
  const snapshot = await db.collection('chatConnections')
    .where('participants', 'array-contains', uid)
    .limit(400)
    .get();
  const rows = snapshot.docs.filter((doc) => {
    const data = doc.data() || {};
    const participants = unique(data.participants || data.memberIds || []);
    return participants.length !== 2 || data.type === 'project' || Boolean(String(data.groupName || '').trim());
  });
  if (!rows.length) return { affectedGroupCount: 0, truncated: snapshot.size === 400 };
  const batch = db.batch();
  const now = new Date().toISOString();
  for (const doc of rows) {
    batch.set(doc.ref, {
      keyRotationRequired: true,
      keyRotationReason: 'participant-identity-rotation',
      keyRotationUid: uid,
      keyRotationFingerprint: fingerprint,
      updatedAt: now
    }, { merge: true });
  }
  await batch.commit();
  return { affectedGroupCount: rows.length, truncated: snapshot.size === 400 };
}

async function recoverSecureChatIdentity(uid, decoded, payload) {
  const authTime = requireRecentAuth(decoded);
  const expectedPublishedFingerprint = cleanFingerprint(payload?.expectedPublishedFingerprint, 'expectedPublishedFingerprint');
  const publicJwk = normalizeP256PublicJwk(payload?.publicJwk);
  const nextFingerprint = identityFingerprint(publicJwk);
  const identityRef = db.doc(`userPublicKeys/${uid}`);
  const auditRef = db.collection('secureChatIdentityRecoveryAudit').doc();
  const nowEpochMs = Date.now();
  const now = new Date(nowEpochMs).toISOString();

  const rotation = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(identityRef);
    if (!snapshot.exists)
      throw fail(409, 'identity-not-published', 'Open Secure Chat again so this account can publish its first identity.');
    const current = snapshot.data() || {};
    let currentPublicJwk;
    let currentFingerprint;
    try {
      currentPublicJwk = normalizeP256PublicJwk(current.publicJwk);
      currentFingerprint = identityFingerprint(currentPublicJwk);
    } catch (_) {
      throw fail(409, 'published-identity-invalid', 'The published Secure Chat identity is invalid and requires administrator review.');
    }
    if (expectedPublishedFingerprint !== currentFingerprint)
      throw fail(409, 'identity-changed', 'The published Secure Chat identity changed while recovery was pending. Reload and verify it before retrying.');

    if (currentFingerprint === nextFingerprint) {
      return { rotated: false, fromFingerprint: currentFingerprint, toFingerprint: nextFingerprint };
    }
    const lastRotationAt = Number(current?.rotation?.rotatedAtEpochMs || 0);
    if (lastRotationAt > 0 && nowEpochMs - lastRotationAt < IDENTITY_ROTATION_COOLDOWN_MS)
      throw fail(429, 'rotation-rate-limited', 'Secure Chat identity recovery was used recently. Wait one minute before another rotation.');

    const history = [];
    const seenHistory = new Set();
    const addHistory = (entry) => {
      const normalized = validHistoryEntry(entry);
      if (!normalized || seenHistory.has(normalized.fingerprint) || normalized.fingerprint === nextFingerprint) return;
      seenHistory.add(normalized.fingerprint);
      history.push(normalized);
    };
    addHistory({ fingerprint: currentFingerprint, publicJwk: currentPublicJwk, retiredAt: now });
    for (const entry of Array.isArray(current.publicKeyHistory) ? current.publicKeyHistory : []) addHistory(entry);

    const lineage = unique([
      currentFingerprint,
      ...(Array.isArray(current.fingerprintLineage) ? current.fingerprintLineage : [])
    ]).filter((fingerprint) => /^[0-9a-f]{64}$/i.test(fingerprint) && fingerprint !== nextFingerprint)
      .slice(0, FINGERPRINT_LINEAGE_LIMIT);
    const rotationRecord = {
      schema: CHAT_IDENTITY_ROTATION_SCHEMA,
      fromFingerprint: currentFingerprint,
      toFingerprint: nextFingerprint,
      rotatedAt: now,
      rotatedAtEpochMs: nowEpochMs,
      sourceBuild: BUILD,
      sourceCandidate: SOURCE_RE.test(SOURCE_CANDIDATE) ? SOURCE_CANDIDATE : null
    };
    transaction.set(identityRef, {
      uid,
      publicJwk,
      fingerprint: nextFingerprint,
      cryptoVersion: CHAT_IDENTITY_SCHEMA,
      publicKeyHistory: history.slice(0, PUBLIC_KEY_HISTORY_LIMIT),
      fingerprintLineage: lineage,
      rotation: rotationRecord,
      updatedAt: now
    }, { merge: true });
    transaction.set(auditRef, {
      schema: CHAT_IDENTITY_ROTATION_SCHEMA,
      uid,
      fromFingerprint: currentFingerprint,
      toFingerprint: nextFingerprint,
      authTime,
      rotatedAt: now,
      sourceBuild: BUILD,
      sourceCandidate: SOURCE_RE.test(SOURCE_CANDIDATE) ? SOURCE_CANDIDATE : null
    });
    return { rotated: true, fromFingerprint: currentFingerprint, toFingerprint: nextFingerprint };
  });

  const groups = await markIdentityRotationForGroupChats(uid, nextFingerprint);
  return {
    ok: true,
    schema: CHAT_IDENTITY_ROTATION_SCHEMA,
    build: BUILD,
    fingerprint: nextFingerprint,
    ...rotation,
    ...groups
  };
}

async function saveFcmToken(uid, payload) {
  const token = cleanFcmToken(payload?.token);
  const deviceId = cleanDeviceId(payload?.deviceId);
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const registrations = db.collection(`serverSecureState/${uid}/pushTokens`);
  const registrationRef = registrations.doc(tokenHash);
  const nowEpochMs = Date.now();
  const now = new Date(nowEpochMs).toISOString();
  await registrationRef.set({
    schema: 'liber.push-registration.fcm.v1',
    uid,
    token,
    tokenHash,
    deviceId,
    platform: 'web',
    updatedAt: now,
    updatedAtEpochMs: nowEpochMs,
    sourceBuild: BUILD
  }, { merge: true });

  // Bound registrations without ever copying the raw token onto the broadly used
  // user profile document. Server push workers can read this private subcollection.
  const live = await registrations.orderBy('updatedAtEpochMs', 'desc').limit(50).get();
  if (live.size > FCM_TOKEN_LIMIT_PER_USER) {
    const batch = db.batch();
    live.docs.slice(FCM_TOKEN_LIMIT_PER_USER).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  return {
    ok: true,
    schema: 'liber.push-registration.fcm.v1',
    build: BUILD,
    tokenHash,
    registrationCount: Math.min(live.size, FCM_TOKEN_LIMIT_PER_USER)
  };
}

function chatPushReceiptId(connId, messageId) {
  return createHash('sha256').update(`${connId}\u0000${messageId}`, 'utf8').digest('hex');
}

function notificationBody(message) {
  const hasAttachment = Boolean(message?.fileUrl || message?.fileName || (Array.isArray(message?.media) && message.media.length));
  return hasAttachment ? 'New encrypted attachment' : 'New encrypted message';
}

async function claimChatPush(connId, messageId) {
  const ref = db.doc(`serverSecureState/chatPushReceipts/deliveries/${chatPushReceiptId(connId, messageId)}`);
  const nowEpochMs = Date.now();
  const status = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const prior = snap.exists ? snap.data() || {} : {};
    if (prior.status === 'DELIVERED') return 'DELIVERED';
    const leaseAge = nowEpochMs - Number(prior.claimedAtEpochMs || 0);
    if (prior.status === 'CLAIMED' && leaseAge >= 0 && leaseAge < 5 * 60 * 1000) return 'ACTIVE';
    transaction.set(ref, {
      schema: CHAT_PUSH_RECEIPT_SCHEMA,
      connId,
      messageId,
      status: 'CLAIMED',
      claimedAt: new Date(nowEpochMs).toISOString(),
      claimedAtEpochMs: nowEpochMs,
      sourceBuild: BUILD
    }, { merge: true });
    return 'CLAIMED';
  });
  return { claimed: status === 'CLAIMED', active: status === 'ACTIVE', delivered: status === 'DELIVERED', ref };
}

async function loadPushRegistrations(recipientIds) {
  const registrations = [];
  for (let offset = 0; offset < recipientIds.length; offset += 20) {
    const slice = recipientIds.slice(offset, offset + 20);
    const snapshots = await Promise.all(slice.map((uid) => db.collection(`serverSecureState/${uid}/pushTokens`).limit(FCM_TOKEN_LIMIT_PER_USER).get()));
    snapshots.forEach((snapshot, index) => {
      const uid = slice[index];
      snapshot.docs.forEach((doc) => {
        const data = doc.data() || {};
        const token = String(data.token || '').trim();
        if (String(data.uid || '') === uid && token && createHash('sha256').update(token, 'utf8').digest('hex') === doc.id)
          registrations.push({ uid, token, ref: doc.ref });
      });
    });
  }
  return registrations;
}

async function dispatchChatPush(event) {
  const message = event.data?.data() || null;
  const connId = cleanId(event.params.connId, 'connId');
  const messageId = cleanId(event.params.messageId, 'messageId');
  if (!message) return null;
  if (String(message.connId || '') !== connId) throw new Error('Chat push message/connection identity mismatch.');
  const sender = cleanId(message.sender, 'sender');
  const connectionSnap = await db.doc(`chatConnections/${connId}`).get();
  if (!connectionSnap.exists) throw new Error('Chat push connection does not exist.');
  const participants = unique(connectionSnap.data()?.participants || []);
  if (!participants.includes(sender)) throw new Error('Chat push sender is not an explicit connection participant.');
  const recipientIds = participants.filter((uid) => uid !== sender).slice(0, FCM_RECIPIENT_LIMIT);
  const receipt = await claimChatPush(connId, messageId);
  if (receipt.active) throw new Error('Chat push delivery is already claimed; retry after the current lease resolves.');
  if (receipt.delivered) return null;
  try {
    const registrations = await loadPushRegistrations(recipientIds);
    let sent = 0;
    let failed = 0;
    const invalidRefs = [];
    for (let offset = 0; offset < registrations.length; offset += FCM_BATCH_LIMIT) {
      const chunk = registrations.slice(offset, offset + FCM_BATCH_LIMIT);
      const response = await getMessaging().sendEachForMulticast({
        tokens: chunk.map((row) => row.token),
        notification: { title: 'LIBER Secure Chat', body: notificationBody(message) },
        data: { type: 'secure-chat-message', connId, messageId, senderUid: sender },
        webpush: { fcmOptions: { link: 'https://liberpict.com/liber-apps/index.html#apps' } }
      });
      sent += response.successCount;
      failed += response.failureCount;
      response.responses.forEach((result, index) => {
        const code = String(result.error?.code || '');
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') invalidRefs.push(chunk[index].ref);
      });
    }
    for (let offset = 0; offset < invalidRefs.length; offset += 400) {
      const batch = db.batch();
      invalidRefs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await receipt.ref.set({
      status: 'DELIVERED', deliveredAt: new Date().toISOString(),
      recipients: recipientIds.length, registrations: registrations.length, sent, failed,
      invalidRegistrationsDeleted: invalidRefs.length
    }, { merge: true });
    return { sent, failed };
  } catch (error) {
    // Release the lease before surfacing the failure so Eventarc's retry can
    // reclaim this exact message without waiting five minutes or duplicating a
    // previously completed delivery.
    await receipt.ref.set({
      status: 'FAILED', failedAt: new Date().toISOString(),
      errorCode: String(error?.code || 'push-dispatch-failed').slice(0, 160)
    }, { merge: true }).catch(() => {});
    throw error;
  }
}

exports.onChatMessageWrite = onDocumentCreated({
  document: 'chatMessages/{connId}/messages/{messageId}',
  region: 'us-central1',
  timeoutSeconds: 60,
  memory: '256MiB',
  maxInstances: 10,
  retry: true
}, async (event) => {
  try { return await dispatchChatPush(event); }
  catch (error) {
    console.error('[SECURE CHAT PUSH]', JSON.stringify({
      at: new Date().toISOString(), build: BUILD,
      connId: event.params?.connId || null, messageId: event.params?.messageId || null,
      error: String(error?.message || error).slice(0, 2000)
    }));
    throw error;
  }
});

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
    const decoded = await authenticatedToken(req);
    const projectId = cleanId(req.body?.projectId, 'projectId');
    const result = await ensureProjectChat(projectId, decoded.uid, decoded);
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

exports.recoverSecureChatIdentityHttp = onRequest({
  region: ['us-central1', 'europe-west1'],
  cors: true,
  timeoutSeconds: 60,
  memory: '256MiB',
  concurrency: 40,
  maxInstances: 4
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw fail(405, 'method-not-allowed', 'Use POST for recoverSecureChatIdentityHttp.');
    const decoded = await authenticatedToken(req, { checkRevoked:true });
    const result = await recoverSecureChatIdentity(decoded.uid, decoded, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status || 500);
    const message = String(error?.message || 'Secure Chat identity recovery failed.').slice(0, 2000);
    console.error('[SECURE CHAT IDENTITY RECOVERY]', JSON.stringify({
      at: new Date().toISOString(), build: BUILD, status,
      code: error?.code || 'internal', message
    }));
    res.status(status).json({ ok: false, error: message, code: error?.code || 'internal', build: BUILD });
  }
});

exports.saveFcmTokenHttp = onRequest({
  region: ['us-central1', 'europe-west1'],
  cors: true,
  timeoutSeconds: 30,
  memory: '256MiB',
  concurrency: 80,
  maxInstances: 4
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw fail(405, 'method-not-allowed', 'Use POST for saveFcmTokenHttp.');
    const uid = await authenticatedUid(req);
    const result = await saveFcmToken(uid, req.body || {});
    res.status(200).json(result);
  } catch (error) {
    const status = Number(error?.status || 500);
    const message = String(error?.message || 'Push registration failed.').slice(0, 2000);
    console.error('[PUSH REGISTRATION]', JSON.stringify({
      at: new Date().toISOString(), build: BUILD, status,
      code: error?.code || 'internal', message
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
  projectChatId,
  canonicalProjectChatBinding,
  exactProjectChatParticipants,
  controllerOwnsProjectChat,
  eligibleProjectChatCandidate,
  requireRecentAuth,
  normalizeP256PublicJwk,
  identityFingerprint,
  cleanFingerprint,
  validHistoryEntry,
  cleanFcmToken,
  cleanDeviceId,
  chatPushReceiptId,
  notificationBody
});
