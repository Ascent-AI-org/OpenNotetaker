// The action-item email: the short "here is what was committed to" note that goes to
// people who were in the meeting, as opposed to the full transcript that goes to the
// owner's own inboxes.
//
// Deliberately plain. It is read on a phone, minutes after a call, by someone who wants
// to know what they agreed to — so it leads with the table and keeps the summary to one
// paragraph underneath. No masthead, no buttons.

export function buildActionItemsEmail({ meeting, recipient, from, editedByUser = false }) {
  const items = meeting?.artifacts?.notes?.actionItems || [];
  return {
    to: recipient,
    from,
    subject: subjectFor(meeting, items),
    text: formatActionItemsEmail(meeting, { editedByUser }),
    html: formatActionItemsEmailHtml(meeting, { editedByUser })
  };
}

export function subjectFor(meeting, items = []) {
  const title = String(meeting?.title || "Meeting").trim() || "Meeting";
  if (!items.length) return `Notes: ${title}`;
  return `${items.length} action item${items.length === 1 ? "" : "s"}: ${title}`;
}

export function formatActionItemsEmail(meeting, { editedByUser = false } = {}) {
  const notes = meeting?.artifacts?.notes || {};
  const items = notes.actionItems || [];

  const lines = [
    String(meeting?.title || "Meeting"),
    formatDate(meeting?.scheduledAt),
    "",
    "ACTION ITEMS"
  ];

  if (!items.length) {
    lines.push("No commitments were made in this meeting.");
  } else {
    for (const [index, item] of items.entries()) {
      lines.push(
        `${index + 1}. ${item.task}`,
        `   Owner: ${item.owner || "Unassigned"}   Due: ${item.due || "Not stated"}${
          item.evidenceTimestamp ? `   Said at: ${item.evidenceTimestamp}` : ""
        }`
      );
    }
  }

  if (notes.summary) {
    lines.push("", "CONTEXT", notes.summary);
  }

  lines.push(
    "",
    "---",
    editedByUser
      ? "These items were reviewed and edited before sending."
      : "Extracted automatically from the meeting transcript — worth a sanity check before acting."
  );

  return lines.join("\n");
}

export function formatActionItemsEmailHtml(meeting, { editedByUser = false } = {}) {
  const notes = meeting?.artifacts?.notes || {};
  const items = notes.actionItems || [];

  const rows = items.length
    ? items
        .map(
          (item) => `
            <tr>
              <td class="task">${escapeHtml(item.task)}</td>
              <td class="who">${escapeHtml(item.owner || "Unassigned")}</td>
              <td class="when">${escapeHtml(item.due || "Not stated")}</td>
            </tr>`
        )
        .join("")
    : `<tr><td class="empty" colspan="3">No commitments were made in this meeting.</td></tr>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { margin: 0; padding: 0; background: #f7f4ee; color: #1c1a17; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Arial, sans-serif; }
      .shell { max-width: 640px; margin: 0 auto; padding: 32px 20px 44px; }
      .title { margin: 0 0 4px; font-size: 21px; font-weight: 650; letter-spacing: -0.01em; color: #1c1a17; }
      .when-line { margin: 0 0 26px; font-size: 13px; color: #7a736a; }
      .label { margin: 0 0 10px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #7a736a; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 13px 0; border-bottom: 1px solid #e4ded2; font-size: 15px; line-height: 1.5; vertical-align: top; }
      tr:last-child td { border-bottom: 0; }
      .task { color: #1c1a17; }
      .who { width: 27%; padding-left: 16px; color: #2f6b4f; font-weight: 600; white-space: nowrap; }
      .when { width: 23%; padding-left: 16px; color: #7a736a; white-space: nowrap; }
      .empty { color: #7a736a; }
      .context { margin: 30px 0 0; padding-top: 22px; border-top: 1px solid #e4ded2; }
      .context p { margin: 0; font-size: 14px; line-height: 1.65; color: #4a443c; }
      .foot { margin: 32px 0 0; font-size: 12px; line-height: 1.6; color: #9a938a; }
      @media (max-width: 520px) {
        .who, .when { width: auto; padding-left: 12px; white-space: normal; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <p class="title">${escapeHtml(meeting?.title || "Meeting")}</p>
      <p class="when-line">${escapeHtml(formatDate(meeting?.scheduledAt))}</p>

      <p class="label">Action items</p>
      <table role="presentation">${rows}</table>

      ${
        notes.summary
          ? `<div class="context">
               <p class="label">Context</p>
               <p>${escapeHtml(notes.summary)}</p>
             </div>`
          : ""
      }

      <p class="foot">${escapeHtml(
        editedByUser
          ? "These items were reviewed and edited before sending."
          : "Extracted automatically from the meeting transcript — worth a sanity check before acting."
      )}</p>
    </div>
  </body>
</html>`;
}

function formatDate(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
