import test from "node:test";
import assert from "node:assert/strict";
import { canEnableRawEvidence } from "../public/compose-guard.js";

const segments = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];

test("raw evidence is allowed when every segment is included and nothing is edited", () => {
  const includeIds = new Set(["s1", "s2", "s3"]);
  assert.equal(canEnableRawEvidence(segments, includeIds, new Map()), true);
});

test("raw evidence is disabled when a segment is deselected", () => {
  const includeIds = new Set(["s1", "s3"]);
  assert.equal(canEnableRawEvidence(segments, includeIds, new Map()), false);
});

// This is the bug Finding A fixed: syncRawEvidenceGuard used to only look at
// includeIds, so editing a turn's text (a legitimate way to redact a line, per
// notes-email-render.js) never forced raw evidence off, even though raw evidence
// ignores edits and would still ship the original wording.
test("raw evidence is disabled when a turn is edited, even with every segment included", () => {
  const includeIds = new Set(["s1", "s2", "s3"]);
  const edits = new Map([["s2", "[redacted]"]]);
  assert.equal(canEnableRawEvidence(segments, includeIds, edits), false);
});

test("an empty segment list allows raw evidence (nothing to diverge from)", () => {
  assert.equal(canEnableRawEvidence([], new Set(), new Map()), true);
});
