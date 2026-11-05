import {
  createRecord,
  appendEvent,
  importRecord,
  getState,
  packageText,
  reportText,
} from "./protocol.mjs";

const $ = (selector) => document.querySelector(selector);
let record = null;
let fingerprint = "";
let unsaved = false;
const labels = {
  title: "Case title",
  partyA: "Side A",
  representativeA: "Representative A",
  mandateA: "Mandate A",
  partyB: "Side B",
  representativeB: "Representative B",
  mandateB: "Mandate B",
  jurisdiction: "Jurisdiction and process",
  baseline: "Shared starting record",
  boundaries: "Boundaries and rights",
  evidence: "Evidence and uncertainty",
  reviewer: "Agreed reviewer",
  deadline: "Deadlines",
  terms: "Proposed terms",
  unresolved: "Unresolved disagreements",
  implementation: "Responsibilities and review",
  review: "Neutral review and corrections",
};

function message(value) {
  $("#message").textContent = value;
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function fields(form) {
  const result = Object.fromEntries(new FormData(form));
  for (const input of form.querySelectorAll('input[type="checkbox"]'))
    result[input.name] = input.checked;
  return result;
}

function definitionList(target, values) {
  target.replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    if (!labels[key]) continue;
    target.append(
      element("dt", labels[key]),
      element("dd", value || "Not recorded"),
    );
  }
}

async function digest(candidate) {
  const payload = packageText(candidate);
  if (!payload) return "";
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function control(labelText, name, type = "textarea") {
  const label = element("label", labelText);
  const input = document.createElement(type);
  input.name = name;
  input.maxLength = 12000;
  label.append(input);
  return { label, input };
}

function button(label, callback, quiet = false) {
  const node = element("button", label, quiet ? "quiet" : undefined);
  node.type = "button";
  node.addEventListener("click", callback);
  return node;
}

function sideLabel(side) {
  return `Side ${side.toUpperCase()} · ${record.setup[side === "a" ? "partyA" : "partyB"]}`;
}

async function act(type, payload) {
  try {
    record = appendEvent(record, type, payload, new Date().toISOString());
    unsaved = true;
    await render();
    message("Action recorded. Save the updated record to keep a copy.");
  } catch (error) {
    message(error.message);
  }
}

function renderRevisionForms(state) {
  const target = $("#revision-forms");
  target.replaceChildren();
  for (const side of ["a", "b"]) {
    const panel = element("section", undefined, "side-panel");
    panel.append(element("h4", sideLabel(side)));
    if (state.revisions[side]) {
      panel.append(
        element(
          "p",
          "Correction submitted. Its text will appear when both sides have submitted.",
        ),
      );
    } else {
      const form = document.createElement("form");
      const correction = control("Correction to the starting position", "text");
      correction.input.required = true;
      form.append(correction.label);
      const submit = element("button", "Submit this correction");
      submit.type = "submit";
      form.append(submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (form.reportValidity())
          void act("revision", {
            side,
            choice: "revise",
            text: correction.input.value,
          });
      });
      const actions = element("div", undefined, "actions");
      actions.append(
        button(
          "Keep the starting position",
          () => void act("revision", { side, choice: "keep" }),
          true,
        ),
      );
      panel.append(form, actions);
    }
    target.append(panel);
  }
}

function renderDecisions(state) {
  const target = $("#decision-forms");
  target.replaceChildren();
  for (const side of ["a", "b"]) {
    const panel = element("section", undefined, "side-panel");
    panel.append(element("h4", sideLabel(side)));
    if (state.decisions[side]) {
      panel.append(
        element("p", `Recorded choice — ${state.decisions[side].choice}`),
      );
    } else {
      const form = document.createElement("form");
      const note = control("Decision note or reason", "note");
      const confirmed = element("label", undefined, "check");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "confirmed";
      checkbox.required = true;
      confirmed.append(
        checkbox,
        element(
          "span",
          "The representative reviewed the exact frozen package and communicated this choice.",
        ),
      );
      const actions = element("div", undefined, "actions");
      for (const choice of ["accept", "decline"]) {
        actions.append(
          button(
            choice === "accept" ? "Record acceptance" : "Record refusal",
            () => {
              if (form.reportValidity())
                void act("decision", {
                  side,
                  choice,
                  confirmed: checkbox.checked,
                  note: note.input.value,
                });
            },
            choice === "decline",
          ),
        );
      }
      form.append(note.label, confirmed, actions);
      panel.append(form);
    }
    target.append(panel);
  }
}

async function render() {
  const renderingRecord = record;
  const state = record ? getState(record) : null;
  $("#setup-form").hidden = Boolean(record);
  $("#active-session").hidden = !record;
  $("#export-json").disabled = !record;
  $("#export-text").disabled = !record;
  for (const item of document.querySelectorAll("[data-phase]")) {
    item.removeAttribute("aria-current");
    if (item.dataset.phase === (state?.phase || "setup"))
      item.setAttribute("aria-current", "step");
  }
  if (!record) return;
  $("#workspace-title").textContent =
    state.outcome ||
    {
      corrections: "Hear each side",
      package: "Find the agreement space",
      decisions: "Choose on exact terms",
    }[state.phase];
  $("#case-title").textContent = record.setup.title;
  $("#case-id").textContent = record.caseId;
  definitionList($("#starting-record"), record.setup);
  $("#corrections").hidden = state.phase !== "corrections";
  if (state.phase === "corrections") renderRevisionForms(state);
  const revealed = Boolean(state.revisions.a && state.revisions.b);
  $("#revisions").hidden = !revealed;
  if (revealed) {
    const target = $("#revision-results");
    target.replaceChildren();
    for (const side of ["a", "b"]) {
      const panel = element("section", undefined, "side-panel");
      panel.append(
        element("h4", sideLabel(side)),
        element("p", state.revisions[side].text),
      );
      target.append(panel);
    }
  }
  $("#package-form").hidden = state.phase !== "package";
  $("#frozen-package").hidden = !state.frozen;
  if (state.frozen) {
    definitionList($("#package-display"), state.frozen);
    const renderedFingerprint = await digest(renderingRecord);
    if (record !== renderingRecord) return;
    fingerprint = renderedFingerprint;
    $("#fingerprint").textContent = fingerprint;
  }
  $("#decisions").hidden = state.phase !== "decisions";
  if (state.phase === "decisions") renderDecisions(state);
  $("#outcome").hidden = state.phase !== "closed";
  $("#withdrawal").hidden = state.phase === "closed";
  if (state.phase === "closed") {
    $("#outcome-title").textContent = state.outcome;
    $("#decision-summary").replaceChildren();
    for (const side of ["a", "b"]) {
      $("#decision-summary").append(
        element(
          "p",
          `${sideLabel(side)} — ${state.decisions[side]?.choice || "No final acceptance recorded"}`,
        ),
      );
    }
  }
  $("#event-history").replaceChildren(
    ...record.events.map((event) =>
      element(
        "li",
        `${event.at} · ${event.type}${event.payload.side ? ` · Side ${event.payload.side.toUpperCase()}` : ""} · Facilitator entry`,
      ),
    ),
  );
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  try {
    record = createRecord(
      fields(event.currentTarget),
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    unsaved = true;
    await render();
    message(
      "Starting record fixed. Each side may now make one correction or keep its position.",
    );
  } catch (error) {
    message(error.message);
  }
});

$("#package-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.currentTarget.reportValidity())
    void act("freeze", fields(event.currentTarget));
});
$("#no-agreement").addEventListener(
  "click",
  () =>
    void act("no-agreement", {
      reason: $('#package-form [name="closureReason"]').value,
    }),
);
$("#withdraw-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.currentTarget.reportValidity())
    void act("withdraw", fields(event.currentTarget));
});

function download(contents, extension, mime) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `UNP-${record.caseId}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#export-json").addEventListener("click", async () => {
  try {
    const exportedRecord = record;
    const exportedFingerprint = await digest(exportedRecord);
    download(
      JSON.stringify(
        {
          ...exportedRecord,
          fingerprint: exportedFingerprint,
          notice:
            "Unverified facilitator record. This file contains entered case information, including submitted corrections.",
        },
        null,
        2,
      ),
      "json",
      "application/json",
    );
    if (record === exportedRecord) unsaved = false;
    message("Record exported. Store and share the file deliberately.");
  } catch (error) {
    message(error.message);
  }
});
$("#export-text").addEventListener("click", async () => {
  try {
    const exportedRecord = record;
    download(
      reportText(exportedRecord, await digest(exportedRecord)),
      "txt",
      "text/plain;charset=utf-8",
    );
    message(
      "Readable report exported. Use Save record for a file that can be reopened.",
    );
  } catch (error) {
    message(error.message);
  }
});
$("#import-button").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 512000)
      throw new Error("Choose a record smaller than 500 KB.");
    const raw = JSON.parse(await file.text());
    const imported = importRecord(raw);
    const importedFingerprint = await digest(imported);
    if (raw.fingerprint !== importedFingerprint)
      throw new Error(
        "The file fingerprint does not match its package. Check the source file.",
      );
    if (
      record &&
      !confirm(
        "Replace the current tab record? Save it first if you need to keep it.",
      )
    )
      return;
    record = imported;
    unsaved = false;
    await render();
    message(
      "Imported as an unverified facilitator record. Confirm its contents with the participants.",
    );
  } catch (error) {
    message(`Could not open record. ${error.message}`);
  } finally {
    event.target.value = "";
  }
});

$("#new-session").addEventListener("click", async () => {
  if (
    !confirm(
      "Start a new session? Save the current record first if you need to retain it.",
    )
  )
    return;
  record = null;
  fingerprint = "";
  unsaved = false;
  $("#setup-form").reset();
  $("#package-form").reset();
  $("#withdraw-form").reset();
  $("#workspace-title").textContent = "Prepare the shared record";
  await render();
  message("New session. Both sides must consent to the new starting record.");
});
window.addEventListener("beforeunload", (event) => {
  if (!unsaved) return;
  event.preventDefault();
  event.returnValue = "";
});
