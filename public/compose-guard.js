// The pure predicate behind the composer's raw-evidence guard (syncRawEvidenceGuard in
// app.js), split out so it is provable without a DOM. app.js runs DOM lookups the moment
// it loads (e.g. `$("#compose-raw-evidence")` at module scope), so importing app.js
// itself in a Node test crashes before a single assertion runs.
//
// notes-email-render.js renders "raw evidence" as every raw segment, completely
// unfiltered by the transcript selection. The dialog is where that gap gets closed
// instead: the checkbox stays disabled unless the operator's selection could not
// possibly diverge from what raw evidence would send regardless.
//
// Two things count as redaction and must both be satisfied:
//  - every segment is included (a deselected turn is genuinely absent from the
//    transcript, but raw evidence would still ship its original text)
//  - no turn has been edited (notes-email-render.js's own comment on
//    selectedTranscriptTurns says clearing a turn's text is a legitimate way to redact
//    one line without dropping the turn — an edit IS a redaction, and raw evidence
//    ignores edits exactly as it ignores includeIds)
// A guard that only checked the first bullet would let an operator rewrite a turn to
// "[redacted]", see that in the transcript section, and still mail the original
// sentence via raw evidence in the same send.
export function canEnableRawEvidence(segments, includeIds, edits) {
  if (edits.size > 0) return false;
  return segments.length === 0 || segments.every((segment) => includeIds.has(segment.id));
}
