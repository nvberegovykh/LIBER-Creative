"use strict";
const { randomBytes, randomInt, createHash } = require("node:crypto");
const VERSION = "2026-11-05";
const DAY = 86400000;
const CHANNEL = "pict.jericho.v1";
class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const need = (condition, message, status = 400) => {
  if (!condition) throw new Fault(status, message);
};
const id = () => randomBytes(18).toString("hex");
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const digits = () => Array.from({ length: 27 }, () => randomInt(10)).join("");
const cleanText = (v, label, max = 120, required = true) => {
  need(typeof v === "string", `${label} must be text.`);
  const s = v.trim().normalize("NFC");
  need(
    s.length <= max &&
      (!required || s.length > 0) &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(s),
    `Check ${label}.`,
  );
  return s;
};
function profileInput(data) {
  need(
    data.adult === true &&
      data.consent === true &&
      data.consentVersion === VERSION,
    "Confirm adult participation and the current declaration and privacy notice.",
  );
  need(
    Number.isInteger(data.avatar) && data.avatar >= 0 && data.avatar < 6,
    "Choose an avatar.",
  );
  return {
    displayName: cleanText(data.displayName, "display name", 80),
    community: cleanText(data.community, "community", 80),
    avatar: data.avatar,
    publicListing: data.publicListing === true,
    collectibleConsent: data.collectibleConsent === true,
    adult: true,
    consentVersion: VERSION,
  };
}
function memberProjection(m, owner = false) {
  if (!m || m.deletedAt) return null;
  const active = !m.revokedAt;
  const verified =
    active && m.kycStatus === "verified" && m.expiresAt > Date.now();
  const out = {
    profileRef: m.profileRef,
    japId: m.japId || null,
    status: !active
      ? "revoked"
      : verified
        ? "verified"
        : m.japId
          ? "expired"
          : "self-declared",
    issuedAt: m.issuedAt || null,
    expiresAt: m.expiresAt || null,
    publicListing: Boolean(m.publicListing),
    channel: CHANNEL,
  };
  if ((owner || m.publicListing) && active)
    Object.assign(out, {
      displayName: m.displayName,
      community: m.community,
      avatar: m.avatar,
      avatarSeed: m.avatarSeed,
    });
  if (owner)
    Object.assign(out, {
      revision: m.revision,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      kycStatus: m.kycStatus,
      consentVersion: m.consentVersion,
      adult: m.adult,
      collectibleConsent: m.collectibleConsent,
      collectible: m.collectible || null,
      receipt: m.receipt,
      legalIdentity: m.legalIdentity || null,
    });
  return out;
}
function receipt(previous, type, subject, revision, at) {
  const data = {
    channel: CHANNEL,
    transaction: id(),
    previousHash: previous?.hash || null,
    type,
    subject,
    revision,
    at,
  };
  return { ...data, hash: hash(data) };
}
function validRef(value) {
  return (
    typeof value === "string" &&
    (/^\d{27}$/.test(value) || /^p_[a-f0-9]{36}$/.test(value))
  );
}
const expired = (value) =>
  value &&
  (value.toMillis ? value.toMillis() : new Date(value).getTime()) <= Date.now();
function createService(db, clock = () => Date.now()) {
  const memberRef = (uid) => db.collection("members").doc(uid);
  const refs = (value) => db.collection("references").doc(value);
  async function getMember(uid) {
    return (await memberRef(uid).get()).data() || null;
  }
  async function activeMember(uid) {
    const m = await getMember(uid);
    need(
      m && !m.deletedAt && !m.revokedAt,
      "Save an active community profile first.",
      409,
    );
    return m;
  }
  async function updateProfile(uid, input) {
    const fields = profileInput(input);
    const profileRef = "p_" + id(),
      avatarSeed = id(),
      at = clock();
    return db.runTransaction(async (tx) => {
      const ref = memberRef(uid),
        old = (await tx.get(ref)).data();
      need(
        !old?.deletedAt && !old?.revokedAt,
        "This membership has been closed.",
        409,
      );
      need(
        !old || input.expectedRevision === old.revision,
        "Your profile changed. Reload it before saving.",
        409,
      );
      const next = {
        ...(old || {}),
        ...fields,
        profileRef: old?.profileRef || profileRef,
        avatarSeed: old?.avatarSeed || avatarSeed,
        createdAt: old?.createdAt || at,
        updatedAt: at,
        revision: (old?.revision || 0) + 1,
        kycStatus: old?.kycStatus || "not-started",
      };
      if (fields.collectibleConsent && !old?.collectible)
        next.collectible = {
          tokenId: "art_" + id(),
          channel: CHANNEL,
          standard: "PICT application collectible v1",
          supply: 1,
          transferable: false,
          createdAt: at,
          avatar: fields.avatar,
          seed: next.avatarSeed,
        };
      if (fields.collectibleConsent && old?.collectible)
        next.collectible = { ...old.collectible, avatar: fields.avatar };
      if (!fields.collectibleConsent) next.collectible = null;
      next.receipt = receipt(
        old?.receipt,
        old ? "profile.updated" : "presence.declared",
        next.profileRef,
        next.revision,
        at,
      );
      tx.set(ref, next);
      tx.set(refs(next.profileRef), { uid });
      tx.create(db.collection("receipts").doc(next.receipt.transaction), {
        ...next.receipt,
        uid,
        expireAt: new Date(at + 365 * DAY),
      });
      return memberProjection(next, true);
    });
  }
  async function lookup(value) {
    need(validRef(value), "Enter a valid 27-digit JAP number.");
    const pointer = (await refs(value).get()).data();
    if (!pointer) return null;
    if (pointer.revoked)
      return { profileRef: value, status: "revoked", channel: CHANNEL };
    return memberProjection(await getMember(pointer.uid));
  }
  async function own(uid) {
    return memberProjection(await getMember(uid), true);
  }
  async function listShares(uid) {
    const rows = await db
      .collection("shares")
      .where("owner", "==", uid)
      .limit(100)
      .get();
    return rows.docs.map((s) => {
      const d = s.data();
      return {
        id: s.id,
        label: d.label,
        recipient: d.recipient,
        fields: d.fields,
        expiresAt: d.expireAt.toMillis(),
        revoked: !!d.revoked,
        createdAt: d.createdAt,
        accesses: d.accesses || 0,
      };
    });
  }
  async function share(uid, data) {
    const m = await activeMember(uid);
    need(data.consent === true, "Confirm sharing with this recipient.");
    const recipient = cleanText(
      data.recipient,
      "recipient email",
      254,
    ).toLowerCase();
    need(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient),
      "Enter the recipient’s email.",
    );
    const fields = [...new Set(data.fields || [])];
    need(
      fields.length > 0 &&
        fields.every((x) =>
          ["displayName", "community", "legalName", "dateOfBirth"].includes(x),
        ),
      "Choose fields to share.",
    );
    need(
      !fields.some((x) => ["legalName", "dateOfBirth"].includes(x)) ||
        (m.kycStatus === "verified" && m.expiresAt > clock()),
      "Verified identity details are available after verification.",
    );
    const rows = await listShares(uid);
    need(
      rows.filter((s) => !s.revoked && s.expiresAt > clock()).length < 20,
      "Revoke an existing access pass first.",
      409,
    );
    const token = randomBytes(32).toString("base64url"),
      at = clock();
    const duration = Number(data.hours);
    need([1, 24, 168].includes(duration), "Choose an access duration.");
    await db
      .collection("shares")
      .doc(hash(token))
      .create({
        owner: uid,
        recipient,
        fields,
        label: cleanText(data.label, "purpose", 120),
        createdAt: at,
        expireAt: new Date(at + duration * 3600000),
        revoked: false,
        accesses: 0,
      });
    return { token, expiresAt: at + duration * 3600000 };
  }
  async function openShare(user, token) {
    need(
      typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
      "Invalid access pass.",
      404,
    );
    return db.runTransaction(async (tx) => {
      const ref = db.collection("shares").doc(hash(token)),
        grant = (await tx.get(ref)).data();
      need(
        grant &&
          !grant.revoked &&
          !expired(grant.expireAt) &&
          grant.recipient === user.email?.toLowerCase(),
        "This access pass is unavailable for this account.",
        403,
      );
      const m = (await tx.get(memberRef(grant.owner))).data();
      need(
        m && !m.revokedAt && !m.deletedAt,
        "This profile is no longer shared.",
        410,
      );
      const out = {
        purpose: grant.label,
        expiresAt: grant.expireAt.toMillis(),
        profile: memberProjection(m),
        fields: {},
      };
      for (const field of grant.fields) {
        if (["displayName", "community"].includes(field))
          out.fields[field] = m[field];
        else if (m.kycStatus === "verified" && m.expiresAt > clock())
          out.fields[field] = m.legalIdentity?.[field] || null;
      }
      tx.update(ref, {
        accesses: (grant.accesses || 0) + 1,
        lastAccessAt: clock(),
      });
      return out;
    });
  }
  async function revokeShare(uid, value) {
    need(
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
      "Invalid access pass.",
    );
    const ref = db.collection("shares").doc(value);
    await db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      need(row?.owner === uid, "Access pass unavailable.", 404);
      tx.update(ref, { revoked: true });
    });
    return { revoked: true };
  }
  async function closeProfile(uid) {
    const ref = memberRef(uid),
      at = clock();
    const result = await db.runTransaction(async (tx) => {
      const old = (await tx.get(ref)).data();
      if (!old || old.deletedAt) return null;
      const tombstone = {
        deletedAt: at,
        revokedAt: at,
        profileRef: old.profileRef,
        japId: old.japId || null,
        sessionId: old.sessionId || null,
        kycStatus: "redaction-pending",
        revision: old.revision + 1,
      };
      tx.set(ref, tombstone);
      tx.set(refs(old.profileRef), { revoked: true });
      if (old.japId) tx.set(refs(old.japId), { revoked: true });
      return { sessionId: old.sessionId || null };
    });
    const grants = await db
      .collection("shares")
      .where("owner", "==", uid)
      .get();
    const batch = db.batch();
    grants.docs.forEach((s) => batch.delete(s.ref));
    await batch.commit();
    return result;
  }
  async function issue(uid, session) {
    need(
      session.livemode === true &&
        session.status === "verified" &&
        !session.redaction,
      "Only a completed live verification can issue a JAP.",
    );
    const number = digits(),
      at = clock();
    return db.runTransaction(async (tx) => {
      const ref = memberRef(uid),
        m = (await tx.get(ref)).data();
      need(
        m &&
          !m.revokedAt &&
          !m.deletedAt &&
          m.sessionId === session.id &&
          m.attemptId === session.metadata?.attempt,
        "Verification binding is invalid.",
        409,
      );
      if (m.japId && m.verifiedSessionId === session.id)
        return memberProjection(m, true);
      if (!m.japId)
        need(
          !(await tx.get(refs(number))).exists,
          "Please retry issuance.",
          409,
        );
      const v = session.verified_outputs || {};
      const legalIdentity = {
        legalName:
          [v.first_name, v.last_name].filter(Boolean).join(" ") || null,
        dateOfBirth:
          v.dob?.year && v.dob?.month && v.dob?.day
            ? `${v.dob.year}-${String(v.dob.month).padStart(2, "0")}-${String(v.dob.day).padStart(2, "0")}`
            : null,
      };
      need(
        legalIdentity.legalName && legalIdentity.dateOfBirth,
        "The provider must return a verified name and birth date before issuance.",
        409,
      );
      const born = new Date(legalIdentity.dateOfBirth + "T00:00:00Z"),
        today = new Date(at);
      const adultOn = new Date(
        Date.UTC(
          born.getUTCFullYear() + 18,
          born.getUTCMonth(),
          born.getUTCDate(),
        ),
      );
      need(
        Number.isFinite(born.getTime()) && adultOn <= today,
        "Adult identity verification is required.",
        409,
      );
      const next = {
        ...m,
        japId: m.japId || number,
        verifiedSessionId: session.id,
        kycStatus: "verified",
        legalIdentity,
        issuedAt: at,
        expiresAt: at + 365 * DAY,
        updatedAt: at,
        revision: m.revision + 1,
      };
      next.receipt = receipt(
        m.receipt,
        "credential.issued",
        m.profileRef,
        next.revision,
        at,
      );
      tx.set(ref, next);
      if (!m.japId) tx.create(refs(number), { uid });
      tx.create(db.collection("receipts").doc(next.receipt.transaction), {
        ...next.receipt,
        uid,
        expireAt: new Date(at + 365 * DAY),
      });
      return memberProjection(next, true);
    });
  }
  async function createRoom(uid, data) {
    await activeMember(uid);
    need(data.consent === true, "Confirm your authority and participation.");
    const p = await import("./protocol.mjs"),
      caseId = id(),
      at = clock();
    const setup = p.createRecord(
      { ...data.setup, consentA: true, consentB: true },
      caseId,
      new Date(at).toISOString(),
    ).setup;
    setup.consentB = false;
    const token = randomBytes(32).toString("base64url");
    const rooms = await db
      .collection("rooms")
      .where("members", "array-contains", uid)
      .limit(51)
      .get();
    need(
      rooms.size < 50,
      "You have reached the current limit of 50 active records.",
      409,
    );
    const room = {
      caseId,
      members: [uid],
      a: uid,
      b: null,
      setup,
      version: 1,
      record: null,
      createdAt: at,
      updatedAt: at,
      inviteHash: hash(token),
      expireAt: new Date(at + 365 * DAY),
      authEvents: [{ side: "a", action: "baseline.proposed", at }],
    };
    const batch = db.batch();
    batch.create(db.collection("rooms").doc(caseId), room);
    batch.create(db.collection("invites").doc(hash(token)), {
      caseId,
      expireAt: new Date(at + 7 * DAY),
      used: false,
    });
    await batch.commit();
    return { room: await projectRoom(room, uid), invite: token };
  }
  async function invitePreview(uid, token) {
    need(
      typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token),
      "Invitation unavailable.",
      404,
    );
    const invitation = (
      await db.collection("invites").doc(hash(token)).get()
    ).data();
    need(
      invitation && !invitation.used && !expired(invitation.expireAt),
      "Invitation expired or already used.",
      410,
    );
    const room = (
      await db.collection("rooms").doc(invitation.caseId).get()
    ).data();
    need(
      room && !room.b && !room.canceled && !expired(room.expireAt),
      "Invitation unavailable.",
      410,
    );
    need(
      room.a !== uid,
      "Send this invitation to the other representative.",
      409,
    );
    return {
      caseId: room.caseId,
      setup: room.setup,
      createdAt: room.createdAt,
    };
  }
  async function joinRoom(uid, data) {
    await activeMember(uid);
    need(
      data.consent === true,
      "Confirm participation and the full shared starting record.",
    );
    await invitePreview(uid, data.token);
    const p = await import("./protocol.mjs"),
      at = clock();
    return db.runTransaction(async (tx) => {
      const invRef = db.collection("invites").doc(hash(data.token)),
        inv = (await tx.get(invRef)).data();
      need(
        inv && !inv.used && !expired(inv.expireAt),
        "Invitation unavailable.",
        410,
      );
      const ref = db.collection("rooms").doc(inv.caseId),
        room = (await tx.get(ref)).data();
      need(
        room && !room.b && !room.canceled && room.a !== uid,
        "Invitation unavailable.",
        409,
      );
      // B accepts the exact proposed mandate and starting record; changes need a fresh invitation.
      room.b = uid;
      room.members.push(uid);
      room.version++;
      room.updatedAt = at;
      room.setup.consentB = true;
      room.record = p.createRecord(
        room.setup,
        room.caseId,
        new Date(at).toISOString(),
      );
      room.authEvents.push({ side: "b", action: "baseline.accepted", at });
      tx.set(ref, room);
      tx.update(invRef, { used: true });
      return projectRoom(room, uid);
    });
  }
  async function projectRoom(room, uid) {
    const side = room.a === uid ? "a" : room.b === uid ? "b" : null;
    need(side, "This negotiation is private.", 403);
    const p = await import("./protocol.mjs");
    const out = {
      caseId: room.caseId,
      setup: room.setup,
      side,
      version: room.version,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      state: {
        phase: room.canceled ? "closed" : "invitation",
        outcome: room.canceled ? "Invitation withdrawn" : null,
      },
      authEvents: room.authEvents,
      fingerprint: null,
      record: null,
      withdrawalReason: room.withdrawalReason || null,
    };
    if (room.record) {
      const state = p.getState(room.record),
        record = structuredClone(room.record);
      // A submitted correction is inaccessible to the other account until both submit.
      // Apply this to the replayable event log as well as the convenience state.
      if (state.phase === "corrections") {
        const other = side === "a" ? "b" : "a";
        state.otherSubmitted = Boolean(state.revisions[other]);
        state.revisions[other] = null;
        record.events = record.events.filter(
          (e) => e.type !== "revision" || e.payload.side === side,
        );
      }
      out.state = state;
      out.record = record;
      const contents = p.packageText(room.record);
      out.fingerprint = contents ? hash(contents) : null;
    }
    return out;
  }
  async function listRooms(uid) {
    const rows = await db
      .collection("rooms")
      .where("members", "array-contains", uid)
      .limit(50)
      .get();
    const items = await Promise.all(
      rows.docs
        .filter((s) => !expired(s.data().expireAt))
        .map((s) => projectRoom(s.data(), uid)),
    );
    return items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({
        caseId: r.caseId,
        title: r.setup.title,
        partyA: r.setup.partyA,
        partyB: r.setup.partyB,
        phase: r.state.phase,
        outcome: r.state.outcome,
        updatedAt: r.updatedAt,
        side: r.side,
      }));
  }
  async function getRoom(uid, value) {
    need(
      typeof value === "string" && /^[a-f0-9]{36}$/.test(value),
      "Negotiation unavailable.",
      404,
    );
    const room = (await db.collection("rooms").doc(value).get()).data();
    need(room && !expired(room.expireAt), "Negotiation unavailable.", 404);
    return projectRoom(room, uid);
  }
  async function renewInvite(uid, data) {
    await activeMember(uid);
    need(
      typeof data.caseId === "string" && /^[a-f0-9]{36}$/.test(data.caseId),
      "Invalid negotiation.",
    );
    const token = randomBytes(32).toString("base64url");
    return db.runTransaction(async (tx) => {
      const ref = db.collection("rooms").doc(data.caseId),
        room = (await tx.get(ref)).data();
      need(
        room &&
          room.a === uid &&
          !room.b &&
          !room.canceled &&
          !expired(room.expireAt),
        "Invitation cannot be renewed.",
        409,
      );
      need(
        room.version === data.expectedVersion,
        "The negotiation changed. Refresh before continuing.",
        409,
      );
      tx.set(
        db.collection("invites").doc(room.inviteHash),
        { used: true },
        { merge: true },
      );
      room.inviteHash = hash(token);
      room.version++;
      room.updatedAt = clock();
      tx.create(db.collection("invites").doc(room.inviteHash), {
        caseId: room.caseId,
        used: false,
        expireAt: new Date(clock() + 7 * DAY),
      });
      tx.set(ref, room);
      return { room: await projectRoom(room, uid), invite: token };
    });
  }
  async function roomAction(uid, data) {
    await activeMember(uid);
    need(
      typeof data.caseId === "string" && /^[a-f0-9]{36}$/.test(data.caseId),
      "Invalid negotiation.",
    );
    const p = await import("./protocol.mjs"),
      at = clock();
    return db.runTransaction(async (tx) => {
      const ref = db.collection("rooms").doc(data.caseId),
        room = (await tx.get(ref)).data();
      need(
        room && room.members.includes(uid) && !expired(room.expireAt),
        "Negotiation unavailable.",
        404,
      );
      need(
        room.version === data.expectedVersion,
        "The negotiation changed. Refresh before continuing.",
        409,
      );
      const side = room.a === uid ? "a" : "b";
      if (!room.record) {
        need(
          data.type === "withdraw" && side === "a" && !room.canceled,
          "Wait for the other representative.",
          409,
        );
        room.canceled = true;
        room.withdrawalReason = cleanText(
          data.payload?.reason || "",
          "withdrawal reason",
          2000,
        );
      } else {
        if (data.type === "decision")
          need(
            data.fingerprint === hash(p.packageText(room.record)),
            "Review the current frozen package.",
            409,
          );
        room.record = p.appendEvent(
          room.record,
          data.type,
          { ...data.payload, side },
          new Date(at).toISOString(),
        );
        room.record.events.at(-1).recordedBy = `authenticated-side-${side}`;
        if (["withdraw", "no-agreement"].includes(data.type))
          room.withdrawalReason = data.payload.reason;
      }
      room.version++;
      room.updatedAt = at;
      room.expireAt = new Date(at + 365 * DAY);
      room.authEvents.push({ side, action: data.type, at });
      tx.set(ref, room);
      return projectRoom(room, uid);
    });
  }
  return {
    getMember,
    activeMember,
    updateProfile,
    own,
    lookup,
    listShares,
    share,
    openShare,
    revokeShare,
    closeProfile,
    issue,
    createRoom,
    invitePreview,
    joinRoom,
    listRooms,
    getRoom,
    renewInvite,
    roomAction,
  };
}
module.exports = {
  createService,
  Fault,
  need,
  hash,
  id,
  digits,
  cleanText,
  profileInput,
  memberProjection,
  receipt,
  VERSION,
  CHANNEL,
  DAY,
};
