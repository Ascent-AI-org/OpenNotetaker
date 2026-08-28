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
