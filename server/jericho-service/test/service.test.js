"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { createService, memberProjection, VERSION } = require("../core");
const projectId = "demo-jericho";
let app, db, service;
const profile = (extra = {}) => ({
  displayName: "Test Member",
  community: "Test community",
  avatar: 2,
  consent: true,
  adult: true,
  consentVersion: VERSION,
  publicListing: false,
  collectibleConsent: true,
  ...extra,
});
const setup = {
  title: "Shared garden",
  partyA: "Garden A",
  representativeA: "Member A",
  mandateA: "May agree to work schedule",
  partyB: "Garden B",
  representativeB: "Member B",
  mandateB: "May agree to work schedule",
  jurisdiction: "New York",
  baseline: "Two groups share a garden",
  boundaries: "Voluntary; no waiver of rights",
  evidence: "Map",
  reviewer: "None yet",
  deadline: "",
};
before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "Tests require the isolated emulator.",
  );
  app = initializeApp({ projectId });
  db = getFirestore(app, "jericho");
  service = createService(db);
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
});
after(async () => {
  if (db) await db.terminate();
  if (app) await deleteApp(app);
});
test("membership requires adult consent and filters injected identity claims", async () => {
  await assert.rejects(
    service.updateProfile("a", profile({ adult: false })),
    /Confirm adult/,
  );
  const m = await service.updateProfile(
    "a",
    profile({
      kycStatus: "verified",
      japId: "1".repeat(27),
      legalIdentity: { legalName: "Forged" },
    }),
  );
  assert.equal(m.status, "self-declared");
  assert.equal(m.japId, null);
  assert.equal(m.legalIdentity, null);
  assert.ok(m.collectible.tokenId.startsWith("art_"));
  assert.equal(m.collectible.supply, 1);
  const other = await service.updateProfile(
    "b",
    profile({ displayName: "Other Member" }),
  );
  assert.notEqual(other.collectible.tokenId, m.collectible.tokenId);
});
test("public lookup excludes private fields and public opt-in is revocable", async () => {
  let m = await service.own("a");
  let publicView = await service.lookup(m.profileRef);
  assert.equal(publicView.displayName, undefined);
  assert.equal(publicView.avatarSeed, undefined);
  assert.equal(publicView.legalIdentity, undefined);
  assert.equal(publicView.receipt, undefined);
  m = await service.updateProfile(
    "a",
    profile({ expectedRevision: m.revision, publicListing: true }),
  );
  assert.equal((await service.lookup(m.profileRef)).displayName, "Test Member");
  await service.updateProfile("a", profile({ expectedRevision: m.revision }));
  assert.equal((await service.lookup(m.profileRef)).displayName, undefined);
  await assert.rejects(
    service.updateProfile("a", profile({ expectedRevision: 1 })),
    /changed/,
  );
});
test("access passes bind to recipient, expire, and revoke immediately", async () => {
  const grant = await service.share("a", {
    recipient: "reader@example.invalid",
    fields: ["displayName"],
    label: "Test purpose",
    hours: 1,
    consent: true,
  });
  await assert.rejects(
    service.openShare({ email: "intruder@example.invalid" }, grant.token),
    /unavailable/,
  );
  const opened = await service.openShare(
    { email: "reader@example.invalid" },
    grant.token,
  );
  assert.deepEqual(opened.fields, { displayName: "Test Member" });
  const listed = await service.listShares("a");
  assert.equal(listed[0].accesses, 1);
  await assert.rejects(service.revokeShare("b", listed[0].id), /unavailable/);
  await service.revokeShare("a", listed[0].id);
  await assert.rejects(
    service.openShare({ email: "reader@example.invalid" }, grant.token),
    /unavailable/,
  );
  await assert.rejects(
    service.share("a", {
      recipient: "reader@example.invalid",
      fields: ["dateOfBirth"],
      label: "Test",
      hours: 1,
      consent: true,
    }),
    /after verification/,
  );
});
test("KYC only issues after a bound live result and duplicate callbacks cannot extend it", async () => {
  await db
    .collection("members")
    .doc("a")
    .update({ sessionId: "vs_test", attemptId: "bound-attempt" });
  const session = {
    id: "vs_test",
    metadata: { attempt: "bound-attempt" },
    status: "verified",
    livemode: false,
  };
  await assert.rejects(service.issue("a", session), /live verification/);
  await assert.rejects(
    service.issue("a", {
      ...session,
      livemode: true,
      metadata: { attempt: "wrong" },
    }),
    /binding/,
  );
  const issued = await service.issue("a", {
    ...session,
    livemode: true,
    verified_outputs: {
      first_name: "Synthetic",
      last_name: "Test",
      dob: { year: 1980, month: 1, day: 2 },
    },
  });
  assert.match(issued.japId, /^\d{27}$/);
  assert.equal(issued.status, "verified");
  const repeated = await service.issue("a", { ...session, livemode: true });
  assert.equal(repeated.japId, issued.japId);
  assert.equal(repeated.expiresAt, issued.expiresAt);
  const view = await service.lookup(issued.japId);
  assert.equal(view.legalIdentity, undefined);
  assert.equal(view.displayName, undefined);
});
test("only the other account can accept an invitation and private corrections do not leak", async () => {
  const { room, invite } = await service.createRoom("a", {
    setup,
    consent: true,
  });
  assert.equal(
    room.setup.consentB,
    false,
    "A proposal must not record consent for the invited account.",
  );
  await assert.rejects(
    service.invitePreview("a", invite),
    /other representative/,
  );
  await assert.rejects(service.getRoom("b", room.caseId), /private/);
  await assert.rejects(
    service.joinRoom("b", { token: invite, consent: false }),
    /Confirm/,
  );
  let joined = await service.joinRoom("b", { token: invite, consent: true });
  assert.equal(joined.setup.consentB, true);
  await assert.rejects(
    service.joinRoom("b", { token: invite, consent: true }),
    /already used/,
  );
  const a = await service.roomAction("a", {
    caseId: room.caseId,
    expectedVersion: joined.version,
    type: "revision",
    payload: { side: "b", choice: "revise", text: "PRIVATE_A_CORRECTION" },
  });
  assert.equal(a.state.revisions.a.text, "PRIVATE_A_CORRECTION");
  joined = await service.getRoom("b", room.caseId);
  assert.equal(joined.state.otherSubmitted, true);
  assert.ok(!JSON.stringify(joined).includes("PRIVATE_A_CORRECTION"));
  await assert.rejects(
    service.roomAction("a", {
      caseId: room.caseId,
      expectedVersion: a.version,
      type: "revision",
      payload: { choice: "keep" },
    }),
    /one correction/,
  );
  const both = await service.roomAction("b", {
    caseId: room.caseId,
    expectedVersion: joined.version,
    type: "revision",
    payload: { choice: "keep" },
  });
  assert.equal(both.state.phase, "package");
  assert.equal(both.state.revisions.a.text, "PRIVATE_A_CORRECTION");
  await assert.rejects(
    service.roomAction("b", {
      caseId: room.caseId,
      expectedVersion: 1,
      type: "withdraw",
      payload: { reason: "stale" },
    }),
    /changed/,
  );
  const frozen = await service.roomAction("a", {
    caseId: room.caseId,
    expectedVersion: both.version,
    type: "freeze",
    payload: {
      terms: "Rotate weekly",
      unresolved: "Fence cost remains unresolved",
      implementation: "Review in 30 days",
      review: "No expert needed for voluntary schedule",
      reviewConfirmed: true,
    },
  });
  await assert.rejects(
    service.roomAction("b", {
      caseId: room.caseId,
      expectedVersion: frozen.version,
      type: "decision",
      fingerprint: "wrong",
      payload: { choice: "accept", confirmed: true },
    }),
    /current frozen/,
  );
  const decisionA = await service.roomAction("a", {
    caseId: room.caseId,
    expectedVersion: frozen.version,
    type: "decision",
    fingerprint: frozen.fingerprint,
    payload: { side: "b", choice: "accept", confirmed: true },
  });
  assert.equal(decisionA.state.decisions.b, null);
  const final = await service.roomAction("b", {
    caseId: room.caseId,
    expectedVersion: decisionA.version,
    type: "decision",
    fingerprint: frozen.fingerprint,
    payload: {
      choice: "decline",
      confirmed: true,
      note: "Fence cost unresolved",
    },
  });
  assert.equal(final.state.outcome, "Closed without mutual acceptance");
  assert.equal(final.fingerprint, frozen.fingerprint);
  assert.equal(final.record.events.at(-1).recordedBy, "authenticated-side-b");
  await assert.rejects(
    service.roomAction("a", {
      caseId: room.caseId,
      expectedVersion: final.version,
      type: "withdraw",
      payload: { reason: "late" },
    }),
    /closed/,
  );
});
test("expired access passes cannot be used and a renewed invitation invalidates its predecessor", async () => {
  const { hash } = require("../core");
  const grant = await service.share("b", {
    recipient: "reader@example.invalid",
    fields: ["community"],
    label: "Expiry test",
    hours: 1,
    consent: true,
  });
  await db
    .collection("shares")
    .doc(hash(grant.token))
    .update({ expireAt: new Date(1) });
  await assert.rejects(
    service.openShare({ email: "reader@example.invalid" }, grant.token),
    /unavailable/,
  );
  const created = await service.createRoom("b", { setup, consent: true });
  await assert.rejects(
    service.renewInvite("a", {
      caseId: created.room.caseId,
      expectedVersion: 1,
    }),
    /cannot be renewed/,
  );
  const renewed = await service.renewInvite("b", {
    caseId: created.room.caseId,
    expectedVersion: 1,
  });
  await assert.rejects(
    service.invitePreview("a", created.invite),
    /already used/,
  );
  assert.equal(
    (await service.invitePreview("a", renewed.invite)).caseId,
    created.room.caseId,
  );
});
test("closing membership revokes both locators and removes personal fields", async () => {
  const old = await service.own("a");
  await service.closeProfile("a");
  assert.equal(await service.own("a"), null);
  assert.equal((await service.lookup(old.japId)).status, "revoked");
  assert.equal((await service.lookup(old.profileRef)).status, "revoked");
  const stored = await service.getMember("a");
  assert.equal(stored.displayName, undefined);
  assert.equal(stored.legalIdentity, undefined);
  await assert.rejects(service.updateProfile("a", profile()), /closed/);
});
test("expired credentials never project as currently verified", () => {
  assert.equal(
    memberProjection({
      japId: "1".repeat(27),
      kycStatus: "verified",
      expiresAt: 1,
    }).status,
    "expired",
  );
});
