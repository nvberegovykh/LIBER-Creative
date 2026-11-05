import {
  $,
  el,
  shell,
  api,
  ready,
  state,
  memberCard,
  notice,
  busy,
  date,
  openAuth,
} from "./client.mjs";
shell("Profile");
$("#hero-card").append(memberCard({}, true));
function resultCard(profile) {
  const container = $("#lookup-result");
  container.replaceChildren();
  if (!profile)
    return container.append(
      el(
        "div",
        { class: "notice" },
        el("h3", {}, "No matching profile"),
        el(
          "p",
          {},
          "Check all 27 digits or ask the member for their current QR.",
        ),
      ),
    );
  const status = {
    verified: "Identity check completed",
    "self-declared": "Self-declared community profile",
    revoked: "This profile has been revoked",
    expired: "Identity check has expired",
  }[profile.status];
  container.append(
    el(
      "div",
      { class: "notice" },
      el("h3", {}, status),
      el(
        "p",
        { class: "break" },
        profile.japId
          ? `JAP ${profile.japId}`
          : "This profile has not been issued a verified JAP number.",
      ),
      profile.publicListing && profile.displayName
        ? el("p", {}, `${profile.displayName} · ${profile.community}`)
        : el("p", {}, "The member’s identity details are private."),
      profile.expiresAt
        ? el(
            "p",
            { class: "small" },
            `Verification valid through ${date(profile.expiresAt)}. Check the current status each time.`,
          )
        : null,
      el(
        "p",
        { class: "small" },
        "JAP is private community information. It does not establish government identification, citizenship, immigration status, or travel eligibility.",
      ),
    ),
  );
  if (profile.publicListing && profile.displayName) {
    const holder = el(
      "div",
      { class: "card-stage", style: "max-width:620px" },
      memberCard(profile),
    );
    container.append(holder);
  }
}
async function lookup(reference) {
  notice($("#lookup-status"), "Checking the live record…");
  const { profile } = await api("lookup", { reference }, true);
  resultCard(profile);
  notice(
    $("#lookup-status"),
    profile ? "Current record retrieved." : "No matching record.",
  );
}
$("#lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  busy(
    e.submitter,
    async () => {
      const value = $("#jap-number").value.trim();
      if (!/^\d{27}$/.test(value)) throw new Error("Enter exactly 27 digits.");
      await lookup(value);
      history.replaceState(null, "", "#jap=" + value);
    },
    $("#lookup-status"),
  );
});
async function loadHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const reference = params.get("jap") || params.get("p");
  if (reference) {
    if (/^\d{27}$/.test(reference)) $("#jap-number").value = reference;
    try {
      await lookup(reference);
      $("#lookup").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      notice($("#lookup-status"), e.message, true);
    }
  }
  const grant = params.get("access");
  if (grant) {
    const target = $("#lookup-result");
    target.replaceChildren(el("h2", {}, "Private access pass"));
    if (!state.user?.emailVerified) {
      target.append(
        el(
          "p",
          {},
          "Sign in with the email named by the member to open this access pass.",
        ),
        el("button", { onclick: openAuth }, "Sign in to view"),
      );
      return;
    }
    try {
      const opened = await api("share.open", { token: grant });
      target.append(
        el("p", {}, `Purpose: ${opened.purpose}`),
        el(
          "p",
          { class: "small" },
          `Access expires ${new Date(opened.expiresAt).toLocaleString()}.`,
        ),
      );
      const labels = {
        displayName: "Display name",
        community: "Community",
        legalName: "Verified legal name",
        dateOfBirth: "Verified date of birth",
      };
      const list = el("dl");
      for (const [field, value] of Object.entries(opened.fields))
        list.append(
          el("dt", { class: "small", text: labels[field] }),
          el("dd", {
            style: "margin:0 0 18px",
            text: value || "Not provided by verification result",
          }),
        );
      target.append(
        list,
        el(
          "p",
          { class: "small" },
          "Shared by the member for the stated purpose. Respect applicable restrictions on copying and onward use.",
        ),
      );
    } catch (e) {
      target.append(el("p", { class: "error", text: e.message }));
    }
    $("#lookup-result").scrollIntoView({ behavior: "smooth" });
  }
}
window.addEventListener("hashchange", loadHash);
window.addEventListener("jericho-auth", async () => {
  $("#profile-cta").textContent = state.user
    ? "My profile"
    : "Create your profile";
  if (state.user?.emailVerified) {
    try {
      const { profile } = await api("me");
      if (profile) $("#hero-card").replaceChildren(memberCard(profile));
    } catch (_) {
      /* Public lookup remains usable. */
    }
  } else $("#hero-card").replaceChildren(memberCard({}, true));
  if (new URLSearchParams(location.hash.slice(1)).has("access")) loadHash();
});
await ready;
await loadHash();
