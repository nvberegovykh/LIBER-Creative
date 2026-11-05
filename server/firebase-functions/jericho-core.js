'use strict';

const { randomInt, randomBytes } = require('node:crypto');
const ID_PATTERN = /^[0-9]{27}$/;
const RESERVED_ID = '0'.repeat(27);

function newJapId() {
  let id;
  do {
    id = Array.from({ length: 27 }, () => randomInt(10)).join('');
  } while (id === RESERVED_ID);
  return id;
}

function validJapId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) && value !== RESERVED_ID;
}

function publicProfile(record, now = Date.now()) {
  if (!record || !validJapId(record.japId)) return null;
  const expired = !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
  return {
    japId: record.japId,
    issuer: 'Jericho Alliance',
    type: 'private-community-membership',
    status: record.revokedAt ? 'revoked' : expired ? 'expired' : 'active',
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt
  };
}

// Called only after the server retrieves a verified provider session bound to uid.
// Firestore transactions reserve the reference and outbox together. Duplicate
// callbacks return the original credential, including across retries.
async function issueCredential(db, uid, sessionId, now = Date.now()) {
  const ownerRef = db.collection('members').doc(uid);
  for (let attempt = 0; attempt < 5; attempt++) {
    const japId = newJapId();
    const publicRef = db.collection('references').doc(japId);
    const jobRef = db.collection('tokenJobs').doc(uid);
    const result = await db.runTransaction(async tx => {
      const [owner, existing] = await Promise.all([tx.get(ownerRef), tx.get(publicRef)]);
      const member = owner.data();
      if (!member || member.sessionId !== sessionId) throw new Error('Session binding mismatch');
      if (member.revokedAt) throw new Error('Membership revoked');
      if (member.japId) return member.japId;
      if (existing.exists) return null;
      const credential = {
        japId, issuedAt: now, expiresAt: now + 365 * 86400000,
        revokedAt: null, avatarSeed: randomBytes(24).toString('hex')
      };
      tx.create(publicRef, { ...publicProfile(credential, now), revokedAt: null });
      tx.update(ownerRef, { ...credential, verificationStatus: 'verified' });
      if (member.tokenConsent === true) {
        tx.create(jobRef, {
          state: 'blocked-network-configuration', createdAt: now,
          assetSeed: credential.avatarSeed,
          // No names, document references, JAP IDs, or identity hashes in token metadata.
          metadata: { name: 'Jericho Alliance avatar', type: 'community-artwork' }
        });
      }
      return japId;
    });
    if (result) return result;
  }
  throw new Error('Unable to reserve reference');
}

module.exports = { newJapId, validJapId, publicProfile, issueCredential };
