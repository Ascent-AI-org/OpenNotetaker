// Every per-section formatter for meeting-notes email, in one place.
//
// These were private to transcript-email.js, which built exactly one email. The composer
// renders a different subset of the same sections, and a second copy of "how a decisions
// list looks" would drift from this one the first time either changed — leaving a preview
// that does not match what the automatic email sends.

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function formatDate(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toISOString();
}

export function formatTimestampRange(start, end) {
  return `${formatTimestamp(start)}-${formatTimestamp(end)}`;
}

function formatTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatActionItemsText(items = []) {
  if (!items.length) return "None.";
  return items
    .map((item, index) => {
      const owner = item.owner && item.owner !== "Unknown" ? `Owner: ${item.owner}` : "Owner: Unknown";
      const due = item.due && item.due !== "Not specified" ? `Due: ${item.due}` : "Due: Not specified";
      const evidence = item.evidenceTimestamp ? `Evidence: ${item.evidenceTimestamp}` : "";
      return `${index + 1}. ${item.task}\n   ${[owner, due, evidence].filter(Boolean).join(" | ")}`;
    })
    .join("\n");
}

export function formatListText(items = []) {
  if (!items.length) return "None.";
  return items.map((item) => `- ${item}`).join("\n");
}

export function formatCleanTranscriptText(segments) {
  if (!segments.length) return "No cleaned transcript was generated.";
  return segments
    .map((segment) => {
      const timestamp = formatTimestampRange(segment.start, segment.end);
      return `[${timestamp}] ${segment.speaker}: ${segment.english || segment.raw || ""}`;
    })
    .join("\n");
}

export function formatRoleTranscriptText(transcript) {
  const turns = transcript?.turns || [];
  if (!turns.length) return "No role-corrected transcript was generated.";
  const roleLines = (transcript.roles || []).length
    ? [
        "Participants:",
        ...(transcript.roles || []).map((role) => `- ${role.label}: ${role.description || "No description."}`),
        ""
      ]
    : [];
  const warnings = (transcript.warnings || []).length
    ? ["Warnings:", ...(transcript.warnings || []).map((warning) => `- ${warning}`), ""]
    : [];
  return [
    ...roleLines,
    ...warnings,
    ...turns.map((turn) => {
      const timestamp = formatTimestampRange(turn.start, turn.end);
      const flags = turn.flags?.length ? ` (${turn.flags.join(", ")})` : "";
      return `[${timestamp}] ${turn.role}${flags}: ${turn.text}`;
    })
  ].join("\n");
}

export function formatRawTranscriptText(segments) {
  if (!segments.length) return "No raw transcript was captured.";
  return segments
    .map((segment) => {
      const timestamp = formatTimestampRange(segment.start, segment.end);
      return `[${timestamp}] ${segment.speaker}: ${segment.text || segment.raw || ""}`;
    })
    .join("\n");
}

export function formatActionItemsHtml(items = []) {
  if (!items.length) return "<p>None.</p>";
  return `<table role="presentation">
    <thead>
      <tr><th>Task</th><th>Owner</th><th>Due</th><th>Evidence</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `<tr>
            <td>${escapeHtml(item.task || "")}</td>
            <td>${escapeHtml(item.owner || "Unknown")}</td>
            <td>${escapeHtml(item.due || "Not specified")}</td>
            <td>${escapeHtml(item.evidenceTimestamp || "")}</td>
          </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}

export function formatListHtml(items = []) {
  if (!items.length) return "<p>None.</p>";
  return `<ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

// Takes already-normalized rows ({ speaker, start, end, text }), not raw segments — a
// segment's `.english`/`.raw`/`.text` split is caller policy (transcript vs. evidence),
// not something this renderer should know about. Keeping that choice at the call site
// means a caller with a different row shape (no `.english` at all) still renders correctly
// instead of silently going blank.
export function formatTranscriptRowsHtml(rows = []) {
  return rows
    .map(
      (row) => `<div class="segment">
        <p class="speaker-line"><span>${escapeHtml(row.speaker || "Unknown")}</span> ${escapeHtml(formatTimestampRange(row.start, row.end))}</p>
        <p class="text">${escapeHtml(row.text || "")}</p>
      </div>`
    )
    .join("");
}
