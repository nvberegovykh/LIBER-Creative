"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Stripe = require("stripe");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createService, VERSION } = require("../core");
const { createIdentity } = require("../identity");
let app, db, service;
const consent = { consent: true, consentVersion: VERSION };
before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "Isolated emulator required");
  app = initializeApp({ projectId: "demo-jericho-identity" });
  db = getFirestore(app, "jericho");
  service = createService(db);
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
});
after(async () => {
  if (db) await db.terminate();
  if (app) await deleteApp(app);
});

async function fixture() {
  const uid = crypto.randomUUID();
  await service.updateProfile(uid, {
    displayName: "Synthetic provider test",
    community: "Tests",
    avatar: 1,
    adult: true,
    ...consent,
  });
  const sessions = new Map(),
    retrieves = [],
    creates = [],
    redactions = [];
  const secret = "whsec_" + crypto.randomBytes(24).toString("hex");
  const signing = new Stripe("sk_test_synthetic_not_a_credential");
  const stripe = {
    webhooks: signing.webhooks,
    identity: {
      verificationSessions: {
        async create(params, options) {
          creates.push({ params, options });
          const previous = [...sessions.values()].find(
            (s) => s.metadata.attempt === params.metadata.attempt,
          );
          if (previous) return structuredClone(previous);
          const session = {
            id: "vs_" + crypto.randomBytes(12).toString("hex"),
            livemode: true,
            status: "requires_input",
            url: "https://verify.stripe.com/synthetic",
            ...params,
          };
          sessions.set(session.id, session);
          return structuredClone(session);
        },
        async retrieve(sessionId, params) {
          retrieves.push({ sessionId, params });
          const source = sessions.get(sessionId);
          assert.ok(source, "Only fixture sessions may be retrieved");
          const s = structuredClone(source);
          if (
            !params?.expand?.includes("verified_outputs.dob") &&
            s.verified_outputs
          )
            delete s.verified_outputs.dob;
          return s;
        },
        async redact(sessionId) {
          redactions.push(sessionId);
          const s = sessions.get(sessionId);
          s.redaction = { status: "redacted" };
          s.metadata = {};
          s.verified_outputs = {};
          return structuredClone(s);
        },
      },
    },
  };
  const account = { emailVerified: true, disabled: false };
  const identity = createIdentity({
    db,
    service,
    stripe,
    webhookKey: secret,
    auth: { getUser: async () => account },
  });
  function event(sessionId, extra = {}) {
    const payload = JSON.stringify({
      id: "evt_" + crypto.randomUUID(),
      livemode: true,
      type: "identity.verification_session.verified",
      data: { object: { id: sessionId } },
      ...extra,
    });
    return {
      raw: Buffer.from(payload),
      signature: signing.webhooks.generateTestHeaderString({ payload, secret }),
    };
  }
  async function verified() {
    const result = await identity.start(uid, consent);
    const s = [...sessions.values()][0];
    s.status = "verified";
    s.verified_outputs = {
      first_name: "Synthetic",
      last_name: "Adult",
      dob: { year: 1980, month: 1, day: 2 },
    };
    return { s, result };
  }
  return {
    uid,
    identity,
    account,
    sessions,
    creates,
    retrieves,
    redactions,
    event,
    verified,
  };
}

test("full signed provider flow requests DOB explicitly and issues once", async () => {
  const f = await fixture(),
    { s } = await f.verified();
  assert.equal(
    f.creates[0].params.options.document.require_matching_selfie,
    true,
  );
  const e = f.event(s.id);
  await f.identity.receive(e.raw, e.signature);
  const issued = await service.own(f.uid);
  assert.match(issued.japId, /^\d{27}$/);
  assert.equal(issued.legalIdentity.dateOfBirth, "1980-01-02");
  assert.ok(
    f.retrieves.some((r) => r.params?.expand?.includes("verified_outputs.dob")),
  );
  f.retrieves.length = 0;
  await f.identity.receive(e.raw, e.signature);
  assert.equal((await service.own(f.uid)).expiresAt, issued.expiresAt);
  assert.equal(
    f.retrieves.some((r) => r.params?.expand),
    false,
    "Replays do not request expired detailed results",
  );
  assert.equal((await service.lookup(issued.japId)).legalIdentity, undefined);
});

test("invalid signatures, test events, account suspension and session substitution cannot issue", async () => {
  const f = await fixture(),
    { s } = await f.verified();
  const e = f.event(s.id);
  await assert.rejects(f.identity.receive(e.raw, "invalid"), /signature/);
  const testEvent = f.event(s.id, { livemode: false });
  await f.identity.receive(testEvent.raw, testEvent.signature);
  assert.equal((await service.own(f.uid)).japId, null);
  f.account.disabled = true;
  await assert.rejects(f.identity.receive(e.raw, e.signature), /eligible/);
  f.account.disabled = false;
  s.metadata.attempt = "different-attempt";
  await assert.rejects(f.identity.receive(e.raw, e.signature), /binding/);
  assert.equal((await service.own(f.uid)).japId, null);
});

test("retry reuses session; cancellation creates a new bound attempt", async () => {
  const f = await fixture();
  const first = await f.identity.start(f.uid, consent);
  await f.identity.start(f.uid, consent);
  assert.equal(f.creates.length, 1);
  const s = [...f.sessions.values()][0];
  s.status = "canceled";
  await f.identity.reconcile(s.id);
  await f.identity.start(f.uid, consent);
  assert.equal(f.creates.length, 2);
  assert.notEqual(
    f.creates[0].options.idempotencyKey,
    f.creates[1].options.idempotencyKey,
  );
  assert.equal(first.profile.japId, null);
});

test("redaction with erased metadata still revokes both public references", async () => {
  const f = await fixture(),
    { s } = await f.verified();
  await f.identity.reconcile(s.id);
  const m = await service.own(f.uid);
  s.redaction = { status: "redacted" };
  s.metadata = {};
  s.verified_outputs = {};
  const e = f.event(s.id, { type: "identity.verification_session.redacted" });
  await f.identity.receive(e.raw, e.signature);
  assert.equal((await service.lookup(m.japId)).status, "revoked");
  assert.equal((await service.lookup(m.profileRef)).status, "revoked");
  assert.equal((await service.getMember(f.uid)).legalIdentity, null);
});

test("closure redacts every attempt, including earlier canceled sessions", async () => {
  const f = await fixture();
  await f.identity.start(f.uid, consent);
  const old = [...f.sessions.values()][0];
  old.status = "canceled";
  await f.identity.reconcile(old.id);
  await f.identity.start(f.uid, consent);
  await service.closeProfile(f.uid);
  await f.identity.maintenance();
  assert.equal(f.redactions.length, 2);
  assert.equal(
    (await db.collection("providerSessions").where("uid", "==", f.uid).get())
      .size,
    0,
  );
  assert.equal((await service.getMember(f.uid)).kycStatus, "redacted");
});

test("underage and incomplete evidence cannot issue; test sessions cannot bind", async () => {
  const f = await fixture(),
    { s } = await f.verified();
  s.verified_outputs.dob = {
    year: new Date().getUTCFullYear() - 10,
    month: 1,
    day: 1,
  };
  await assert.rejects(f.identity.reconcile(s.id), /Adult/);
  delete s.verified_outputs.dob;
  await assert.rejects(f.identity.reconcile(s.id), /birth date/);
  s.livemode = false;
  await f.identity.reconcile(s.id);
  assert.equal((await service.own(f.uid)).japId, null);
});
