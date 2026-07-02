export function buildTranscriptEmail({ meeting, recipient, from, includeRawEvidence = false }) {
  const subject = `Transcript: ${meeting.title}`;
  return {
    to: recipient,
    from,
    subject,
    text: formatTranscriptEmail(meeting, { includeRawEvidence }),
    html: formatTranscriptEmailHtml(meeting, { includeRawEvidence })
  };
}

export function formatTranscriptEmailHtml(meeting, { includeRawEvidence = false } = {}) {
  const notes = meeting.artifacts?.notes;
  const reconstructedTranscript = meeting.artifacts?.reconstructedTranscript;
  const normalizedSegments = meeting.artifacts?.normalizedSegments || [];
  const rawSegments = meeting.artifacts?.rawSegments || [];
  const actionItems = notes?.actionItems || [];

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { margin: 0; padding: 0; background: #f5f7fb; color: #172033; font-family: Inter, Arial, sans-serif; }
      .preheader { display: none; overflow: hidden; opacity: 0; max-height: 0; color: transparent; }
      .shell { max-width: 920px; margin: 0 auto; padding: 28px 16px 40px; }
      .hero { background: #101722; color: #ffffff; border-radius: 14px; padding: 28px; }
      .eyebrow { margin: 0 0 8px; color: #5de1d2; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 28px; line-height: 1.2; }
      .meta { margin-top: 18px; display: table; width: 100%; border-spacing: 0 8px; }
      .meta-row { display: table-row; }
      .meta-label, .meta-value { display: table-cell; font-size: 13px; vertical-align: top; }
      .meta-label { width: 110px; color: #9aa8bd; font-weight: 700; }
      .meta-value { color: #e8edf5; word-break: break-word; }
      .grid { display: table; width: 100%; border-spacing: 12px; margin: 12px -12px 0; }
      .grid-row { display: table-row; }
      .stat { display: table-cell; width: 25%; background: #ffffff; border: 1px solid #dce3ee; border-radius: 12px; padding: 14px; }
      .stat strong { display: block; color: #0f172a; font-size: 20px; }
      .stat span { color: #68758a; font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .section { margin-top: 16px; background: #ffffff; border: 1px solid #dce3ee; border-radius: 14px; padding: 22px; }
      .section h2 { margin: 0 0 12px; color: #0f172a; font-size: 18px; }
      .section p { margin: 0; color: #334155; line-height: 1.55; }
      .list { margin: 0; padding-left: 20px; color: #334155; }
      .list li { margin: 8px 0; line-height: 1.5; }
      table { width: 100%; border-collapse: collapse; }
      th { color: #64748b; font-size: 11px; text-transform: uppercase; text-align: left; border-bottom: 1px solid #e2e8f0; padding: 10px 8px; }
      td { color: #1e293b; font-size: 14px; border-bottom: 1px solid #eef2f7; padding: 12px 8px; vertical-align: top; line-height: 1.45; }
      .cards { display: table; width: 100%; border-spacing: 12px; margin: 0 -12px; }
      .card-cell { display: table-cell; width: 33.33%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; vertical-align: top; }
      .card-cell h3 { margin: 0 0 8px; color: #0f172a; font-size: 14px; }
      .role-chip { display: inline-block; margin: 0 8px 8px 0; padding: 10px 12px; border-radius: 999px; background: #e6fffb; border: 1px solid #99f6e4; color: #134e4a; font-size: 13px; }
      .role-chip strong { display: block; color: #0f766e; }
      .warning { margin: 10px 0 14px; padding: 12px 14px; border-radius: 10px; background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; }
      .turn, .segment { border-top: 1px solid #eef2f7; padding: 12px 0; }
      .turn:first-of-type, .segment:first-of-type { border-top: 0; }
      .speaker-line { margin: 0 0 6px; color: #64748b; font-size: 12px; font-weight: 800; text-transform: uppercase; }
      .speaker-line span { color: #0f766e; }
      .text { margin: 0; color: #1e293b; line-height: 1.55; }
      .footer { margin-top: 18px; color: #64748b; font-size: 12px; line-height: 1.5; text-align: center; }
      a { color: #0f766e; }
      @media (max-width: 720px) {
        .grid, .grid-row, .stat, .cards, .card-cell { display: block; width: auto; }
        .stat, .card-cell { margin-bottom: 10px; }
        .hero, .section { border-radius: 10px; padding: 18px; }
      }
    </style>
  </head>
  <body>
    <div class="preheader">${escapeHtml(notes?.summary || "OpenNotetaker transcript and meeting notes are ready.")}</div>
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">OpenNotetaker transcript</p>
        <h1>${escapeHtml(meeting.title || "Untitled meeting")}</h1>
        <div class="meta">
          ${renderMetaRow("Meet", meeting.meetUrl ? `<a href="${escapeHtml(meeting.meetUrl)}">${escapeHtml(meeting.meetUrl)}</a>` : "Not provided")}
          ${renderMetaRow("Scheduled", escapeHtml(formatDate(meeting.scheduledAt)))}
          ${renderMetaRow("Job", escapeHtml(meeting.id || "Unknown"))}
        </div>
      </section>

      <div class="grid">
        <div class="grid-row">
          ${renderStat("Actions", actionItems.length)}
          ${renderStat("Role turns", reconstructedTranscript?.turns?.length || 0)}
          ${renderStat("Clean segments", normalizedSegments.length)}
          ${renderStat("Raw segments", rawSegments.length)}
        </div>
      </div>

      <section class="section">
        <h2>Summary</h2>
        <p>${escapeHtml(notes?.summary || "No summary was generated.")}</p>
      </section>

      <section class="section">
        <h2>Action Items</h2>
        ${renderActionItemsHtml(actionItems)}
      </section>

      <section class="section">
        <div class="cards">
          <div class="card-cell">
            <h3>Decisions</h3>
            ${renderHtmlList(notes?.decisions)}
          </div>
          <div class="card-cell">
            <h3>Open Questions</h3>
            ${renderHtmlList(notes?.openQuestions)}
          </div>
          <div class="card-cell">
            <h3>Risks</h3>
            ${renderHtmlList(notes?.risks)}
          </div>
        </div>
      </section>

      <section class="section">
        <h2>English Role-Corrected Transcript</h2>
        ${renderRoleTranscriptHtml(reconstructedTranscript)}
      </section>

      <section class="section">
        <h2>Clean English Transcript</h2>
        ${renderSegmentTranscriptHtml(normalizedSegments, (segment) => ({
          speaker: segment.speaker,
          text: segment.english || segment.raw || ""
        }), "No cleaned transcript was generated.")}
      </section>

      ${includeRawEvidence ? `<section class="section">
        <h2>Raw Transcript Evidence</h2>
        ${renderSegmentTranscriptHtml(rawSegments, (segment) => ({
          speaker: segment.speaker,
          text: segment.text || segment.raw || ""
        }), "No raw transcript was captured.")}
      </section>` : ""}

      <p class="footer">Generated by OpenNotetaker. Review transcript evidence before using notes for contracts, invoices, or commitments.</p>
    </main>
  </body>
</html>`;
}

export function formatTranscriptEmail(meeting, { includeRawEvidence = false } = {}) {
  const notes = meeting.artifacts?.notes;
  const reconstructedTranscript = meeting.artifacts?.reconstructedTranscript;
  const normalizedSegments = meeting.artifacts?.normalizedSegments || [];
  const rawSegments = meeting.artifacts?.rawSegments || [];

  return [
    meeting.title,
    "",
    `Meet: ${meeting.meetUrl}`,
    `Scheduled: ${formatDate(meeting.scheduledAt)}`,
    `Job: ${meeting.id}`,
    "",
    "SUMMARY",
    notes?.summary || "No summary was generated.",
    "",
    "ACTION ITEMS",
    formatActionItems(notes?.actionItems),
    "",
    "DECISIONS",
    formatList(notes?.decisions),
    "",
    "OPEN QUESTIONS",
    formatList(notes?.openQuestions),
    "",
    "RISKS",
    formatList(notes?.risks),
    "",
    "ENGLISH ROLE-CORRECTED TRANSCRIPT",
    formatRoleTranscript(reconstructedTranscript),
    "",
    "CLEAN ENGLISH TRANSCRIPT",
    formatCleanTranscript(normalizedSegments),
    ...(includeRawEvidence
      ? [
          "",
          "RAW TRANSCRIPT EVIDENCE",
          formatRawTranscript(rawSegments)
        ]
      : [])
  ].join("\n");
}

function formatRoleTranscript(transcript) {
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

function formatActionItems(items = []) {
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

function formatList(items = []) {
  if (!items.length) return "None.";
  return items.map((item) => `- ${item}`).join("\n");
}

function formatCleanTranscript(segments) {
  if (!segments.length) return "No cleaned transcript was generated.";
  return segments
    .map((segment) => {
      const timestamp = formatTimestampRange(segment.start, segment.end);
      return `[${timestamp}] ${segment.speaker}: ${segment.english || segment.raw || ""}`;
    })
    .join("\n");
}

function formatRawTranscript(segments) {
  if (!segments.length) return "No raw transcript was captured.";
  return segments
    .map((segment) => {
      const timestamp = formatTimestampRange(segment.start, segment.end);
      return `[${timestamp}] ${segment.speaker}: ${segment.text || segment.raw || ""}`;
    })
    .join("\n");
}

function renderMetaRow(label, valueHtml) {
  return `<div class="meta-row"><div class="meta-label">${escapeHtml(label)}</div><div class="meta-value">${valueHtml}</div></div>`;
}

function renderStat(label, value) {
  return `<div class="stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function renderActionItemsHtml(items = []) {
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

function renderHtmlList(items = []) {
  if (!items.length) return "<p>None.</p>";
  return `<ul class="list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderRoleTranscriptHtml(transcript) {
  const turns = transcript?.turns || [];
  if (!turns.length) return "<p>No role-corrected transcript was generated.</p>";

  const roles = (transcript.roles || [])
    .map(
      (role) => `<div class="role-chip"><strong>${escapeHtml(role.label)}</strong>${escapeHtml(
        role.description || "No description."
      )}</div>`
    )
    .join("");
  const warnings = (transcript.warnings || []).length
    ? `<div class="warning">${renderHtmlList(transcript.warnings)}</div>`
    : "";
  const rows = turns
    .map((turn) => {
      const flags = turn.flags?.length ? ` | ${turn.flags.join(", ")}` : "";
      return `<div class="turn">
        <p class="speaker-line"><span>${escapeHtml(turn.role)}</span> ${escapeHtml(formatTimestampRange(turn.start, turn.end))} | ${escapeHtml(turn.confidence || "medium")} confidence${escapeHtml(flags)}</p>
        <p class="text">${escapeHtml(turn.text || "")}</p>
      </div>`;
    })
    .join("");

  return `${roles}${warnings}${rows}`;
}

function renderSegmentTranscriptHtml(segments, pick, emptyMessage) {
  if (!segments.length) return `<p>${escapeHtml(emptyMessage)}</p>`;
  return segments
    .map((segment) => {
      const picked = pick(segment);
      return `<div class="segment">
        <p class="speaker-line"><span>${escapeHtml(picked.speaker || "Unknown")}</span> ${escapeHtml(formatTimestampRange(segment.start, segment.end))}</p>
        <p class="text">${escapeHtml(picked.text || "")}</p>
      </div>`;
    })
    .join("");
}

function formatDate(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toISOString();
}

function formatTimestampRange(start, end) {
  return `${formatTimestamp(start)}-${formatTimestamp(end)}`;
}

function formatTimestamp(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
