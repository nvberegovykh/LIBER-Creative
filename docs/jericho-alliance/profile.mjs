import {
  $,
  el,
  shell,
  api,
  ready,
  state,
  memberCard,
  avatar,
  notice,
  busy,
  date,
  authForm,
  verificationControls,
  download,
  copy,
  VERSION,
  openAuth,
} from "./client.mjs";
import { cardDownload, qrDownload, avatarDownload } from "./card.mjs";
shell("Profile");
let saved = null,
  choice = 0,
  providerEnabled = false,
  authSequence = 0;
const names = [
  "Mountain traveler",
  "Silver-haired scholar",
  "Forest ranger",
  "Village builder",
  "Coastal explorer",
  "Garden keeper",
];
function preview() {
  $("#profile-card").replaceChildren(
    memberCard(
      {
        ...(saved || {}),
        displayName: $("#display-name").value || "Your chosen name",
        community: $("#community").value || "Jericho Alliance",
        avatar: choice,
      },
      !saved,
    ),
  );
  document
    .querySelectorAll(".avatar-option")
    .forEach((b, i) => b.setAttribute("aria-pressed", String(i === choice)));
}
$("#avatar-options").append(
  ...names.map((name, index) =>
    el(
      "button",
      {
        type: "button",
        class: "avatar-option",
        "aria-label": name,
        "aria-pressed": String(index === 0),
        onclick: () => {
          choice = index;
          preview();
        },
      },
      avatar(index, name),
    ),
  ),
);
$("#profile-form").addEventListener("input", preview);
preview();
function renderSaved(profile) {
  saved = profile;
  $("#member-tools").hidden = !profile;
  $("#sharing-space").hidden = !profile;
  $("#card-actions").hidden = !profile;
  if (!profile) return preview();
  choice = profile.avatar;
  $("#display-name").value = profile.displayName;
  $("#community").value = profile.community;
  $("#public-listing").checked = profile.publicListing;
  $("#collectible-consent").checked = profile.collectibleConsent;
  $("#adult").checked = profile.adult;
  $("#consent").checked = profile.consentVersion === VERSION;
  $("#save-profile").textContent = "Save changes";
  $("#progress-verification").textContent =
    profile.status === "verified"
      ? "Completed"
      : profile.kycStatus === "not-started"
        ? "Not started"
        : profile.kycStatus.replaceAll("_", " ");
  $("#progress-jap").textContent = profile.japId
    ? "Issued"
    : "After verification";
  $("#card-help").textContent = profile.japId
    ? `JAP ${profile.japId}. Your downloaded QR checks the current issuer record.`
    : "Your saved self-declared profile is available now. A 27-digit JAP number follows a successful identity check.";
  $("#presence-status").textContent =
    `Declaration accepted ${date(profile.createdAt)} · Version ${profile.consentVersion}.`;
  const verification =
    profile.status === "verified"
      ? `Identity check completed. Current through ${date(profile.expiresAt)}.`
      : !providerEnabled
        ? "Document checks are awaiting Stripe account activation. Your saved profile, artwork, QR, sharing controls, and negotiations are available."
        : profile.kycStatus === "processing"
          ? "Stripe is reviewing your identity evidence. Refresh later for the result."
          : "Ready when you are. Continue to Stripe’s secure document and selfie check.";
  $("#verification-status").textContent = verification;
  $("#start-verification").hidden =
    !providerEnabled || profile.status === "verified";
  $("#kyc-consent-row").hidden = $("#start-verification").hidden;
  $("#verified-share-fields").hidden = profile.status !== "verified";
  $("#receipt").textContent = JSON.stringify(profile.receipt, null, 2);
  const collectible = $("#collectible-state");
  collectible.replaceChildren();
  if (profile.collectible) {
    collectible.append(
      el(
        "p",
        { class: "small" },
        "Your unique avatar record is saved in the PICT Jericho channel. It belongs to this account and cannot be transferred.",
      ),
      el(
        "button",
        {
          class: "text-button",
          onclick: () =>
            download(
              "PICT-avatar-record.json",
              JSON.stringify(profile.collectible, null, 2),
            ),
        },
        "Download avatar record",
      ),
    );
  } else
    collectible.append(
      el(
        "p",
        { class: "small" },
        "Avatar-record creation is optional. Choose it above to register your artwork record.",
      ),
    );
  preview();
  loadShares();
}
async function authChanged() {
  const sequence = ++authSequence;
  if (!state.user?.emailVerified) {
    saved = null;
    $("#account-gate").hidden = false;
    $("#profile-space").hidden = true;
    $("#auth-inline").replaceChildren(
      state.user
        ? el(
            "div",
            { class: "notice" },
            el("p", {}, "Confirm your LIBER email to continue."),
            verificationControls(),
          )
        : el("div", { class: "auth-box" }, authForm()),
    );
    return;
  }
  $("#account-gate").hidden = true;
  $("#profile-space").hidden = false;
  notice($("#global-status"), "Loading your profile…");
  try {
    const data = await api("me");
    if (sequence !== authSequence) return;
    if (data.closed) {
      $("#profile-space").hidden = true;
      $("#account-gate").hidden = false;
      $("#auth-inline").replaceChildren(
        el(
          "div",
          { class: "notice" },
          el("h2", {}, "Membership closed"),
          el(
            "p",
            {},
            "This account’s Jericho membership has been closed and its references revoked. Your LIBER account remains available.",
          ),
          el("button", { onclick: openAuth }, "My LIBER account"),
        ),
      );
      return;
    }
    providerEnabled = data.providerEnabled;
    renderSaved(data.profile);
    notice($("#global-status"), "");
  } catch (error) {
    notice($("#global-status"), error.message, true);
  }
}
window.addEventListener("jericho-auth", authChanged);
$("#profile-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(
    e.submitter,
    async () => {
      const form = new FormData(e.target);
      const { profile } = await api("profile.save", {
        displayName: form.get("displayName"),
        community: form.get("community"),
        avatar: choice,
        adult: form.has("adult"),
        consent: form.has("consent"),
        publicListing: form.has("publicListing"),
        collectibleConsent: form.has("collectibleConsent"),
        consentVersion: VERSION,
        expectedRevision: saved?.revision,
      });
      renderSaved(profile);
      notice($("#save-status"), "Your profile and presence record are saved.");
    },
    $("#save-status"),
  );
});
for (const [selector, fn] of [
  ["#download-front", (p) => cardDownload(p, "front")],
  ["#download-back", (p) => cardDownload(p, "back")],
  ["#download-qr", qrDownload],
  ["#download-avatar", avatarDownload],
]) {
  $(selector).addEventListener("click", (e) =>
    busy(
      e.currentTarget,
      async () => {
        if (!saved) throw new Error("Save your profile first.");
        await fn(saved);
        notice($("#download-status"), "Downloaded from your saved profile.");
      },
      $("#download-status"),
    ),
  );
}
$("#download-presence").addEventListener("click", () => {
  if (saved)
    download(
      "Declaration-of-Presence-record.json",
      JSON.stringify(
        {
          declaration: "https://liberpict.com/declaration-of-presence",
          version: saved.consentVersion,
          acceptedAt: saved.createdAt,
          displayName: saved.displayName,
          community: saved.community,
          receipt: saved.receipt,
        },
        null,
        2,
      ),
    );
});
$("#export-data").addEventListener("click", (e) =>
  busy(
    e.currentTarget,
    async () => {
      const data = await api("profile.export");
      download("Jericho-my-records.json", JSON.stringify(data, null, 2));
      notice($("#records-status"), "Your data export is downloaded.");
    },
    $("#records-status"),
  ),
);
$("#refresh-verification").addEventListener("click", (e) =>
  busy(
    e.currentTarget,
    async () => {
      const data = await api("verification.refresh");
      providerEnabled = data.providerEnabled;
      renderSaved(data.profile);
      notice($("#verification-message"), "Current status retrieved.");
    },
    $("#verification-message"),
  ),
);
$("#start-verification").addEventListener("click", (e) =>
  busy(
    e.currentTarget,
    async () => {
      if (!$("#kyc-consent").checked)
        throw new Error(
          "Confirm document and selfie verification before continuing.",
        );
      const data = await api("verification.start", {
        consentVersion: VERSION,
        consent: true,
      });
      if (data.profile) renderSaved(data.profile);
      if (data.url) {
        const url = new URL(data.url);
        if (
          url.protocol !== "https:" ||
          !(
            url.hostname === "verify.stripe.com" ||
            url.hostname.endsWith(".stripe.com")
          )
        )
          throw new Error("Unexpected provider URL.");
        location.assign(url.href);
      } else
        notice(
          $("#verification-message"),
          "Verification is being processed. Refresh status for updates.",
        );
    },
    $("#verification-message"),
  ),
);
async function loadShares() {
  try {
    const { shares } = await api("shares.list");
    const list = $("#share-list");
    list.replaceChildren();
    if (!shares.length) list.append(el("li", {}, "No access passes created."));
    for (const row of shares.sort((a, b) => b.createdAt - a.createdAt)) {
      const inactive = row.revoked || row.expiresAt <= Date.now();
      const revoke = el(
        "button",
        {
          class: "quiet",
          onclick: () =>
            busy(
              revoke,
              async () => {
                await api("share.revoke", { id: row.id });
                await loadShares();
              },
              $("#share-status"),
            ),
        },
        "Revoke access",
      );
      list.append(
        el(
          "li",
          {},
          el("h3", { text: row.label }),
          el("p", { class: "break", text: row.recipient }),
          el("p", {
            class: "meta",
            text: `${row.fields.join(", ")} · ${row.accesses} access${row.accesses === 1 ? "" : "es"}`,
          }),
          el("p", {
            class: "meta",
            text: inactive
              ? "Expired or revoked"
              : `Expires ${new Date(row.expiresAt).toLocaleString()}`,
          }),
          inactive ? null : revoke,
        ),
      );
    }
  } catch (e) {
    notice($("#share-status"), e.message, true);
  }
}
$("#share-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(
    e.submitter,
    async () => {
      const f = new FormData(e.target);
      const result = await api("share.create", {
        recipient: f.get("recipient"),
        label: f.get("label"),
        hours: Number(f.get("hours")),
        fields: f.getAll("fields"),
        consent: f.has("shareConsent"),
      });
      const url =
        "https://liberpict.com/jericho-alliance/id#access=" + result.token;
      const input = el("input", {
        value: url,
        readonly: true,
        "aria-label": "Private access link",
        onclick: (e) => e.target.select(),
      });
      const copyButton = el(
        "button",
        {
          class: "quiet",
          type: "button",
          onclick: () => copy(url, $("#share-status")),
        },
        "Copy access link",
      );
      $("#share-link").replaceChildren(
        el("p", {
          class: "small",
          text: "Send this link privately to the named recipient. It is displayed only here.",
        }),
        input,
        el("div", { class: "actions" }, copyButton),
      );
      notice(
        $("#share-status"),
        "Access pass created. No message has been sent.",
      );
      await loadShares();
    },
    $("#share-status"),
  );
});
$("#close-profile").addEventListener("click", () => {
  const dialog = el("dialog", { "aria-label": "Close membership" }),
    status = el("p", { class: "status", role: "status" }),
    input = el("input", {
      "aria-label": "Type CLOSE to confirm",
      placeholder: "Type CLOSE",
      autocomplete: "off",
    });
  const confirm = el(
    "button",
    {
      class: "danger",
      onclick: () =>
        busy(
          confirm,
          async () => {
            if (input.value !== "CLOSE")
              throw new Error("Type CLOSE to confirm.");
            await api("profile.close", { confirmation: input.value });
            dialog.close();
            dialog.remove();
            location.assign("/jericho-alliance/id");
          },
          status,
        ),
    },
    "Close membership",
  );
  dialog.append(
    el("h2", {}, "Close your membership?"),
    el(
      "p",
      {},
      "This removes your profile details and revokes its QR and access passes. Shared negotiation records remain until their retention period ends. Your LIBER account is preserved. This membership cannot be reopened.",
    ),
    el(
      "p",
      { class: "small" },
      "For your protection, sign in again if your last sign-in was more than 15 minutes ago.",
    ),
    input,
    el(
      "div",
      { class: "actions" },
      confirm,
      el(
        "button",
        {
          class: "quiet",
          onclick: () => {
            dialog.close();
            dialog.remove();
          },
        },
        "Keep membership",
      ),
    ),
    status,
  );
  document.body.append(dialog);
  dialog.showModal();
});
await ready;
await authChanged();
