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
  formatTranscriptRowsHtml,
  emailDocument
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
  // What actually went into this email, not what the request asked for — a caller can
  // leave transcript.includeIds and transcript.edits populated while unticking the
  // transcript section, and the audit record must not claim turns were sent (or edited)
  // in an email that carries no transcript at all. Computed from `turns`, the same list
  // the text and html below are built from, so this can only ever agree with the email.
  const editsRequested = selection.transcript?.edits || {};
  const turnsEditedRendered = turns.filter((turn) => Object.hasOwn(editsRequested, turn.id)).length;

  const text = [];
  if (selection.intro) text.push(selection.intro, "");
  text.push(meeting?.title || "Meeting", "");
  if (meeting?.meetUrl) text.push(`Meet: ${meeting.meetUrl}`);
  if (meeting?.scheduledAt) text.push(`Scheduled: ${formatDate(meeting.scheduledAt)}`);
  text.push("");
  if (s.summary) text.push("SUMMARY", summary || "No summary was generated.", "");
  if (s.decisions) text.push("DECISIONS", formatListText(decisions), "");
  if (s.actionItems) text.push("ACTION ITEMS", formatActionItemsText(actionItems), "");
  // formatListText(items = []) only defaults on undefined; a stored `null` (a meeting
  // whose notes were generated before this field existed, or a provider that emitted
  // null rather than omitting the key) reaches .length and throws, turning a render into
  // a 500. The html build below already guards both fields the same way.
  if (s.openQuestions) text.push("OPEN QUESTIONS", formatListText(notes.openQuestions || []), "");
  if (s.risks) text.push("RISKS", formatListText(notes.risks || []), "");
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

  // Rendered into the shared email shell rather than a bare styled <div>. A composed note
  // and the automatic transcript email come from the same product and land in the same
  // inbox; the operator picking sections is choosing CONTENT, not opting out of the
  // template. Class names below are the shell's own — see emailDocument in notes-sections.js.
  const metaRows = [
    meeting?.meetUrl
      ? `<div class="meta-row"><span class="meta-label">Meet</span><span class="meta-value"><a href="${escapeHtml(meeting.meetUrl)}">${escapeHtml(meeting.meetUrl)}</a></span></div>`
      : "",
    meeting?.scheduledAt
      ? `<div class="meta-row"><span class="meta-label">Scheduled</span><span class="meta-value">${escapeHtml(formatDate(meeting.scheduledAt))}</span></div>`
      : ""
  ].join("");

  const html = emailDocument({
    // What a mail client shows beside the subject before anything is opened. The operator's
    // own intro if they wrote one, since that is the sentence they chose to lead with.
    preheader: selection.intro || summary || "Meeting notes from OpenNotetaker.",
    inner: [
      `<section class="hero">`,
      `<p class="eyebrow">Meeting notes</p>`,
      `<h1>${escapeHtml(meeting?.title || "Meeting")}</h1>`,
      metaRows ? `<div class="meta">${metaRows}</div>` : "",
      `</section>`,
      selection.intro
        ? `<section class="section"><p class="text">${escapeHtml(selection.intro).replace(/\n/g, "<br>")}</p></section>`
        : "",
      s.summary ? section("Summary", `<p class="text">${escapeHtml(summary)}</p>`) : "",
      s.decisions ? section("Decisions", formatListHtml(decisions)) : "",
      s.actionItems ? section("Action items", formatActionItemsHtml(actionItems)) : "",
      s.openQuestions ? section("Open questions", formatListHtml(notes.openQuestions || [])) : "",
      s.risks ? section("Risks", formatListHtml(notes.risks || [])) : "",
      s.transcript ? section("Transcript", formatTranscriptRowsHtml(turns)) : "",
      s.rawEvidence
        ? section("Raw transcript evidence", `<pre class="text" style="white-space:pre-wrap;font-size:12px">${escapeHtml(formatRawTranscriptText(meeting?.artifacts?.rawSegments || []))}</pre>`)
        : "",
      selection.signoff
        ? `<section class="section"><p class="text">${escapeHtml(selection.signoff).replace(/\n/g, "<br>")}</p></section>`
        : "",
      `<p class="footer">Sent from OpenNotetaker. Edits in this email apply to this send only \u2014 the meeting's stored notes are unchanged.</p>`
    ].join("")
  });

  // A ceiling on the whole rendered body. A 685-turn transcript is already tens of
  // thousands of characters, and a provider-side rejection tells the operator nothing they
  // can act on — fail here, naming the thing to deselect.
  const body = { subject, text: text.join("\n"), html, turnsRendered: turns.length, turnsEditedRendered };
  if (body.text.length > MAX_BODY_CHARS || body.html.length > MAX_BODY_HTML_CHARS) {
    const error = new Error("The composed email is too large to send. Send fewer transcript turns.");
    error.code = "body_too_large";
    throw error;
  }
  return body;
}

function section(title, inner) {
  return `<section class="section"><h2>${escapeHtml(title)}</h2>${inner}</section>`;
}
