import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecord,
  appendEvent,
  getState,
  importRecord,
  packageText,
  reportText,
} from "./protocol.mjs";

const setup = {
  title: "Shared garden",
  partyA: "Member A",
  representativeA: "Rep A",
  mandateA: "Written limited mandate",
  partyB: "Member B",
  representativeB: "Rep B",
  mandateB: "Written limited mandate",
  jurisdiction: "New York",
  baseline: "Different preferred work hours",
  boundaries: "Existing access rights",
  evidence: "Schedule",
  reviewer: "Agreed facilitator",
  deadline: "2026-11-20",
  consentA: true,
  consentB: true,
};
const at = "2026-11-05T12:00:00.000Z";
const fresh = () => createRecord(setup, "case-test-123", at);
const add = (record, type, payload) => appendEvent(record, type, payload, at);
function prepared() {
  let record = add(fresh(), "revision", { side: "a", choice: "keep" });
  return add(record, "revision", {
    side: "b",
    choice: "revise",
    text: "Work before 6 pm",
  });
}
function frozen() {
  return add(prepared(), "freeze", {
    terms: "Work before 6 pm",
    unresolved: "Weekend schedule",
    implementation: "Review in 14 days",
    review: "Both sides accepted neutral review",
    reviewConfirmed: true,
  });
}
test("fresh consent and representative mandates are required", () => {
  assert.throws(() =>
    createRecord({ ...setup, consentB: false }, "case-test-123", at),
  );
  assert.throws(() =>
    createRecord({ ...setup, mandateA: " " }, "case-test-123", at),
  );
});
test("one correction per side, both needed before a package", () => {
  const record = add(fresh(), "revision", { side: "a", choice: "keep" });
  assert.equal(getState(record).phase, "corrections");
  assert.throws(() => add(record, "revision", { side: "a", choice: "keep" }));
  assert.throws(() => add(record, "freeze", {}));
  assert.equal(getState(prepared()).phase, "package");
});
test("exact package stays frozen during separate consent decisions", () => {
  let record = frozen();
  const snapshot = packageText(record);
  assert.throws(() => add(record, "freeze", { terms: "Changed terms" }));
  assert.throws(() =>
    add(record, "decision", { side: "a", choice: "accept", confirmed: false }),
  );
  record = add(record, "decision", {
    side: "a",
    choice: "accept",
    confirmed: true,
  });
  assert.equal(getState(record).phase, "decisions");
  assert.throws(() =>
    add(record, "decision", { side: "a", choice: "decline", confirmed: true }),
  );
  record = add(record, "decision", {
    side: "b",
    choice: "accept",
    confirmed: true,
  });
  assert.equal(getState(record).outcome, "Both sides recorded acceptance");
  assert.equal(packageText(record), snapshot);
  assert.throws(() => add(record, "revision", { side: "a", choice: "keep" }));
});
test("refusal, withdrawal, and empty agreement remain valid outcomes", () => {
  let record = add(frozen(), "decision", {
    side: "a",
    choice: "decline",
    confirmed: true,
  });
  record = add(record, "decision", {
    side: "b",
    choice: "accept",
    confirmed: true,
  });
  assert.equal(getState(record).outcome, "Closed without mutual acceptance");
  assert.equal(
    getState(
      add(fresh(), "withdraw", {
        side: "b",
        reason: "Need independent advice",
      }),
    ).phase,
    "closed",
  );
  assert.equal(
    getState(add(prepared(), "no-agreement", { reason: "No common ground" }))
      .outcome,
    "Closed with no common agreement",
  );
});
test("import replays protocol constraints and retains dissent", () => {
  const record = frozen();
  assert.deepEqual(importRecord(JSON.parse(JSON.stringify(record))), record);
  assert.match(reportText(record, "abc"), /Weekend schedule/);
  const tampered = structuredClone(record);
  tampered.events.unshift(tampered.events[0]);
  assert.throws(() => importRecord(tampered));
  assert.throws(() => importRecord({ schema: "other" }));
  assert.throws(() =>
    add(fresh(), "revision", { side: "__proto__", choice: "keep" }),
  );
});
