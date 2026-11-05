'use strict';

// Integration candidate. Keep disabled until the named database, provider,
// privacy program, App Check and end-to-end tests have been provisioned.
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');
const { randomBytes } = require('node:crypto');
const { issueCredential, validJapId, publicProfile } = require('./jericho-core');

if (!getApps().length) initializeApp();
const enabled = defineString('JERICHO_ENABLED', { default: 'false' });
const stripeKey = defineSecret('JERICHO_STRIPE_KEY');
const webhookKey = defineSecret('JERICHO_STRIPE_WEBHOOK_SECRET');
const db = getFirestore('jericho');
const callOptions = { region: 'us-central1', enforceAppCheck: true, maxInstances: 5 };

function requireUser(request) {
  if (enabled.value() !== 'true') throw new HttpsError('failed-precondition', 'JAP enrollment is not enabled.');
  if (!request.auth?.uid || request.auth.token.email_verified !== true)
    throw new HttpsError('unauthenticated', 'Use a verified LIBER account.');
  return request.auth.uid;
}

exports.jerichoStartVerification = onCall({ ...callOptions, secrets: [stripeKey] }, async request => {
  const uid = requireUser(request);
  if (request.data?.consentVersion !== '2026-11-05' || request.data?.adultConsent !== true)
    throw new HttpsError('invalid-argument', 'Adult enrollment and current privacy consent are required.');
  const stripe = new Stripe(stripeKey.value());
  const ref = db.collection('members').doc(uid);
  const member = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) return snap.data();
    const initial = {
      attemptId: randomBytes(24).toString('hex'), createdAt: Date.now(),
      consentVersion: '2026-11-05', tokenConsent: request.data.tokenConsent === true,
      verificationStatus: 'pending', sessionId: null
    };
    tx.create(ref, initial);
    return initial;
  });
  if (member.revokedAt) throw new HttpsError('failed-precondition', 'Membership has been revoked.');
  if (member.japId) return { japId: member.japId, status: member.verificationStatus };
  // Stable idempotency and the persisted attempt ID make a lost response retryable.
  const session = member.sessionId
    ? await stripe.identity.verificationSessions.retrieve(member.sessionId)
    : await stripe.identity.verificationSessions.create({
      type: 'document', metadata: { purpose: 'jericho-membership', attempt: member.attemptId },
      options: { document: { require_matching_selfie: true } },
      return_url: 'https://liberpict.com/jericho-alliance/sip/'
    }, { idempotencyKey: `jericho-${member.attemptId}` });
  await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current.revokedAt || current.attemptId !== member.attemptId)
      throw new HttpsError('failed-precondition', 'Enrollment changed.');
    tx.update(ref, { sessionId: session.id });
    tx.set(db.collection('providerSessions').doc(session.id), { uid, attemptId: member.attemptId });
  });
  return { url: session.url || null, status: session.status };
});

exports.jerichoStripeWebhook = onRequest({
  region: 'us-central1', secrets: [stripeKey, webhookKey], maxInstances: 5
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (enabled.value() !== 'true') return res.status(503).json({ error: 'disabled' });
  const stripe = new Stripe(stripeKey.value());
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), webhookKey.value());
  } catch (_) {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  if (!event.type.startsWith('identity.verification_session.')) return res.status(200).end();
  try {
    const session = await stripe.identity.verificationSessions.retrieve(event.data.object.id);
    const mapping = await db.collection('providerSessions').doc(session.id).get();
    // A webhook may arrive before the create-session request commits its mapping.
    // Return retryable failure instead of dropping that event.
    if (!mapping.exists) return res.status(503).json({ error: 'session_mapping_pending' });
    const { uid, attemptId } = mapping.data();
    if (session.metadata.purpose !== 'jericho-membership' || session.metadata.attempt !== attemptId)
      return res.status(400).json({ error: 'session_binding_mismatch' });
    // Test sessions never issue live credentials. Test issuance against an
    // isolated emulator using the core service and synthetic data.
    if (session.livemode !== true)
      return res.status(200).json({ received: true, testEventIgnored: true });
    if (session.status === 'verified' && event.type !== 'identity.verification_session.redacted') {
      await issueCredential(db, uid, session.id);
    } else {
      const ref = db.collection('members').doc(uid);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const member = snap.data();
        if (!member || member.sessionId !== session.id) throw new Error('Invalid member binding');
        const revoked = Boolean(session.redaction || session.status === 'canceled');
        const updates = { verificationStatus: session.status };
        if (revoked) updates.revokedAt = member.revokedAt || Date.now();
        tx.update(ref, updates);
        if (revoked && member.japId) {
          tx.update(db.collection('references').doc(member.japId), { revokedAt: updates.revokedAt });
          tx.set(db.collection('tokenJobs').doc(uid), { state: 'revoked' }, { merge: true });
        }
      });
    }
    return res.status(200).json({ received: true });
  } catch (_) {
    // Do not log event payloads or identity data. Stripe retries server failures.
    return res.status(503).json({ error: 'processing_retry_required' });
  }
});

exports.jerichoOwnProfile = onCall(callOptions, async request => {
  const uid = requireUser(request);
  const member = (await db.collection('members').doc(uid).get()).data();
  return {
    credential: publicProfile(member),
    verificationStatus: member?.verificationStatus || 'not-started',
    avatarSeed: member?.avatarSeed || null,
    nftStatus: member?.tokenConsent ? 'pending-network-configuration' : 'not-requested'
  };
});

exports.jerichoLookup = onCall(callOptions, async request => {
  if (enabled.value() !== 'true') throw new HttpsError('failed-precondition', 'Verification is unavailable.');
  const japId = request.data?.japId;
  if (!validJapId(japId)) throw new HttpsError('invalid-argument', 'A 27-digit reference is required.');
  const record = (await db.collection('references').doc(japId).get()).data();
  return { credential: publicProfile(record) };
});

exports.jerichoRevokeOwnProfile = onCall(callOptions, async request => {
  const uid = requireUser(request);
  const ref = db.collection('members').doc(uid);
  await db.runTransaction(async tx => {
    const member = (await tx.get(ref)).data();
    if (!member) return;
    const revokedAt = member.revokedAt || Date.now();
    tx.update(ref, { revokedAt });
    if (member.japId) tx.update(db.collection('references').doc(member.japId), { revokedAt });
    tx.set(db.collection('tokenJobs').doc(uid), { state: 'revoked' }, { merge: true });
  });
  return { revoked: true };
});
