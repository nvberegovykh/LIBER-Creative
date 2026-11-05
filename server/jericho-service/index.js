"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const {
  createService,
  Fault,
  need,
  hash,
  VERSION,
  CHANNEL,
  DAY,
} = require("./core");
const Stripe = require("stripe");
const { createIdentity } = require("./identity");
if (!getApps().length) initializeApp();
const db = getFirestore("jericho");
const service = createService(db);
const stripeKey = process.env.JERICHO_STRIPE_KEY;
const webhookKey = process.env.JERICHO_STRIPE_WEBHOOK_SECRET;
// DOB access requires a restricted Identity key, not a general secret key.
const providerConfigured =
  Boolean(stripeKey?.startsWith("rk_live_")) && Boolean(webhookKey);
const providerEnabled =
  providerConfigured && process.env.JERICHO_IDENTITY_LIVE_ENABLED === "true";
const stripe = providerConfigured ? new Stripe(stripeKey) : null;
const identity = stripe
  ? createIdentity({ db, service, auth: getAuth(), stripe, webhookKey })
  : null;
const origins = new Set([
  "https://liberpict.com",
  "https://www.liberpict.com",
  "https://liber-apps-cca20.web.app",
]);
if (process.env.FUNCTIONS_EMULATOR === "true")
  origins.add("http://localhost:8765");

async function rate(key, max = 60) {
  const minute = Math.floor(Date.now() / 60000),
    ref = db.collection("limits").doc(hash(`${key}:${minute}`));
  await db.runTransaction(async (tx) => {
    const old = (await tx.get(ref)).data();
    need(
      (old?.count || 0) < max,
      "Please wait a minute before trying again.",
      429,
    );
    tx.set(ref, {
      count: (old?.count || 0) + 1,
      expireAt: new Date(Date.now() + DAY),
    });
  });
}
async function currentUser(req) {
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(
    req.get("authorization") || "",
  );
  need(match, "Sign in to continue.", 401);
  let user;
  try {
    user = await getAuth().verifyIdToken(match[1], true);
  } catch (_) {
    throw new Fault(401, "Your sign-in expired. Sign in again.");
  }
  need(
    user.email_verified === true && user.email,
    "Verify your email, then refresh your sign-in.",
    403,
  );
  return user;
}
async function handler(req, res) {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  const origin = req.get("origin");
  if (origin && origins.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  }
  if (req.method === "OPTIONS")
    return res.status(origin && origins.has(origin) ? 204 : 403).end();
  try {
    if (req.method === "GET" && (req.path === "/" || req.path === "/health"))
      return res.json({
        service: "Jericho Alliance",
        version: VERSION,
        channel: CHANNEL,
        providerEnabled,
      });
    need(req.method === "POST", "Use POST.", 405);
    if (req.path === "/stripe-webhook") {
      need(providerConfigured, "Provider unavailable.", 503);
      return res.json(
        await identity.receive(req.rawBody, req.get("stripe-signature")),
      );
    }
    need(!origin || origins.has(origin), "Origin is unavailable.", 403);
    need(req.is("application/json"), "Use JSON.", 415);
    need(req.rawBody?.length <= 100000, "This request is too large.", 413);
    const { action, data = {} } = req.body || {};
    need(
      typeof action === "string" &&
        data &&
        typeof data === "object" &&
        !Array.isArray(data),
      "Invalid request.",
    );
    if (action === "lookup") {
      await rate(`public:${req.ip}`, 30);
      return res.json({ profile: await service.lookup(data.reference) });
    }
    const user = await currentUser(req);
    await rate(`member:${user.uid}`, 90);
    let result;
    switch (action) {
      case "me":
        result = {
          profile: await service.own(user.uid),
          closed: Boolean((await service.getMember(user.uid))?.deletedAt),
          providerEnabled,
        };
        break;
      case "profile.save":
        result = { profile: await service.updateProfile(user.uid, data) };
        break;
      case "profile.export": {
        const receipts = await db
          .collection("receipts")
          .where("uid", "==", user.uid)
          .limit(1000)
          .get();
        result = {
          profile: await service.own(user.uid),
          shares: await service.listShares(user.uid),
          receipts: receipts.docs.map((s) => {
            const { uid, expireAt, ...r } = s.data();
            return r;
          }),
          negotiations: await service.listRooms(user.uid),
        };
        break;
      }
      case "profile.close": {
        need(
          data.confirmation === "CLOSE" &&
            Date.now() / 1000 - user.auth_time < 900,
          "Sign in again, then type CLOSE to confirm.",
          403,
        );
        const closed = await service.closeProfile(user.uid);
        let redaction = "not-needed";
        if (closed) {
          redaction = identity
            ? await identity.redactClosedMember(user.uid)
            : "pending";
        }
        result = { closed: true, redaction };
        break;
      }
      case "shares.list":
        result = { shares: await service.listShares(user.uid) };
        break;
      case "share.create":
        result = await service.share(user.uid, data);
        break;
      case "share.open":
        result = await service.openShare(user, data.token);
        break;
      case "share.revoke":
        result = await service.revokeShare(user.uid, data.id);
        break;
      case "verification.start":
        need(
          providerEnabled,
          "Document verification is awaiting provider activation. Your saved profile remains available.",
          503,
        );
        result = await identity.start(user.uid, data);
        break;
      case "verification.refresh": {
        const m = await service.activeMember(user.uid);
        if (identity && m.sessionId) await identity.reconcile(m.sessionId);
        result = { profile: await service.own(user.uid), providerEnabled };
        break;
      }
      case "rooms.list":
        result = { rooms: await service.listRooms(user.uid) };
        break;
      case "room.create":
        result = await service.createRoom(user.uid, data);
        break;
      case "room.get":
        result = { room: await service.getRoom(user.uid, data.caseId) };
        break;
      case "room.invite":
        result = await service.renewInvite(user.uid, data);
        break;
      case "invite.preview":
        result = await service.invitePreview(user.uid, data.token);
        break;
      case "room.join":
        result = { room: await service.joinRoom(user.uid, data) };
        break;
      case "room.action":
        result = { room: await service.roomAction(user.uid, data) };
        break;
      default:
        throw new Fault(404, "Unknown action.");
    }
    res.json(result);
  } catch (e) {
    const status =
      e.status ||
      (e.message &&
      /required|must|before|ended|already|Choose|Confirm|record is closed|too long/i.test(
        e.message,
      )
        ? 400
        : 500);
    if (status === 500)
      console.error("jericho-request-failed", {
        code: e.code || "internal",
        name: e.name,
      });
    res.status(status).json({
      error:
        status === 500
          ? "The request could not be completed. Please try again."
          : e.message,
    });
  }
}
exports.jerichoApi = onRequest(
  {
    region: "us-central1",
    maxInstances: 4,
    minInstances: 0,
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: false,
  },
  handler,
);
exports.handlerForTest = handler;
// Deploy this maintenance function together with provider activation. No identity
// documents are processed by the currently provider-disabled service.
exports.jerichoMaintenance = onSchedule(
  {
    schedule: "every 24 hours",
    region: "us-central1",
    serviceAccount: "jericho-channel@liber-apps-cca20.iam.gserviceaccount.com",
    maxInstances: 1,
    secrets: ["JERICHO_STRIPE_KEY", "JERICHO_STRIPE_WEBHOOK_SECRET"],
  },
  async () => {
    if (identity) await identity.maintenance();
  },
);
