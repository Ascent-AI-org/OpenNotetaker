import test from "node:test";
import assert from "node:assert/strict";
import { parseNotesEmailSelection, isExternalRecipient, SELECTION_LIMITS } from "../src/domain/notes-email-selection.js";

const meeting = {
  id: "m1",
  status: "completed",
  artifacts: {
    notes: { summary: "s", decisions: ["d"], actionItems: [{ task: "t", owner: "o", due: "d" }] },
    normalizedSegments: [
      { id: "seg-1", speaker: "Speaker 1", start: 0, end: 2, english: "hello" },
      { id: "seg-2", speaker: "Speaker 2", start: 2, end: 4, english: "world" }
    ]
  }
};
const base = { recipients: ["a@b.com"], sections: { summary: true } };

test("accepts a minimal valid selection", () => {
  const r = parseNotesEmailSelection(base, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.recipients, ["a@b.com"]);
  assert.equal(r.value.sections.summary, true);
  assert.equal(r.value.sections.transcript, false);
});

test("rejects a transcript edit keyed to a segment from another meeting", () => {
  const r = parseNotesEmailSelection(
    { ...base, sections: { transcript: true }, transcript: { includeIds: ["seg-1"], edits: { "not-mine": "injected" } } },
    meeting,
    { ownerDomains: [] }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_segment");
});

test("rejects includeIds naming a segment from another meeting", () => {
  const r = parseNotesEmailSelection(
    { ...base, sections: { transcript: true }, transcript: { includeIds: ["seg-1", "seg-999"] } },
    meeting,
    { ownerDomains: [] }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "unknown_segment");
});

test("requires confirmExternal when any recipient is outside the owner's domains", () => {
  const r = parseNotesEmailSelection(base, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "external_not_confirmed");

  const ok = parseNotesEmailSelection({ ...base, confirmExternal: true }, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.externalRecipients, ["a@b.com"]);
});

test("does not require confirmExternal when every recipient is internal", () => {
  const r = parseNotesEmailSelection(base, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
});

test("rejects an empty recipient list and more than the cap", () => {
  assert.equal(parseNotesEmailSelection({ ...base, recipients: [] }, meeting, {}).code, "no_recipients");
  const many = Array.from({ length: 26 }, (_, i) => `u${i}@b.com`);
  assert.equal(parseNotesEmailSelection({ ...base, recipients: many, confirmExternal: true }, meeting, {}).code, "too_many_recipients");
});

test("drops malformed addresses rather than passing them to the mailer", () => {
  const r = parseNotesEmailSelection({ ...base, recipients: ["a@b.com", "not-an-email", "  "] }, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.recipients, ["a@b.com"]);
});

test("clamps every free-text field at its documented cap", () => {
  const long = "x".repeat(50_000);
  const r = parseNotesEmailSelection(
    { ...base, subject: long, intro: long, signoff: long, summaryOverride: long },
    meeting,
    { ownerDomains: ["b.com"] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.subject.length, SELECTION_LIMITS.subject);
  assert.equal(r.value.intro.length, SELECTION_LIMITS.intro);
  assert.equal(r.value.signoff.length, SELECTION_LIMITS.signoff);
  assert.equal(r.value.summaryOverride.length, SELECTION_LIMITS.summary);
  // Pin the literal cap values from the spec, so a regression in the constant does not pass silently.
  assert.equal(r.value.subject.length, 200);
  assert.equal(r.value.intro.length, 2000);
  assert.equal(r.value.signoff.length, 2000);
  assert.equal(r.value.summaryOverride.length, 8000);
});

test("clamps a per-turn edit at its cap", () => {
  const r = parseNotesEmailSelection(
    { ...base, sections: { transcript: true }, transcript: { includeIds: ["seg-1"], edits: { "seg-1": "y".repeat(9999) } } },
    meeting,
    { ownerDomains: ["b.com"] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.transcript.edits["seg-1"].length, SELECTION_LIMITS.turnEdit);
  // Pin the literal cap value from the spec.
  assert.equal(r.value.transcript.edits["seg-1"].length, 2000);
});

test("unknown section keys are ignored rather than passed through", () => {
  const r = parseNotesEmailSelection({ ...base, sections: { summary: true, evil: true } }, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  assert.equal("evil" in r.value.sections, false);
});

test("exactly MAX_RECIPIENTS (25) is accepted, and 26 is rejected", () => {
  const exactly25 = Array.from({ length: 25 }, (_, i) => `u${i}@b.com`);
  const r = parseNotesEmailSelection({ ...base, recipients: exactly25, confirmExternal: true }, meeting, {});
  assert.equal(r.ok, true);
  assert.equal(r.value.recipients.length, 25);

  const exceed25 = Array.from({ length: 26 }, (_, i) => `u${i}@b.com`);
  const r2 = parseNotesEmailSelection({ ...base, recipients: exceed25, confirmExternal: true }, meeting, {});
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "too_many_recipients");
});

test("confirmExternal must be boolean true, not just truthy", () => {
  // String "true" is truthy but not boolean true
  const r1 = parseNotesEmailSelection({ ...base, confirmExternal: "true" }, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "external_not_confirmed");

  // Number 1 is truthy but not boolean true
  const r2 = parseNotesEmailSelection({ ...base, confirmExternal: 1 }, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "external_not_confirmed");

  // Empty object is truthy but not boolean true
  const r3 = parseNotesEmailSelection({ ...base, confirmExternal: {} }, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "external_not_confirmed");

  // Only boolean true succeeds
  const r4 = parseNotesEmailSelection({ ...base, confirmExternal: true }, meeting, { ownerDomains: ["ostryaai.com"] });
  assert.equal(r4.ok, true);
});

test("__proto__ in sections object does not appear as a key and does not throw", () => {
  const malicious = { ...base, sections: { summary: true, __proto__: { evil: "POLLUTED" } } };
  // The attacker wants to inject __proto__ as a key to pollute the prototype chain
  const r = parseNotesEmailSelection(malicious, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  // Verify __proto__ does not appear as a string key in the own properties (the injection fails)
  assert.equal(Object.prototype.hasOwnProperty.call(r.value.sections, "__proto__"), false);
  // Verify only SECTION_KEYS are present
  const keys = Object.keys(r.value.sections);
  assert.equal(keys.every((k) => ["summary", "decisions", "actionItems", "openQuestions", "risks", "transcript", "rawEvidence"].includes(k)), true);
});

test("__proto__ in transcript.edits does not appear as a key and does not throw", () => {
  const malicious = { ...base, sections: { transcript: true }, transcript: { includeIds: ["seg-1"], edits: { "seg-1": "text", __proto__: { evil: "POLLUTED" } } } };
  // The attacker wants to inject __proto__ as a key in edits
  const r = parseNotesEmailSelection(malicious, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  // Verify __proto__ does not appear as a string key in the own properties (the injection fails)
  assert.equal(Object.prototype.hasOwnProperty.call(r.value.transcript.edits, "__proto__"), false);
  // Verify only validated segment ids are present
  const keys = Object.keys(r.value.transcript.edits);
  assert.equal(keys.every((k) => ["seg-1", "seg-2"].includes(k)), true);
});

test("isExternalRecipient compares domains case-insensitively", () => {
  assert.equal(isExternalRecipient("a@B.com", ["b.com"]), false);
  assert.equal(isExternalRecipient("a@other.com", ["b.com"]), true);
  assert.equal(isExternalRecipient("a@b.com", []), true);
});

test("tolerates a body that is not an object", () => {
  for (const junk of [null, undefined, "string", 42, []]) {
    assert.equal(parseNotesEmailSelection(junk, meeting, {}).ok, false);
  }
});
