import {
  $,
  el,
  shell,
  api,
  ready,
  state,
  notice,
  busy,
  date,
  authForm,
  verificationControls,
  download,
  copy,
  openAuth,
} from "/jericho-alliance/client.mjs";
shell("Negotiations");
let profile = null,
  current = null,
  pollTimer = null,
  editorDirty = false,
  sequence = 0;
const labels = {
  title: "What are you discussing?",
  partyA: "First party",
  representativeA: "Your representative name",
  mandateA: "Your authority and limits",
  partyB: "Other party",
  representativeB: "Other representative’s name",
  mandateB: "Their proposed authority and limits",
  jurisdiction: "Applicable law and process",
  baseline: "Shared starting record",
  boundaries: "Rights and participation boundaries",
  evidence: "Evidence and uncertainty",
  reviewer: "Neutral reviewer or expert",
  deadline: "Important deadlines",
};
const editor = $("#negotiation-editor"),
  status = $("#negotiation-status");
function field(
  name,
  label,
  { area = false, value = "", required = true, maxlength = 3000 } = {},
) {
  const id = "field-" + name;
  const input = el(area ? "textarea" : "input", {
    id,
    name,
    required,
    maxlength,
    ...(area ? {} : { type: "text" }),
  });
  input.value = value;
  return el(
    "div",
    { class: "field" },
    el("label", { for: id, text: label }),
    input,
  );
}
function check(name, label) {
  return el(
    "label",
    { class: "check" },
    el("input", { type: "checkbox", name, required: true }),
    el("span", {}, label),
  );
}
function submitForm(form, button, handler) {
  form.addEventListener("input", () => (editorDirty = true));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(button, () => handler(new FormData(form)), status);
  });
}
function setEditor(children) {
  editor.hidden = false;
  $("#negotiation-dashboard").hidden = true;
  editor.replaceChildren(...children);
  editorDirty = false;
}
function available() {
  if (!state.user?.emailVerified) {
    openAuth();
    return false;
  }
  if (!profile) {
    notice(
      status,
      "Create your community profile before starting or joining a negotiation.",
      true,
    );
    return false;
  }
  return true;
}
async function dashboard() {
  if (!state.user?.emailVerified || !profile) return;
  const { rooms } = await api("rooms.list");
  const list = $("#rooms-list");
  list.replaceChildren();
  if (!rooms.length)
    list.append(
      el(
        "li",
        {},
        el("h3", {}, "Your first conversation starts here."),
        el(
          "p",
          {},
          "Create a shared starting record, then send a private invitation to the other representative.",
        ),
      ),
    );
  for (const room of rooms) {
    list.append(
      el(
        "li",
        {},
        el(
          "h3",
          {},
          el("a", { href: "#case=" + room.caseId, text: room.title }),
        ),
        el("p", { text: `${room.partyA} / ${room.partyB}` }),
        el("p", {
          class: "meta",
          text: `${room.outcome || room.phase} · Updated ${date(room.updatedAt)} · Your side ${room.side.toUpperCase()}`,
        }),
      ),
    );
  }
  if (!current && !location.hash) {
    editor.hidden = true;
    $("#negotiation-dashboard").hidden = false;
  }
}
async function authChanged() {
  const thisSequence = ++sequence;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  current = null;
  const gate = $("#negotiation-gate");
  gate.replaceChildren();
  if (!state.user?.emailVerified) {
    profile = null;
    editor.hidden = true;
    $("#negotiation-dashboard").hidden = true;
    gate.append(
      state.user
        ? el(
            "div",
            { class: "notice" },
            el("p", {}, "Confirm your LIBER email to continue."),
            verificationControls(),
          )
        : el(
            "div",
            { class: "account-section" },
            el(
              "div",
              { class: "auth-box" },
              el("h2", {}, "Continue with your account"),
              authForm(),
            ),
          ),
    );
    return;
  }
  try {
    const data = await api("me");
    if (thisSequence !== sequence) return;
    profile = data.profile;
    if (!profile) {
      gate.append(
        el(
          "div",
          { class: "notice" },
          el("h3", {}, "Begin with your community profile."),
          el(
            "p",
            {},
            "A saved profile ties each action to its participating account.",
          ),
          el(
            "a",
            { class: "button", href: "/jericho-alliance/sip" },
            "Create my profile",
          ),
        ),
      );
      return;
    }
    await dashboard();
    await route();
    pollTimer = setInterval(async () => {
      if (!current || document.hidden) return;
      try {
        const data = await api("room.get", { caseId: current.caseId });
        if (data.room.version !== current.version) {
          if (editorDirty)
            notice(
              status,
              "The other participant has updated the record. Save your text before refreshing; the current screen has not been replaced.",
            );
          else renderRoom(data.room);
        }
      } catch (e) {
        notice(status, e.message, true);
      }
    }, 15000);
  } catch (e) {
    notice(status, e.message, true);
  }
}
function startForm() {
  if (!available()) return;
  current = null;
  history.replaceState(null, "", "#new");
  const form = el("form", { id: "room-create-form" }),
    button = el("button", { type: "submit" }, "Create private invitation");
  form.append(
    el("h2", {}, "Establish the starting record."),
    el(
      "p",
      {},
      "The other representative will review every field before joining. If they need changes, prepare a fresh invitation.",
    ),
    field("title", labels.title, { maxlength: 140 }),
    el(
      "div",
      { class: "field-grid" },
      field("partyA", labels.partyA, {
        value: profile.community,
        maxlength: 160,
      }),
      field("partyB", labels.partyB, { maxlength: 160 }),
    ),
    el(
      "div",
      { class: "field-grid", style: "margin-top:24px" },
      field("representativeA", labels.representativeA, {
        value: profile.displayName,
        maxlength: 160,
      }),
      field("representativeB", labels.representativeB, { maxlength: 160 }),
    ),
    el(
      "div",
      { class: "field-grid", style: "margin-top:24px" },
      field("mandateA", labels.mandateA, { area: true }),
      field("mandateB", labels.mandateB, { area: true }),
    ),
    field("jurisdiction", labels.jurisdiction, {
      value:
        "New York law; voluntary negotiation; access to counsel and courts preserved.",
    }),
    field("baseline", labels.baseline, { area: true, maxlength: 12000 }),
    field("boundaries", labels.boundaries, {
      area: true,
      value:
        "Participation is voluntary. Each side may decline or withdraw. No waiver of statutory rights or court deadlines is implied.",
    }),
    field("evidence", labels.evidence, { area: true, required: false }),
    field("reviewer", labels.reviewer, { required: false }),
    field("deadline", labels.deadline, { required: false }),
    check(
      "consent",
      "I am authorized to participate for the first party, accept this starting record, and understand that each side makes its own decisions.",
    ),
    el(
      "p",
      { class: "small" },
      "This private record is accessible to the participating accounts and service operators. Do not include unnecessary sensitive information. Invitation links expire in seven days. Records expire one year after the last action.",
    ),
    button,
  );
  submitForm(form, button, async (f) => {
    const setup = {};
    for (const key of Object.keys(labels)) setup[key] = f.get(key) || "";
    const result = await api("room.create", {
      setup,
      consent: f.has("consent"),
    });
    history.replaceState(null, "", "#case=" + result.room.caseId);
    renderRoom(result.room, result.invite);
    notice(status, "Private invitation created. No message has been sent.");
  });
  setEditor([form]);
  editor.scrollIntoView({ behavior: "smooth" });
}
function inviteLink(token) {
  const url = "https://liberpict.com/negotiations#join=" + token,
    input = el("input", {
      value: url,
      readonly: true,
      "aria-label": "Private invitation link",
      onclick: (e) => e.target.select(),
    });
  return el(
    "div",
    { class: "notice" },
    el("h3", {}, "Invite the other representative"),
    el(
      "p",
      {},
      "Send this link privately. Whoever receives it can view the proposed starting record after signing in. Only one other account can accept it.",
    ),
    input,
    el(
      "div",
      { class: "actions" },
      el(
        "button",
        { class: "quiet", onclick: () => copy(url, status) },
        "Copy invitation link",
      ),
    ),
    el(
      "p",
      { class: "small" },
      "This link expires in seven days. Creating a new link invalidates the previous one.",
    ),
  );
}
function baseline(setup) {
  const dl = el("dl");
  for (const key of Object.keys(labels)) {
    if (key === "title") continue;
    dl.append(
      el("dt", { text: labels[key] }),
      el("dd", { text: setup[key] || "Not recorded" }),
    );
  }
  return dl;
}
async function showInvite(token) {
  if (!available()) return;
  const invite = await api("invite.preview", { token }),
    form = el("form"),
    button = el(
      "button",
      { type: "submit" },
      "Accept starting record and join",
    );
  form.append(
    el("h2", { text: invite.setup.title }),
    el(
      "p",
      {},
      "You are invited as the second representative. Review the entire starting record. Accept only if the name, mandate, boundaries, and baseline are correct for you.",
    ),
    el(
      "div",
      { class: "room-side", style: "border:0;padding:0" },
      baseline(invite.setup),
    ),
    check(
      "consent",
      "I am the named second representative, have the stated authority, and freely accept this exact starting record and participation boundaries.",
    ),
    button,
  );
  submitForm(form, button, async (f) => {
    const { room } = await api("room.join", {
      token,
      consent: f.has("consent"),
    });
    history.replaceState(null, "", "#case=" + room.caseId);
    renderRoom(room);
    notice(status, "You joined through your own LIBER account.");
  });
  setEditor([form]);
  editor.scrollIntoView({ behavior: "smooth" });
}
function roomAction(type, payload, extra = {}) {
  return api("room.action", {
    caseId: current.caseId,
    expectedVersion: current.version,
    type,
    payload,
    ...extra,
  });
}
function exportRoom() {
  download(
    `UNP-${current.caseId}.json`,
    JSON.stringify(
      {
        schema: "jericho.unp.account-record.v1",
        exportedAt: new Date().toISOString(),
        channel: "pict.jericho.v1",
        note: "Server-recorded account actions; no independent attestation of legal authority. A partial correction-phase export excludes the other account’s sealed correction.",
        ...current,
      },
      null,
      2,
    ),
  );
}
function report() {
  const lines = [
    "JERICHO ALLIANCE / UNIVERSAL NEGOTIATION PROTOCOL",
    current.setup.title,
    `Case ${current.caseId}`,
    `Outcome: ${current.state.outcome || current.state.phase}`,
    "Account-authenticated actions recorded by the LIBER service. Legal authority and enforceability are not independently certified.",
    "",
    ...Object.entries(current.setup)
      .filter(([k]) => labels[k])
      .map(([k, v]) => `${labels[k]}\n${v || "Not recorded"}\n`),
  ];
  for (const side of ["a", "b"])
    lines.push(
      `Correction ${side.toUpperCase()}\n${current.state.revisions?.[side]?.text || "Not available in this view"}\n`,
    );
  if (current.state.frozen)
    for (const [key, value] of Object.entries(current.state.frozen))
      if (typeof value === "string") lines.push(`${key}\n${value}\n`);
  lines.push(`Frozen package SHA-256: ${current.fingerprint || "Not frozen"}`);
  for (const side of ["a", "b"])
    lines.push(
      `Decision ${side.toUpperCase()}: ${current.state.decisions?.[side]?.choice || "Pending"}\n${current.state.decisions?.[side]?.note || ""}`,
    );
  lines.push(
    "ACCOUNT EVENT HISTORY",
    ...current.authEvents.map(
      (e) =>
        `${new Date(e.at).toISOString()} / ${e.side.toUpperCase()} / ${e.action}`,
    ),
  );
  download(`UNP-${current.caseId}.txt`, lines.join("\n\n"), "text/plain");
}
function renderRoom(room, token = null) {
  current = room;
  editorDirty = false;
  notice(status, "");
  const main = el("section"),
    side = el(
      "aside",
      { class: "room-side" },
      el("h3", {}, "Shared starting record"),
      baseline(room.setup),
    );
  const refresh = el(
    "button",
    {
      class: "quiet",
      onclick: () =>
        busy(
          refresh,
          async () => {
            if (
              editorDirty &&
              !confirm(
                "Refresh will replace unsaved text on this screen. Continue?",
              )
            )
              return;
            editor.classList.add("loading");
            editor.setAttribute("aria-busy", "true");
            editor
              .querySelectorAll("input,textarea,select")
              .forEach((control) => (control.disabled = true));
            try {
              const data = await api("room.get", { caseId: room.caseId });
              renderRoom(data.room);
            } finally {
              editor.classList.remove("loading");
              editor.removeAttribute("aria-busy");
              editor
                .querySelectorAll("input,textarea,select")
                .forEach((control) => (control.disabled = false));
            }
          },
          status,
        ),
    },
    "Refresh",
  );
  const toolbar = el(
    "div",
    { class: "room-toolbar" },
    el(
      "div",
      {},
      el("p", {
        class: "phase-label",
        text: `Your side ${room.side.toUpperCase()} · ${room.state.phase}`,
      }),
      el("h2", { text: room.setup.title }),
    ),
    el(
      "div",
      { class: "actions", style: "margin:0" },
      refresh,
      el(
        "a",
        { class: "button quiet", href: "/negotiations" },
        "All negotiations",
      ),
    ),
  );
  const phase = room.state.phase;
  if (phase === "invitation") {
    main.append(
      el("h3", {}, "Waiting for the second representative"),
      el(
        "p",
        {},
        "The first party has accepted the proposed baseline. The correction round opens when the other representative accepts it through their own account.",
      ),
    );
    if (token) main.append(inviteLink(token));
    else {
      const button = el(
        "button",
        {
          onclick: () =>
            busy(
              button,
              async () => {
                const result = await api("room.invite", {
                  caseId: room.caseId,
                  expectedVersion: room.version,
                });
                renderRoom(result.room, result.invite);
              },
              status,
            ),
        },
        "Create a new invitation link",
      );
      main.append(button);
    }
  }
  if (phase === "corrections") {
    main.append(
      el("h3", {}, "One thoughtful correction."),
      el(
        "p",
        {},
        "Make one correction to your starting position, or keep it. Your text stays hidden from the other account until both sides finish this round.",
      ),
    );
    const own = room.state.revisions[room.side];
    if (own)
      main.append(
        el(
          "div",
          { class: "notice" },
          el("h3", {}, "Your correction is sealed"),
          el("p", { class: "text-record", text: own.text }),
          el(
            "p",
            { class: "small" },
            "Waiting for the other representative. Refresh or return later.",
          ),
        ),
      );
    else {
      const form = el("form"),
        select = el(
          "select",
          { name: "choice", id: "correction-choice" },
          el("option", { value: "revise" }, "Make a correction"),
          el("option", { value: "keep" }, "Keep the starting position"),
        );
      const textField = field("text", "Your correction", {
        area: true,
        maxlength: 12000,
      });
      const textarea = textField.querySelector("textarea");
      select.addEventListener("change", () => {
        textField.hidden = select.value === "keep";
        textarea.required = select.value !== "keep";
      });
      const button = el("button", { type: "submit" }, "Submit my correction");
      form.append(
        el("label", { for: "correction-choice" }, "Your choice"),
        select,
        textField,
        el(
          "p",
          { class: "small" },
          "You have one submission in this round. Read it carefully before submitting.",
        ),
        button,
      );
      submitForm(form, button, async (f) => {
        const result = await roomAction("revision", {
          choice: f.get("choice"),
          text: f.get("text"),
        });
        renderRoom(result.room);
      });
      main.append(form);
    }
    if (room.state.otherSubmitted)
      main.append(
        el(
          "p",
          { class: "small", style: "margin-top:20px" },
          "The other side has submitted. Their correction will be revealed when you submit yours.",
        ),
      );
  }
  if (["package", "decisions", "closed"].includes(phase) && room.record) {
    const revisions = el("div", { class: "pair" });
    for (const s of ["a", "b"])
      revisions.append(
        el(
          "section",
          {},
          el("h3", {}, `Side ${s.toUpperCase()} correction`),
          el("p", {
            class: "text-record",
            text: room.state.revisions[s]?.text || "No correction submitted",
          }),
        ),
      );
    main.append(revisions);
  }
  if (phase === "package") {
    const form = el("form"),
      button = el("button", { type: "submit" }, "Freeze exact terms");
    form.append(
      el("h3", { style: "margin-top:30px" }, "Prepare the agreement space"),
      el(
        "p",
        {},
        "Either representative may propose the exact package. Freezing preserves these terms for separate decisions; it does not accept them for either party.",
      ),
      field("terms", "Proposed terms", { area: true, maxlength: 12000 }),
      field("unresolved", "What remains unresolved", {
        area: true,
        maxlength: 12000,
      }),
      field("implementation", "Responsibilities, dates, remedies, and review", {
        area: true,
        maxlength: 12000,
      }),
      field("review", "Expert review, or reason for proceeding without it", {
        area: true,
        maxlength: 12000,
      }),
      check(
        "reviewConfirmed",
        "I have considered each side’s rights, authority, and review needs. These exact terms are ready for separate decisions.",
      ),
      button,
    );
    submitForm(form, button, async (f) => {
      const payload = {};
      for (const k of ["terms", "unresolved", "implementation", "review"])
        payload[k] = f.get(k);
      payload.reviewConfirmed = f.has("reviewConfirmed");
      const result = await roomAction("freeze", payload);
      renderRoom(result.room);
    });
    main.append(form);
    const close = el(
      "button",
      {
        class: "quiet",
        style: "margin-top:18px",
        onclick: () =>
          reasonDialog(
            "no-agreement",
            "Close without agreement",
            "Both corrections remain in the record. Neither side is required to agree.",
          ),
      },
      "Close with no common agreement",
    );
    main.append(close);
  }
  if (room.state.frozen) {
    const box = el(
      "section",
      { class: "package" },
      el("h3", {}, "The frozen package"),
    );
    const names = {
      terms: "Proposed terms",
      unresolved: "Unresolved issues",
      implementation: "Responsibilities and review",
      review: "Expert review",
    };
    for (const [k, label] of Object.entries(names))
      box.append(
        el("h3", { text: label }),
        el("p", { class: "text-record", text: room.state.frozen[k] }),
      );
    box.append(
      el("p", { class: "small" }, "Package fingerprint"),
      el("p", { class: "receipt", text: room.fingerprint }),
    );
    main.append(box);
  }
  if (phase === "decisions") {
    const own = room.state.decisions[room.side];
    if (own)
      main.append(
        el(
          "div",
          { class: "notice" },
          el("h3", {}, `You recorded: ${own.choice}`),
          el("p", {}, "The other representative makes their own decision."),
        ),
      );
    else {
      const form = el("form"),
        select = el(
          "select",
          { name: "choice", id: "decision-choice" },
          el("option", { value: "accept" }, "Accept these exact terms"),
          el("option", { value: "decline" }, "Decline these terms"),
        ),
        button = el("button", { type: "submit" }, "Record my decision");
      form.append(
        el("h3", {}, "Your decision"),
        el("label", { for: "decision-choice" }, "Choose freely"),
        select,
        field("note", "Your note (optional)", { area: true, required: false }),
        check(
          "confirmed",
          "I have read this exact frozen package and am recording my own decision within my authority.",
        ),
        button,
      );
      submitForm(form, button, async (f) => {
        const result = await roomAction(
          "decision",
          {
            choice: f.get("choice"),
            note: f.get("note"),
            confirmed: f.has("confirmed"),
          },
          { fingerprint: room.fingerprint },
        );
        renderRoom(result.room);
      });
      main.append(form);
    }
    const other = room.side === "a" ? "b" : "a";
    if (room.state.decisions[other])
      main.append(
        el("p", {
          class: "small",
          style: "margin-top:20px",
          text: `The other side recorded: ${room.state.decisions[other].choice}.`,
        }),
      );
  }
  if (phase === "closed") {
    main.append(
      el(
        "div",
        { class: "notice" },
        el("h3", { text: room.state.outcome }),
        el(
          "p",
          {},
          "This round is closed. Keep your export for reference. A new round requires a fresh starting record and consent.",
        ),
      ),
    );
    if (room.withdrawalReason)
      main.append(
        el("p", { class: "text-record", text: room.withdrawalReason }),
      );
    for (const s of ["a", "b"])
      if (room.state.decisions?.[s])
        main.append(
          el("h3", {
            text: `Side ${s.toUpperCase()}: ${room.state.decisions[s].choice}`,
          }),
          el("p", {
            class: "text-record",
            text: room.state.decisions[s].note || "",
          }),
        );
  }
  const history = el("ol", { class: "history" });
  for (const event of room.authEvents)
    history.append(
      el(
        "li",
        {},
        `Side ${event.side.toUpperCase()} · ${event.action.replaceAll(".", " ")}`,
        el("small", { text: new Date(event.at).toLocaleString() }),
      ),
    );
  side.append(
    el("h3", {}, "Recorded actions"),
    history,
    el(
      "p",
      { class: "small" },
      "Actions are tied to the participating LIBER account. This does not independently verify a representative’s mandate.",
    ),
  );
  const actions = el(
    "div",
    { class: "actions" },
    el("button", { class: "quiet", onclick: exportRoom }, "Download record"),
    el("button", { class: "quiet", onclick: report }, "Download report"),
  );
  if (phase !== "closed")
    actions.append(
      el(
        "button",
        {
          class: "quiet",
          onclick: () =>
            reasonDialog(
              "withdraw",
              "Withdraw from this round",
              "Withdrawal closes this round and preserves the record.",
            ),
        },
        "Withdraw",
      ),
    );
  main.append(actions);
  setEditor([toolbar, el("div", { class: "room-layout" }, main, side)]);
}
function reasonDialog(type, title, description) {
  const dialog = el("dialog", { "aria-label": title }),
    form = el("form"),
    message = el("p", { class: "status", role: "status" }),
    button = el("button", { type: "submit", class: "danger" }, title);
  form.append(
    el("h2", { text: title }),
    el("p", { text: description }),
    field("reason", "Reason", { area: true, maxlength: 2000 }),
    el(
      "div",
      { class: "actions" },
      button,
      el(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: () => {
            dialog.close();
            dialog.remove();
          },
        },
        "Continue negotiation",
      ),
    ),
    message,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(
      button,
      async () => {
        const result = await roomAction(type, {
          reason: new FormData(form).get("reason"),
        });
        dialog.close();
        dialog.remove();
        renderRoom(result.room);
      },
      message,
    );
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}
function invitationDialog() {
  const dialog = el("dialog", { "aria-label": "Open invitation" }),
    form = el("form"),
    button = el("button", { type: "submit" }, "Open invitation"),
    message = el("p", { class: "status", role: "status" });
  form.append(
    el("h2", {}, "Open a private invitation"),
    field("link", "Paste the invitation link", { maxlength: 500 }),
    el(
      "div",
      { class: "actions" },
      button,
      el(
        "button",
        {
          class: "quiet",
          type: "button",
          onclick: () => {
            dialog.close();
            dialog.remove();
          },
        },
        "Cancel",
      ),
    ),
    message,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(
      button,
      async () => {
        const value = new FormData(form).get("link").trim();
        let token = value;
        if (value.includes("://")) {
          const url = new URL(value);
          if (url.origin !== "https://liberpict.com")
            throw new Error("Use a liberpict.com invitation.");
          token = new URLSearchParams(url.hash.slice(1)).get("join");
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(token || ""))
          throw new Error("Check the invitation link.");
        dialog.close();
        dialog.remove();
        location.hash = "join=" + token;
      },
      message,
    );
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}
async function route() {
  if (!profile) return;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("case")) {
      const { room } = await api("room.get", { caseId: params.get("case") });
      renderRoom(room);
    } else if (params.has("join")) await showInvite(params.get("join"));
    else if (location.hash === "#new") startForm();
    else {
      current = null;
      editor.hidden = true;
      $("#negotiation-dashboard").hidden = false;
      await dashboard();
    }
  } catch (e) {
    notice(status, e.message, true);
  }
}
$("#new-negotiation").addEventListener("click", startForm);
$("#open-invitation").addEventListener("click", () => {
  if (available()) invitationDialog();
});
$("#refresh-rooms").addEventListener("click", (e) =>
  busy(e.currentTarget, dashboard, status),
);
window.addEventListener("jericho-auth", authChanged);
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (event) => {
  if (editorDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
await ready;
await authChanged();
