# Notes Email Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a meeting's owner choose which sections and which transcript turns to send, edit any of them, pick arbitrary recipients, preview the exact email, and send it — with a record of what went to whom.

**Architecture:** The browser POSTs a *selection* (section flags, transcript turn IDs, per-turn text overrides, capped free text). The server re-renders the email from the stored meeting plus that selection and sends it via the owner's connected Gmail. The same renderer serves `?preview=1`, so preview and delivery cannot drift. Edits are per-send: `artifacts.notes` is never modified.

**Tech Stack:** Node 22 ESM, zero runtime dependencies (only `playwright-core` exists and is unrelated), `node --test`, vanilla DOM in `public/app.js`.

**Spec:** `docs/superpowers/specs/2026-08-27-notes-email-composer-design.md`

## Global Constraints

- **No new npm dependencies.** `package.json` has exactly one (`playwright-core`). Use `node:` builtins only.
- **Node 22, ESM** (`"type": "module"`). No TypeScript, no build step.
- `npm run check` (`scripts/check-syntax.mjs`) must pass; it parses everything under `src/` and `scripts/`.
- `npm test` must pass. Baseline before this work: **289 passing**.
- **Comment style:** comments explain *why* / what trap is avoided, never what the line does. Read `src/domain/runner-jobs.js` and `src/domain/note-delivery.js` for the voice to match.
- **`src/server.js` gains route dispatch and auth only.** All rendering and validation logic lives in `src/domain/`.
- **Owner-scoped routes return 404, never 403**, for both "missing" and "not yours" (`getOwnedMeeting`).
- **Never mutate `artifacts.notes`** from any code in this plan. Edits are per-send.
- Caps, copied verbatim from the spec: subject 200, intro 2000, signoff 2000, per-turn edit 2000, summary override 8000, recipients 25 (`MAX_RECIPIENTS` in `src/domain/note-delivery.js`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/notes-sections.js` | **New.** Every per-section formatter (text + HTML), extracted from `transcript-email.js` so the auto-email and the composer share one definition. |
| `src/domain/transcript-email.js` | **Modified.** Keeps `buildTranscriptEmail` / `formatTranscriptEmail` / `formatTranscriptEmailHtml`; their section formatting now comes from `notes-sections.js`. |
| `src/domain/notes-email-selection.js` | **New.** Pure validation and clamping of the request body against a specific meeting. |
| `src/domain/notes-email-render.js` | **New.** Pure `(meeting, selection) → { subject, text, html }`. |
| `src/server.js` | **Modified.** One route, `POST /api/meetings/:id/notes-email`, with `?preview=1`. Auth, rate limit, send, audit. |
| `public/app.js`, `public/index.html`, `public/styles.css` | **Modified.** The composer dialog. |
| `test/notes-email-selection.test.js` | **New.** |
| `test/notes-email-render.test.js` | **New.** |
| `test/notes-email-integration.test.js` | **New.** |

---

## Task 1: Extract shared section formatters

**Files:**
- Create: `src/domain/notes-sections.js`
- Modify: `src/domain/transcript-email.js`
- Test: `test/pipeline.test.js` (existing, must pass **unchanged** — that is the proof of no behaviour change)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `escapeHtml(value) -> string`
  - `formatDate(value) -> string`
  - `formatTimestampRange(start, end) -> string`
  - `formatActionItemsText(items) -> string`
  - `formatListText(items) -> string`
  - `formatCleanTranscriptText(segments) -> string`
  - `formatRoleTranscriptText(transcript) -> string`
  - `formatRawTranscriptText(segments) -> string`
  - `formatActionItemsHtml(items) -> string`
  - `formatListHtml(items) -> string`
  - `formatTranscriptRowsHtml(segments) -> string`

- [ ] **Step 1: Read the file being refactored end to end**

Run: `sed -n '1,348p' src/domain/transcript-email.js`

Every private helper in that file (`formatActionItems`, `formatList`, `formatCleanTranscript`, `formatRoleTranscript`, `formatRawTranscript`, `formatTimestampRange`, `formatDate`, and the HTML equivalents) moves. Note their exact current output — the existing tests assert on it.

- [ ] **Step 2: Run the existing tests and record the baseline**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `pass 289`, `fail 0`. Write the number down; it must be identical at the end of this task.

- [ ] **Step 3: Create the new module by moving the helpers verbatim**

Create `src/domain/notes-sections.js`. Move each helper's body **without changing a character of its output**, add `export`, and head the file with:

```js
// Every per-section formatter for meeting-notes email, in one place.
//
// These were private to transcript-email.js, which built exactly one email. The composer
// renders a different subset of the same sections, and a second copy of "how a decisions
// list looks" would drift from this one the first time either changed — leaving a preview
// that does not match what the automatic email sends.
```

- [ ] **Step 4: Point transcript-email.js at the new module**

Delete the moved helpers from `src/domain/transcript-email.js` and add at the top:

```js
import {
  escapeHtml,
  formatDate,
  formatTimestampRange,
  formatActionItemsText,
  formatListText,
  formatCleanTranscriptText,
  formatRoleTranscriptText,
  formatRawTranscriptText,
  formatActionItemsHtml,
  formatListHtml,
  formatTranscriptRowsHtml
} from "./notes-sections.js";
```

Update call sites to the new names (`formatActionItems` → `formatActionItemsText`, etc.).

- [ ] **Step 5: Verify nothing changed**

Run: `node scripts/check-syntax.mjs && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: parses cleanly, `pass 289`, `fail 0`. **If any test fails, the move was not verbatim — fix the formatter, do not edit the test.**

- [ ] **Step 6: Commit**

```bash
git add src/domain/notes-sections.js src/domain/transcript-email.js
git commit -m "Extract the notes email section formatters

The composer renders a different subset of the same sections, and a second copy
of how each one looks would drift from this one the first time either changed."
```

---

## Task 2: Selection parsing and validation

**Files:**
- Create: `src/domain/notes-email-selection.js`
- Test: `test/notes-email-selection.test.js`

**Interfaces:**
- Consumes: `MAX_RECIPIENTS` from `src/domain/note-delivery.js`; `parseActionItems` from `src/domain/action-items.js`.
- Produces:
  - `SECTION_KEYS: string[]`
  - `SELECTION_LIMITS: { subject, intro, signoff, turnEdit, summary }`
  - `isExternalRecipient(email, ownerDomains) -> boolean`
  - `parseNotesEmailSelection(body, meeting, { ownerDomains }) -> { ok: true, value } | { ok: false, code, error }`
  - `value` shape:
    ```js
    { recipients: string[], externalRecipients: string[],
      subject: string, intro: string, signoff: string,
      sections: Record<SECTION_KEY, boolean>,
      summaryOverride: string | null,
      decisions: string[] | null,
      actionItems: object[] | null,
      transcript: { includeIds: string[], edits: Record<string,string> } }
    ```

- [ ] **Step 1: Write the failing tests**

Create `test/notes-email-selection.test.js`:

```js
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
});

test("clamps a per-turn edit at its cap", () => {
  const r = parseNotesEmailSelection(
    { ...base, sections: { transcript: true }, transcript: { includeIds: ["seg-1"], edits: { "seg-1": "y".repeat(9999) } } },
    meeting,
    { ownerDomains: ["b.com"] }
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.transcript.edits["seg-1"].length, SELECTION_LIMITS.turnEdit);
});

test("unknown section keys are ignored rather than passed through", () => {
  const r = parseNotesEmailSelection({ ...base, sections: { summary: true, evil: true } }, meeting, { ownerDomains: ["b.com"] });
  assert.equal(r.ok, true);
  assert.equal("evil" in r.value.sections, false);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/notes-email-selection.test.js`
Expected: FAIL — `Cannot find module '../src/domain/notes-email-selection.js'`

- [ ] **Step 3: Implement the module**

Create `src/domain/notes-email-selection.js`:

```js
// What the composer is allowed to ask for.
//
// The request describes a SELECTION, never a finished email: the server renders from the
// stored meeting, so the message's shape is always this app's. That leaves exactly two
// things a caller controls — which of its own meeting's content to include, and a few
// short edited strings — and this module is where both are bounded.
//
// Pure on purpose. Deciding who receives mail and what it contains is the one mistake in
// this area that cannot be taken back, so it is testable without sending anything.
import { MAX_RECIPIENTS } from "./note-delivery.js";
import { parseActionItems } from "./action-items.js";

export const SECTION_KEYS = [
  "summary",
  "decisions",
  "actionItems",
  "openQuestions",
  "risks",
  "transcript",
  "rawEvidence"
];

export const SELECTION_LIMITS = {
  subject: 200,
  intro: 2000,
  signoff: 2000,
  turnEdit: 2000,
  summary: 8000
};

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

export function isExternalRecipient(email, ownerDomains = []) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  if (!domain) return true;
  return !ownerDomains.map((d) => String(d || "").toLowerCase()).includes(domain);
}

export function parseNotesEmailSelection(body, meeting, { ownerDomains = [] } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("invalid_body", "Expected a selection object.");
  }

  const recipients = dedupe(
    toArray(body.recipients)
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => EMAIL_PATTERN.test(value))
  );
  if (!recipients.length) return fail("no_recipients", "Add at least one valid recipient.");
  if (recipients.length > MAX_RECIPIENTS) {
    return fail("too_many_recipients", `At most ${MAX_RECIPIENTS} recipients.`);
  }

  // Enforced here rather than only in the UI: a stale tab, or any caller that never saw
  // the warning, must not be able to skip it.
  const externalRecipients = recipients.filter((email) => isExternalRecipient(email, ownerDomains));
  if (externalRecipients.length && body.confirmExternal !== true) {
    return fail("external_not_confirmed", `Confirm sending outside your organisation: ${externalRecipients.join(", ")}.`);
  }

  const sections = {};
  for (const key of SECTION_KEYS) sections[key] = body.sections?.[key] === true;

  const segments = meeting?.artifacts?.normalizedSegments || meeting?.artifacts?.rawSegments || [];
  const knownIds = new Set(segments.map((segment) => segment.id));

  const rawIncludeIds = toArray(body.transcript?.includeIds).map((value) => String(value || ""));
  // An id that is not this meeting's is the injection path this check exists to close:
  // without it a caller can attach arbitrary prose to an invented id and have the server
  // render and send it under this app's own template.
  for (const id of rawIncludeIds) {
    if (!knownIds.has(id)) return fail("unknown_segment", `Segment ${id} is not part of this meeting.`);
  }

  const edits = {};
  const rawEdits = body.transcript?.edits;
  if (rawEdits && typeof rawEdits === "object" && !Array.isArray(rawEdits)) {
    for (const [id, text] of Object.entries(rawEdits)) {
      if (!knownIds.has(id)) return fail("unknown_segment", `Segment ${id} is not part of this meeting.`);
      edits[id] = clamp(text, SELECTION_LIMITS.turnEdit);
    }
  }

  let actionItems = null;
  if (Array.isArray(body.actionItems)) {
    const parsed = parseActionItems(body.actionItems);
    if (!parsed.ok) return fail("validation_error", parsed.error);
    actionItems = parsed.value;
  }

  return {
    ok: true,
    value: {
      recipients,
      externalRecipients,
      subject: clamp(body.subject, SELECTION_LIMITS.subject),
      intro: clamp(body.intro, SELECTION_LIMITS.intro),
      signoff: clamp(body.signoff, SELECTION_LIMITS.signoff),
      sections,
      summaryOverride: body.summaryOverride === undefined ? null : clamp(body.summaryOverride, SELECTION_LIMITS.summary),
      decisions: Array.isArray(body.decisions)
        ? body.decisions.map((item) => clamp(item, SELECTION_LIMITS.turnEdit)).filter(Boolean)
        : null,
      actionItems,
      transcript: { includeIds: rawIncludeIds, edits }
    }
  };
}

function fail(code, error) {
  return { ok: false, code, error };
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function dedupe(values) {
  return [...new Set(values)];
}

function clamp(value, max) {
  return String(value ?? "").slice(0, max);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/notes-email-selection.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/notes-email-selection.js test/notes-email-selection.test.js
git commit -m "Bound what the composer is allowed to ask for

An edit keyed to a segment id from another meeting is the one way a caller could
put arbitrary prose inside this app's own template, so an unknown id is refused
rather than rendered."
```

---

## Task 3: The renderer

**Files:**
- Create: `src/domain/notes-email-render.js`
- Test: `test/notes-email-render.test.js`

**Interfaces:**
- Consumes: everything exported by `src/domain/notes-sections.js` (Task 1); the `value` shape from `parseNotesEmailSelection` (Task 2).
- Produces:
  - `selectedTranscriptTurns(meeting, selection) -> Array<{ id, speaker, start, end, text }>`
  - `renderNotesEmail({ meeting, selection }) -> { subject, text, html }`

- [ ] **Step 1: Write the failing tests**

Create `test/notes-email-render.test.js`:

```js
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
  assert.doesNotMatch(out.html, /onerror=/);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/notes-email-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the renderer**

Create `src/domain/notes-email-render.js`:

```js
// Turns a validated selection into the exact email that will be sent.
//
// This is also what ?preview=1 returns. One renderer for both is the point: a preview
// that can drift from the delivery is worse than no preview at all, because the drift is
// invisible until a recipient already has the wrong thing.
//
// Reads the meeting; never writes it. Composer edits are per-send by design, so the
// captured record stays exactly what the pipeline produced.
import {
  escapeHtml,
  formatDate,
  formatTimestampRange,
  formatActionItemsText,
  formatListText,
  formatRawTranscriptText,
  formatActionItemsHtml,
  formatListHtml,
  formatTranscriptRowsHtml
} from "./notes-sections.js";

// Well under Gmail's own message limit, so an oversized send fails in this app with an
// actionable message rather than at the provider.
const MAX_BODY_CHARS = 400_000;
const MAX_BODY_HTML_CHARS = 900_000;

export function selectedTranscriptTurns(meeting, selection) {
  const segments = meeting?.artifacts?.normalizedSegments || meeting?.artifacts?.rawSegments || [];
  const included = new Set(selection.transcript?.includeIds || []);
  const edits = selection.transcript?.edits || {};
  return segments
    .filter((segment) => included.has(segment.id))
    .map((segment) => ({
      id: segment.id,
      speaker: segment.speaker || "Speaker",
      start: segment.start,
      end: segment.end,
      // The edit wins when present, including when it is an empty string: clearing a
      // turn's text is a legitimate way to redact one line without dropping the turn.
      text: Object.hasOwn(edits, segment.id) ? edits[segment.id] : segment.english || segment.text || segment.raw || ""
    }));
}

export function renderNotesEmail({ meeting, selection }) {
  const notes = meeting?.artifacts?.notes || {};
  const s = selection.sections || {};
  const subject = selection.subject || `Notes: ${meeting?.title || "Meeting"}`;
  const summary = selection.summaryOverride ?? notes.summary ?? "";
  const decisions = selection.decisions ?? notes.decisions ?? [];
  const actionItems = selection.actionItems ?? notes.actionItems ?? [];
  const turns = s.transcript ? selectedTranscriptTurns(meeting, selection) : [];

  const text = [];
  if (selection.intro) text.push(selection.intro, "");
  text.push(meeting?.title || "Meeting", "");
  if (meeting?.meetUrl) text.push(`Meet: ${meeting.meetUrl}`);
  if (meeting?.scheduledAt) text.push(`Scheduled: ${formatDate(meeting.scheduledAt)}`);
  text.push("");
  if (s.summary) text.push("SUMMARY", summary || "No summary was generated.", "");
  if (s.decisions) text.push("DECISIONS", formatListText(decisions), "");
  if (s.actionItems) text.push("ACTION ITEMS", formatActionItemsText(actionItems), "");
  if (s.openQuestions) text.push("OPEN QUESTIONS", formatListText(notes.openQuestions), "");
  if (s.risks) text.push("RISKS", formatListText(notes.risks), "");
  if (s.transcript) {
    text.push("TRANSCRIPT");
    text.push(
      turns.length
        ? turns.map((t) => `[${formatTimestampRange(t.start, t.end)}] ${t.speaker}: ${t.text}`).join("\n")
        : "No transcript turns were selected."
    );
    text.push("");
  }
  if (s.rawEvidence) text.push("RAW TRANSCRIPT EVIDENCE", formatRawTranscriptText(meeting?.artifacts?.rawSegments || []), "");
  if (selection.signoff) text.push(selection.signoff);

  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#172033;max-width:720px">`,
    selection.intro ? `<p>${escapeHtml(selection.intro).replace(/\n/g, "<br>")}</p>` : "",
    `<h1 style="font-size:20px;margin:16px 0 4px">${escapeHtml(meeting?.title || "Meeting")}</h1>`,
    meeting?.scheduledAt ? `<p style="color:#667;margin:0 0 16px">${escapeHtml(formatDate(meeting.scheduledAt))}</p>` : "",
    s.summary ? section("Summary", `<p>${escapeHtml(summary)}</p>`) : "",
    s.decisions ? section("Decisions", formatListHtml(decisions)) : "",
    s.actionItems ? section("Action items", formatActionItemsHtml(actionItems)) : "",
    s.openQuestions ? section("Open questions", formatListHtml(notes.openQuestions || [])) : "",
    s.risks ? section("Risks", formatListHtml(notes.risks || [])) : "",
    s.transcript ? section("Transcript", formatTranscriptRowsHtml(turns)) : "",
    s.rawEvidence ? section("Raw transcript evidence", `<pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(formatRawTranscriptText(meeting?.artifacts?.rawSegments || []))}</pre>`) : "",
    selection.signoff ? `<p style="margin-top:24px">${escapeHtml(selection.signoff).replace(/\n/g, "<br>")}</p>` : "",
    `</div>`
  ].join("");

  // A ceiling on the whole rendered body. A 685-turn transcript is already tens of
  // thousands of characters, and a provider-side rejection tells the operator nothing they
  // can act on — fail here, naming the thing to deselect.
  const body = { subject, text: text.join("\n"), html };
  if (body.text.length > MAX_BODY_CHARS || body.html.length > MAX_BODY_HTML_CHARS) {
    const error = new Error("The composed email is too large to send. Send fewer transcript turns.");
    error.code = "body_too_large";
    throw error;
  }
  return body;
}

function section(title, inner) {
  return `<h3 style="margin:24px 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667">${escapeHtml(title)}</h3>${inner}`;
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/notes-email-render.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/notes-email-render.js test/notes-email-render.test.js
git commit -m "Render the composed notes email

The same renderer answers ?preview=1 and the send, because a preview that can
drift from the delivery hides the drift until a recipient has the wrong thing."
```

---

## Task 4: The endpoint

**Files:**
- Modify: `src/server.js`
- Test: `test/notes-email-integration.test.js`

**Interfaces:**
- Consumes: `parseNotesEmailSelection` (Task 2), `renderNotesEmail` (Task 3), existing `requireUser`, `getOwnedMeeting`, `readJsonBody`, `sendJson`, `SlidingWindowRateLimiter`, `listGoogleAccounts`, `pickSendingAccount`, `userGoogleTokenPath`, `hasUsableGmailToken`, `createMimeMessage`, `sendGmailMessage`.
- Produces: `POST /api/meetings/:id/notes-email` and `POST /api/meetings/:id/notes-email?preview=1`.

- [ ] **Step 1: Write the failing integration test**

Create `test/notes-email-integration.test.js`, modelled on `test/server-integration.test.js` (read it first for the temp-`DATA_DIR` server boot helper). Cover:

```js
test("preview renders without sending and matches what a send would produce", async (t) => {
  // boot server, sign up, create a completed meeting with notes + 3 segments
  const preview = await post(`/api/meetings/${id}/notes-email?preview=1`, selection);
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.match(body.text, /SUMMARY/);
  // nothing recorded, because nothing was sent
  const after = await get(`/api/meetings/${id}`);
  assert.equal((await after.json()).meeting.delivery?.notesEmail, undefined);
});

test("a non-owner gets 404, not 403", async (t) => { /* second account, same meeting id */ });

test("an unknown segment id is rejected with 400", async (t) => { /* edits: { "nope": "x" } */ });

test("an external recipient without confirmExternal is refused", async (t) => { /* expect 409 external_not_confirmed */ });

test("a meeting that is not completed is refused", async (t) => { /* expect 409 meeting_not_completed */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/notes-email-integration.test.js`
Expected: FAIL — route returns 404 because it does not exist.

- [ ] **Step 3: Add the rate limiter beside the existing ones**

In `src/server.js`, next to `clipLimiter`:

```js
// A composed send is an outbound email under the owner's own Google account. Bounded per
// account for the same reason exports are: the expensive, irreversible thing here is the
// mail, not the render.
const notesEmailLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
```

- [ ] **Step 4: Add the route**

Place it immediately after the existing `emailTranscriptMatch` block:

```js
const notesEmailMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/notes-email$/);
if (notesEmailMatch && request.method === "POST") {
  const user = await requireUser(request, response);
  if (!user) return;
  const meeting = getOwnedMeeting(notesEmailMatch[1], user);
  if (!meeting) return sendJson(response, 404, { error: "not_found" });
  if (meeting.status !== "completed") {
    return sendJson(response, 409, {
      error: "meeting_not_completed",
      message: "Notes can be sent once the meeting is finalized."
    });
  }

  const preview = url.searchParams.get("preview") === "1";
  const body = await readJsonBody(request);
  const accounts = listGoogleAccounts(user);
  const parsed = parseNotesEmailSelection(body, meeting, { ownerDomains: ownerDomainsFor(accounts, user) });
  if (!parsed.ok) {
    const status = parsed.code === "external_not_confirmed" ? 409 : 400;
    return sendJson(response, status, { error: parsed.code, message: parsed.error });
  }

  let rendered;
  try {
    rendered = renderNotesEmail({ meeting, selection: parsed.value });
  } catch (error) {
    // Over the ceiling is the caller asking for too much, not a server fault.
    if (error.code === "body_too_large") {
      return sendJson(response, 413, { error: "body_too_large", message: error.message });
    }
    throw error;
  }
  // Rendering is cheap and changes nothing; only the send is charged and limited.
  if (preview) return sendJson(response, 200, rendered);

  if (!notesEmailLimiter.consume(`notes-email:${user.id}`).allowed) {
    return sendJson(response, 429, { error: "rate_limited", message: "Too many sends in a short window." });
  }
  // ... pick sending account, send per recipient, collect providerMessageIds,
  //     then record delivery + append a notes.email_sent event.
}
```

- [ ] **Step 5: Add the owner-domain helper**

```js
// Domains the owner is actually connected with. Anything else is external, which is what
// gates the confirmation — the same notion attendeeSuggestions already uses to mark an
// address as "not from your company".
function ownerDomainsFor(accounts, user) {
  const domains = accounts.map((account) => String(account.email || "").split("@")[1]).filter(Boolean);
  const own = String(user.email || "").split("@")[1];
  if (own) domains.push(own);
  return [...new Set(domains.map((d) => d.toLowerCase()))];
}
```

- [ ] **Step 6: Record the send**

After a successful send, mirroring how `emailMeetingTranscript` records `delivery`:

```js
await store.updateMeeting(meeting.id, {
  delivery: {
    ...(meeting.delivery || {}),
    notesEmail: {
      sentAt: new Date().toISOString(),
      recipients: parsed.value.recipients,
      subject: rendered.subject,
      sections: parsed.value.sections,
      turnsSent: parsed.value.transcript.includeIds.length,
      turnsEdited: Object.keys(parsed.value.transcript.edits).length,
      providerMessageIds
    }
  }
});
await store.appendEvent(meeting.id, {
  type: "notes.email_sent",
  message:
    `Notes sent to ${parsed.value.recipients.join(", ")} ` +
    `(${Object.entries(parsed.value.sections).filter(([, on]) => on).map(([key]) => key).join(", ") || "no sections"}).`
});
```

The body is deliberately not stored: edits are per-send, and `meetings.json` is rewritten in full on every write.

- [ ] **Step 7: Run the tests**

Run: `node scripts/check-syntax.mjs && node --test test/notes-email-integration.test.js`
Expected: parses cleanly, all pass.

- [ ] **Step 8: Commit**

```bash
git add src/server.js test/notes-email-integration.test.js
git commit -m "Serve the composed notes email, and record what went out

Preview renders without charging the limiter; only the send does, because the
irreversible thing here is the mail. The delivery record answers 'what did this
person receive', which nothing could answer before."
```

---

## Task 5: The composer UI

**Files:**
- Modify: `public/index.html` (dialog markup), `public/app.js` (state + handlers), `public/styles.css`

**Interfaces:**
- Consumes: `POST /api/meetings/:id/notes-email` and `?preview=1` (Task 4).
- Produces: no exports; a `<dialog id="compose-dialog">` opened from the meeting detail view.

- [ ] **Step 1: Read the existing dialog and editing patterns**

Run: `grep -n "dialog\|openClipDialog\|actionItemDrafts" public/app.js | head -30`

Follow the existing `<dialog>` + `state.*Drafts` + event-delegation pattern exactly. No framework, no build step.

- [ ] **Step 2: Add the dialog markup to `public/index.html`**

Sections: recipients (chips + input + attendee suggestions with an `external` badge), preset radios, section checkboxes, subject/intro inputs, the transcript list container, and Preview / Send buttons.

- [ ] **Step 3: Add composer state and the open handler in `public/app.js`**

```js
// Per-send by design: this lives in memory only and is discarded when the dialog closes.
// Nothing here is ever written back to the meeting.
const composerState = {
  meetingId: "",
  recipients: [],
  confirmExternal: false,
  subject: "",
  intro: "",
  signoff: "",
  sections: { summary: true, decisions: true, actionItems: true, openQuestions: false, risks: false, transcript: false, rawEvidence: false },
  includeIds: new Set(),
  edits: new Map()
};

const PRESETS = {
  full: { summary: true, decisions: true, actionItems: true, openQuestions: true, risks: true, transcript: true, rawEvidence: true },
  clientSafe: { summary: true, decisions: true, actionItems: true, openQuestions: false, risks: false, transcript: false, rawEvidence: false }
};
```

Selecting the `full` preset also selects every transcript turn; `clientSafe` clears them.

- [ ] **Step 4: Render the transcript list**

One row per segment: checkbox, timestamp, speaker, click-to-edit text. Bulk controls: all / none / drop-before-here / drop-after-here.

Build the list **once** when the dialog opens and mutate individual rows on change. 685 turns is roughly 3,000 nodes, which is fine — re-rendering the whole list on every keystroke is not.

- [ ] **Step 5: Wire Preview and Send**

Preview POSTs with `?preview=1` and renders `body.html` into an iframe or a preview pane. Send POSTs without it. On `409 external_not_confirmed`, show the external addresses and a confirm control that sets `confirmExternal` and retries.

- [ ] **Step 6: Verify in a browser**

Run `npm run dev`, open a completed demo meeting, and check: presets set the checkboxes; deselecting a turn removes it from the preview; an edited turn shows the edit in the preview; Send reports success and the run log shows `notes.email_sent`.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html public/styles.css
git commit -m "Add the notes composer

Presets are starting points rather than modes: pick one, then change anything."
```

---

## Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/qa-release-checks.md`

- [ ] **Step 1: Document the composer in `README.md`**

Cover what can be sent, that edits are per-send and never change the stored notes, and that external recipients require confirmation. Match the README's direct, concrete tone.

- [ ] **Step 2: Add QA checks to `docs/qa-release-checks.md`**

Following that file's existing format:
- preview output matches the delivered email
- a deselected section is absent from the received mail
- an edited turn arrives edited, and the stored transcript is unchanged afterwards
- an external recipient is refused until confirmed
- `notes.email_sent` appears in the run log with the right recipients
- a non-owner gets 404

- [ ] **Step 3: Commit**

```bash
git add README.md docs/qa-release-checks.md
git commit -m "Document the notes composer and how to QA it"
```

---

## Final Verification

- [ ] `node scripts/check-syntax.mjs` — every module parses
- [ ] `npm test` — **at least 289 + new tests**, zero failures
- [ ] `node -e "console.log(require('./package.json').dependencies)"` — still only `playwright-core`
- [ ] `grep -rn "artifacts.notes =" src/domain/notes-email-*.js` — no results; the composer never mutates stored notes
