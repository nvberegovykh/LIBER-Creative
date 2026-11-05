export const SCHEMA = "jericho.unp.facilitated-record.v1";
export const SOURCE =
  "https://research.liberpict.com/liberty-power/#universal-negotiation-protocol-interface";
const SIDES = ["a", "b"];
const SETUP_FIELDS = [
  "title",
  "partyA",
  "representativeA",
  "mandateA",
  "partyB",
  "representativeB",
  "mandateB",
  "jurisdiction",
  "baseline",
  "boundaries",
  "evidence",
  "reviewer",
  "deadline",
];
const REQUIRED_SETUP = SETUP_FIELDS.filter(
  (field) => !["evidence", "reviewer", "deadline"].includes(field),
);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, label, required = true) {
  requireCondition(typeof value === "string", `${label} must be text.`);
  const result = value.trim();
  requireCondition(result.length <= 12000, `${label} is too long.`);
  requireCondition(!required || result.length > 0, `${label} is required.`);
  return result;
}

function time(value) {
  requireCondition(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Invalid record time.",
  );
  return value;
}

export function createRecord(input, caseId, createdAt) {
  requireCondition(
    /^[a-zA-Z0-9-]{8,80}$/.test(caseId),
    "Invalid case reference.",
  );
  const setup = {};
  for (const field of SETUP_FIELDS)
    setup[field] = text(
      input[field] ?? "",
      field,
      REQUIRED_SETUP.includes(field),
    );
  requireCondition(
    input.consentA === true && input.consentB === true,
    "Record informed participation and approval of the same starting record for both sides.",
  );
  setup.consentA = true;
  setup.consentB = true;
  return {
    schema: SCHEMA,
    caseId,
    createdAt: time(createdAt),
    setup,
    events: [],
  };
}

function initialState(record) {
  return {
    phase: "corrections",
    revisions: { a: null, b: null },
    frozen: null,
    decisions: { a: null, b: null },
    outcome: null,
  };
}

function transition(state, event) {
  requireCondition(
    state.phase !== "closed",
    "This record is closed. Start a new session with fresh consent.",
  );
  const payload = event.payload;
  if (event.type === "revision") {
    requireCondition(
      state.phase === "corrections",
      "The correction round has ended.",
    );
    requireCondition(SIDES.includes(payload.side), "Choose a valid side.");
    requireCondition(
      !state.revisions[payload.side],
      "Each side has one correction in this round.",
    );
    requireCondition(
      ["revise", "keep"].includes(payload.choice),
      "Choose a correction or keep the position.",
    );
    state.revisions[payload.side] = {
      choice: payload.choice,
      text:
        payload.choice === "keep"
          ? "Keep the starting position."
          : text(payload.text, "Correction"),
    };
    if (state.revisions.a && state.revisions.b) state.phase = "package";
  } else if (event.type === "freeze") {
    requireCondition(
      state.phase === "package",
      "Both sides must finish the correction round first.",
    );
    requireCondition(
      payload.reviewConfirmed === true,
      "Confirm the review and rights check before freezing.",
    );
    state.frozen = {
      terms: text(payload.terms, "Proposed terms"),
      unresolved: text(payload.unresolved, "Remaining disagreements"),
      implementation: text(
        payload.implementation,
        "Responsibilities and review",
      ),
      review: text(
        payload.review,
        "Expert review or reason for proceeding without it",
      ),
      reviewConfirmed: true,
    };
    state.phase = "decisions";
  } else if (event.type === "decision") {
    requireCondition(
      state.phase === "decisions",
      "Freeze the exact package before recording a decision.",
    );
    requireCondition(SIDES.includes(payload.side), "Choose a valid side.");
    requireCondition(
      !state.decisions[payload.side],
      "This side has already made its recorded decision.",
    );
    requireCondition(
      ["accept", "decline"].includes(payload.choice),
      "Choose accept or decline.",
    );
    requireCondition(
      payload.confirmed === true,
      "Confirm that the representative reviewed this exact package.",
    );
    state.decisions[payload.side] = {
      choice: payload.choice,
      note: text(payload.note ?? "", "Decision note", false),
    };
    if (state.decisions.a && state.decisions.b) {
      state.phase = "closed";
      state.outcome =
        state.decisions.a.choice === "accept" &&
        state.decisions.b.choice === "accept"
          ? "Both sides recorded acceptance"
          : "Closed without mutual acceptance";
    }
  } else if (event.type === "withdraw") {
    requireCondition(
      SIDES.includes(payload.side),
      "Choose the withdrawing side.",
    );
    text(payload.reason, "Withdrawal reason");
    state.phase = "closed";
    state.outcome = `Side ${payload.side.toUpperCase()} withdrew`;
  } else if (event.type === "no-agreement") {
    requireCondition(
      state.phase === "package",
      "Complete the correction round before recording an empty agreement space.",
    );
    text(payload.reason, "Closure reason");
    state.phase = "closed";
    state.outcome = "Closed with no common agreement";
  } else {
    throw new Error("Unknown protocol action.");
  }
  return state;
}

function cleanPayload(type, payload) {
  requireCondition(
    payload && typeof payload === "object" && !Array.isArray(payload),
    "Invalid action payload.",
  );
  const fields = {
    revision: ["side", "choice", "text"],
    freeze: [
      "terms",
      "unresolved",
      "implementation",
      "review",
      "reviewConfirmed",
    ],
    decision: ["side", "choice", "note", "confirmed"],
    withdraw: ["side", "reason"],
    "no-agreement": ["reason"],
  }[type];
  requireCondition(fields, "Unknown action type.");
  const result = {};
  for (const key of fields) {
    if (Object.hasOwn(payload, key)) {
      requireCondition(
        ["string", "boolean"].includes(typeof payload[key]),
        "Invalid action field.",
      );
      if (typeof payload[key] === "string")
        requireCondition(
          payload[key].length <= 12000,
          "Action field is too long.",
        );
      result[key] = payload[key];
    }
  }
  return result;
}

export function getState(record) {
  return record.events.reduce(
    (state, event) => transition(state, event),
    initialState(record),
  );
}

export function appendEvent(record, type, payload, at) {
  const event = {
    type,
    payload: cleanPayload(type, payload),
    at: time(at),
    recordedBy: "facilitator-unverified",
  };
  const lastTime = record.events.at(-1)?.at || record.createdAt;
  requireCondition(
    Date.parse(event.at) >= Date.parse(lastTime),
    "The record time must follow the previous event.",
  );
  transition(getState(record), event);
  return { ...record, events: [...record.events, event] };
}

export function importRecord(input) {
  requireCondition(
    input?.schema === SCHEMA,
    "This file is not a supported UNP record.",
  );
  requireCondition(
    Array.isArray(input.events) && input.events.length <= 8,
    "Invalid number of protocol events.",
  );
  let record = createRecord(input.setup, input.caseId, input.createdAt);
  for (const event of input.events)
    record = appendEvent(record, event.type, event.payload, event.at);
  return record;
}

export function packageText(record) {
  const state = getState(record);
  if (!state.frozen) return null;
  return JSON.stringify({
    schema: SCHEMA,
    caseId: record.caseId,
    setup: record.setup,
    revisions: state.revisions,
    frozen: state.frozen,
  });
}

export function reportText(record, fingerprint = "") {
  const state = getState(record);
  const lines = [
    "JERICHO ALLIANCE / UNIVERSAL NEGOTIATION PROTOCOL",
    "Facilitator-entered working record",
    `Case ${record.caseId}`,
    `Created ${record.createdAt}`,
    `Status ${state.outcome || state.phase}`,
    "",
    "This file records unverified entries. It does not authenticate signatures or determine legal enforceability.",
    "",
    "STARTING RECORD",
  ];
  for (const field of SETUP_FIELDS)
    lines.push(`${field}\n${record.setup[field] || "(not recorded)"}\n`);
  lines.push("CORRECTION ROUND");
  for (const side of SIDES)
    lines.push(
      `Side ${side.toUpperCase()}\n${state.revisions[side]?.text || "(pending)"}\n`,
    );
  if (state.frozen) {
    lines.push(
      "FROZEN PACKAGE",
      `SHA-256 ${fingerprint}`,
      "The fingerprint checks content consistency only.",
    );
    for (const key of ["terms", "unresolved", "implementation", "review"])
      lines.push(`${key}\n${state.frozen[key]}\n`);
  }
  lines.push("DECISIONS");
  for (const side of SIDES)
    lines.push(
      `Side ${side.toUpperCase()}\n${state.decisions[side]?.choice || "(pending)"}\n${state.decisions[side]?.note || ""}\n`,
    );
  lines.push("EVENT HISTORY");
  for (const event of record.events)
    lines.push(
      `${event.at} / ${event.type}\n${JSON.stringify(event.payload)}\n`,
    );
  lines.push(`Research ${SOURCE}`);
  return lines.join("\n");
}
