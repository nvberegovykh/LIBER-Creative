'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { newJapId, validJapId, publicProfile, issueCredential } = require('./jericho-core');

function memoryDatabase(member) {
  const records = new Map([['members/user', structuredClone(member)]]);
  let queue = Promise.resolve();
  const db = {
    collection: name => ({ doc: id => `${name}/${id}` }),
    runTransaction(fn) {
      const operation = queue.then(async () => {
        const draft = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
        const tx = {
          get: async key => ({ exists: draft.has(key), data: () => draft.get(key) }),
          create(key, value) { assert(!draft.has(key)); draft.set(key, value); },
          update(key, value) { assert(draft.has(key)); draft.set(key, { ...draft.get(key), ...value }); }
        };
        const result = await fn(tx);
        records.clear();
        for (const [key, value] of draft) records.set(key, value);
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
  return { db, records };
}

test('27-digit references retain leading zeroes and reject coercion and reserved specimen', () => {
  assert(validJapId('012345678901234567890123456'));
  assert(!validJapId('0'.repeat(27)));
  assert(!validJapId(123456789012345678901234567));
  assert(!validJapId('1'.repeat(26)));
  const ids = new Set(Array.from({ length: 1000 }, newJapId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert(validJapId(id));
});
test('public projection excludes sensitive and ownership fields and expires credentials', () => {
  const record = { japId: '1'.repeat(27), issuedAt: 100, expiresAt: 200, name: 'Private', uid: 'user', sessionId: 'vs_private', dob: 'private' };
  assert.equal(publicProfile(record, 199).status, 'active');
  assert.equal(publicProfile(record, 200).status, 'expired');
  assert.equal(publicProfile({ ...record, revokedAt: 150 }, 160).status, 'revoked');
  assert.deepEqual(Object.keys(publicProfile(record)).sort(), ['expiresAt','issuedAt','issuer','japId','status','type'].sort());
});
test('concurrent duplicate verified events issue one credential and one token job', async () => {
  const { db, records } = memoryDatabase({ sessionId: 'vs_1', tokenConsent: true });
  const ids = await Promise.all(Array.from({ length: 20 }, () => issueCredential(db, 'user', 'vs_1', 1000)));
  assert.equal(new Set(ids).size, 1);
  assert.equal([...records.keys()].filter(key => key.startsWith('references/')).length, 1);
  assert.equal(records.get('tokenJobs/user').state, 'blocked-network-configuration');
  assert.equal(records.get('tokenJobs/user').metadata.japId, undefined);
});
test('mismatched sessions and revoked members cannot issue', async () => {
  const mismatch = memoryDatabase({ sessionId: 'vs_real' });
  await assert.rejects(issueCredential(mismatch.db, 'user', 'vs_fake'));
  assert.equal(mismatch.records.size, 1);
  const revoked = memoryDatabase({ sessionId: 'vs_1', revokedAt: 123 });
  await assert.rejects(issueCredential(revoked.db, 'user', 'vs_1'));
  assert.equal(revoked.records.size, 1);
});
test('NFT outbox requires separate consent', async () => {
  const { db, records } = memoryDatabase({ sessionId: 'vs_1', tokenConsent: false });
  await issueCredential(db, 'user', 'vs_1');
  assert(!records.has('tokenJobs/user'));
});
