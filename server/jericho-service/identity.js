"use strict";
const { Fault, need, id, VERSION } = require("./core");

// Keep provider access injectable so the complete signed-callback path can be
// exercised against the isolated database without real identity evidence.
function createIdentity({
  db,
  service,
  auth,
  stripe,
  webhookKey,
  clock = Date.now,
}) {
  async function reconcile(sessionId) {
    // Check status without requesting sensitive outputs. Stripe removes metadata
    // on redaction, and detailed result access normally expires after 48 hours.
    let session =
      await stripe.identity.verificationSessions.retrieve(sessionId);
    if (session.livemode !== true) return;
    const binding = (
      await db.collection("providerSessions").doc(session.id).get()
    ).data();
    if (!binding) {
      if (
        session.metadata?.purpose === "jericho-membership" &&
        !session.redaction
      )
        throw new Fault(503, "Provider binding pending.");
      return;
    }
    const member = await service.getMember(binding.uid);
    if (!member) return;
    if (session.redaction || session.status === "canceled") {
      await db.runTransaction(async (tx) => {
        const ref = db.collection("members").doc(binding.uid);
        const current = (await tx.get(ref)).data();
        if (!current || current.deletedAt || current.sessionId !== session.id)
          return;
        const updates = {
          kycStatus: session.redaction ? "redacted" : "canceled",
          legalIdentity: null,
          updatedAt: clock(),
          revision: current.revision + 1,
        };
        if (current.japId) {
          updates.revokedAt = clock();
          tx.set(db.collection("references").doc(current.japId), {
            revoked: true,
          });
          tx.set(db.collection("references").doc(current.profileRef), {
            revoked: true,
          });
        }
        tx.update(ref, updates);
      });
      if (member.deletedAt) await redactClosedMember(binding.uid);
      return;
    }
    need(
      session.metadata?.purpose === "jericho-membership" &&
        binding.attemptId === session.metadata?.attempt,
      "Provider binding is invalid.",
      409,
    );
    if (member.deletedAt || member.revokedAt || member.sessionId !== session.id)
      return;
    if (session.status === "verified") {
      // Replays and ordinary profile refreshes never need to reread the DOB.
      if (member.japId && member.verifiedSessionId === session.id) return;
      const account = await auth.getUser(binding.uid);
      need(
        account.emailVerified && !account.disabled,
        "Account is no longer eligible.",
        409,
      );
      session = await stripe.identity.verificationSessions.retrieve(
        session.id,
        {
          expand: ["verified_outputs", "verified_outputs.dob"],
        },
      );
      await service.issue(binding.uid, session);
    } else {
      await db.runTransaction(async (tx) => {
        const ref = db.collection("members").doc(binding.uid);
        const current = (await tx.get(ref)).data();
        if (
          !current ||
          current.deletedAt ||
          current.revokedAt ||
          current.sessionId !== session.id
        )
          return;
        tx.update(ref, { kycStatus: session.status });
      });
    }
  }

  async function start(uid, data) {
    need(
      data.consentVersion === VERSION && data.consent === true,
      "Confirm the identity-verification notice.",
    );
    const member = await service.activeMember(uid);
    if (member.japId && member.expiresAt > clock())
      return { profile: await service.own(uid) };
    const ref = db.collection("members").doc(uid);
    const attempt = await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      need(
        current && !current.revokedAt && !current.deletedAt,
        "Membership unavailable.",
        409,
      );
      if (
        current.attemptId &&
        !["canceled", "redacted"].includes(current.kycStatus) &&
        !(
          current.expiresAt &&
          current.expiresAt <= clock() &&
          current.sessionId === current.verifiedSessionId
        )
      )
        return current;
      const next = {
        ...current,
        attemptId: id(),
        sessionId: null,
        kycStatus: "pending",
        updatedAt: clock(),
        revision: current.revision + 1,
      };
      tx.set(ref, next);
      return next;
    });
    const session = attempt.sessionId
      ? await stripe.identity.verificationSessions.retrieve(attempt.sessionId)
      : await stripe.identity.verificationSessions.create(
          {
            type: "document",
            metadata: {
              purpose: "jericho-membership",
              attempt: attempt.attemptId,
            },
            options: { document: { require_matching_selfie: true } },
            return_url:
              "https://liberpict.com/jericho-alliance/sip/#verification-return",
          },
          { idempotencyKey: `jericho-${attempt.attemptId}` },
        );
    need(
      session.livemode === true,
      "The provider must be activated for live verification.",
      503,
    );
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data();
      need(
        current &&
          !current.deletedAt &&
          !current.revokedAt &&
          current.attemptId === attempt.attemptId,
        "Your enrollment changed. Refresh and try again.",
        409,
      );
      tx.update(ref, { sessionId: session.id, kycStatus: session.status });
      tx.set(db.collection("providerSessions").doc(session.id), {
        uid,
        attemptId: attempt.attemptId,
      });
    });
    await reconcile(session.id);
    return {
      url: session.url || null,
      status: session.status,
      profile: await service.own(uid),
    };
  }

  async function receive(rawBody, signature) {
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookKey);
    } catch (_) {
      throw new Fault(400, "Invalid signature.");
    }
    if (
      event.livemode === true &&
      event.type.startsWith("identity.verification_session.")
    )
      await reconcile(event.data.object.id);
    return { received: true };
  }

  async function redactClosedMember(uid) {
    const member = await service.getMember(uid);
    if (!member?.deletedAt) return;
    const bindings = await db
      .collection("providerSessions")
      .where("uid", "==", uid)
      .get();
    const sessions = new Set(bindings.docs.map((row) => row.id));
    if (member.sessionId) sessions.add(member.sessionId);
    let pending = false;
    for (const sessionId of sessions) {
      try {
        let session =
          await stripe.identity.verificationSessions.retrieve(sessionId);
        if (session.livemode !== true) {
          pending = true;
          continue;
        }
        if (!session.redaction)
          session =
            await stripe.identity.verificationSessions.redact(sessionId);
        if (session.redaction?.status === "redacted")
          await db.collection("providerSessions").doc(sessionId).delete();
        else pending = true;
      } catch (_) {
        pending = true;
      }
    }
    if (!pending)
      await db
        .collection("members")
        .doc(uid)
        .update({ kycStatus: "redacted", sessionId: null });
    return pending ? "pending" : "redacted";
  }
  async function maintenance() {
    const pending = await db
      .collection("members")
      .where("kycStatus", "==", "redaction-pending")
      .limit(100)
      .get();
    for (const row of pending.docs) await redactClosedMember(row.id);
  }
  return { start, reconcile, receive, redactClosedMember, maintenance };
}
module.exports = { createIdentity };
