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
import { parseActionItems, MAX_ACTION_ITEMS } from "./action-items.js";

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

  // Enforced here rather than only in the UI: a stale tab, or any caller that never saw
  // the warning, must not be able to skip it.
  const externalRecipients = recipients.filter((email) => isExternalRecipient(email, ownerDomains));
  if (externalRecipients.length && body.confirmExternal !== true) {
    return fail("external_not_confirmed", `Confirm sending outside your organisation: ${externalRecipients.join(", ")}.`);
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
      // Count-capped like every other bulk collection this module accepts (recipients at
      // MAX_RECIPIENTS, action items at MAX_ACTION_ITEMS, evidenceSegmentIds at 20) —
      // decisions was the one gap. Without this, a stolen session could POST hundreds of
      // items at the per-item clamp and have this app mail attacker-authored prose from
      // the owner's Gmail, which is exactly what the spec's threat model claims a
      // compromised session "cannot" do.
      decisions: Array.isArray(body.decisions)
        ? body.decisions.slice(0, MAX_ACTION_ITEMS).map((item) => clamp(item, SELECTION_LIMITS.turnEdit)).filter(Boolean)
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
