import test from "node:test";
import assert from "node:assert/strict";
import { renderNotesEmail, selectedTranscriptTurns } from "../src/domain/notes-email-render.js";

const meeting = {
  id: "m1",
  title: "Ostrya x Athul",
  meetUrl: "https://meet.google.com/abc-defg-hij",
  scheduledAt: "2026-08-27T12:48:00.000Z",
  artifacts: {
    notes: {
      summary: "Original summary.",
      decisions: ["Ship on Friday"],
      actionItems: [{ task: "Send figures", owner: "Ishaan", due: "tonight" }],
      openQuestions: ["What is the conversion rate?"],
      risks: ["Tire kickers on sales calls"]
    },
    normalizedSegments: [
      { id: "s1", speaker: "Dhruv", start: 0, end: 2, english: "Let us start." },
      { id: "s2", speaker: "Ishaan", start: 2, end: 4, english: "An internal aside." },
      { id: "s3", speaker: "Dhruv", start: 4, end: 6, english: "The gap is revenue." }
    ]
  }
};

const selection = (over = {}) => ({
  recipients: ["a@b.com"], externalRecipients: [], subject: "", intro: "", signoff: "",
  sections: { summary: false, decisions: false, actionItems: false, openQuestions: false, risks: false, transcript: false, rawEvidence: false },
  summaryOverride: null, decisions: null, actionItems: null,
  transcript: { includeIds: [], edits: {} },
  ...over
});

test("includes only the sections that were selected", () => {
  const out = renderNotesEmail({ meeting, selection: selection({ sections: { ...selection().sections, summary: true } }) });
  assert.match(out.text, /Original summary\./);
  assert.doesNotMatch(out.text, /Tire kickers/);
  assert.doesNotMatch(out.text, /What is the conversion rate/);
});

test("a deselected risks section appears in neither the text nor the html part", () => {
  const out = renderNotesEmail({ meeting, selection: selection({ sections: { ...selection().sections, summary: true, risks: false } }) });
  assert.doesNotMatch(out.text, /Tire kickers/);
  assert.doesNotMatch(out.html, /Tire kickers/);
});

test("an edited summary replaces the stored one without mutating the meeting", () => {
  const sel = selection({ sections: { ...selection().sections, summary: true }, summaryOverride: "Corrected summary." });
  const out = renderNotesEmail({ meeting, selection: sel });
  assert.match(out.text, /Corrected summary\./);
  assert.doesNotMatch(out.text, /Original summary\./);
  assert.equal(meeting.artifacts.notes.summary, "Original summary.");
});

test("only the included transcript turns are rendered", () => {
  const sel = selection({ sections: { ...selection().sections, transcript: true }, transcript: { includeIds: ["s1", "s3"], edits: {} } });
  const out = renderNotesEmail({ meeting, selection: sel });
  assert.match(out.text, /Let us start\./);
  assert.match(out.text, /The gap is revenue\./);
  assert.doesNotMatch(out.text, /An internal aside\./);
  assert.doesNotMatch(out.html, /An internal aside\./);
});

test("a per-turn edit replaces that turn's text only", () => {
  const sel = selection({
    sections: { ...selection().sections, transcript: true },
    transcript: { includeIds: ["s1", "s3"], edits: { s1: "Rewritten opening." } }
  });
  const turns = selectedTranscriptTurns(meeting, sel);
  assert.deepEqual(turns.map((t) => t.text), ["Rewritten opening.", "The gap is revenue."]);
  assert.equal(meeting.artifacts.normalizedSegments[0].english, "Let us start.");
});

test("escapes html in every edited field so an edit cannot inject markup", () => {
  const sel = selection({
    sections: { ...selection().sections, summary: true, transcript: true },
    summaryOverride: "<script>alert(1)</script>",
    intro: "<img src=x onerror=alert(1)>",
    transcript: { includeIds: ["s1"], edits: { s1: "<b>bold</b>" } }
  });
  const out = renderNotesEmail({ meeting, selection: sel });
  assert.doesNotMatch(out.html, /<script>/);
  // The payload must be inert, not absent: escaping neutralises the angle brackets, so
  // the characters "onerror=" legitimately survive as text. What must never appear is a
  // live tag built from an edited field.
  assert.doesNotMatch(out.html, /<img/);
  assert.match(out.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(out.html, /<b>bold<\/b>/);
  assert.match(out.html, /&lt;script&gt;/);
});

test("intro and signoff appear when set and are absent when empty", () => {
  const withText = renderNotesEmail({ meeting, selection: selection({ intro: "Hi Ishaan,", signoff: "Best, Dhruv" }) });
  assert.match(withText.text, /Hi Ishaan,/);
  assert.match(withText.text, /Best, Dhruv/);
  const without = renderNotesEmail({ meeting, selection: selection() });
  assert.doesNotMatch(without.text, /Hi Ishaan,/);
});

test("falls back to a derived subject when none was given", () => {
  assert.equal(renderNotesEmail({ meeting, selection: selection() }).subject, "Notes: Ostrya x Athul");
  assert.equal(renderNotesEmail({ meeting, selection: selection({ subject: "Custom" }) }).subject, "Custom");
});

test("refuses to render a body past the size ceiling", () => {
  const segments = Array.from({ length: 4000 }, (_, i) => ({
    id: `h${i}`, speaker: "S", start: i, end: i + 1, english: "x".repeat(200)
  }));
  const huge = { ...meeting, artifacts: { ...meeting.artifacts, normalizedSegments: segments } };
  const sel = selection({
    sections: { ...selection().sections, transcript: true },
    transcript: { includeIds: segments.map((seg) => seg.id), edits: {} }
  });
  assert.throws(() => renderNotesEmail({ meeting: huge, selection: sel }), /too large/);
});

test("renders with no notes at all rather than throwing", () => {
  const bare = { id: "m2", title: "Bare", artifacts: {} };
  const out = renderNotesEmail({ meeting: bare, selection: selection({ sections: { ...selection().sections, summary: true, transcript: true } }) });
  assert.equal(typeof out.text, "string");
  assert.equal(typeof out.html, "string");
});
