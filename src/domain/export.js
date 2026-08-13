// Meeting export: turns stored meeting artifacts into downloadable Markdown or JSON,
// one file per meeting, zipped when more than one meeting is selected.
//
// Everything here is pure — the HTTP layer supplies the meetings and the signed-in
// user id, so ownership filtering and request validation are unit-testable.
import { createZip } from "./zip.js";

// The frontend renders the same keys as checkboxes (see EXPORT_SECTIONS in public/app.js);
// this list stays the server-side authority and rejects anything it does not know.
export const EXPORT_SECTIONS = [
  "summary",
  "detailedNotes",
  "actionItems",
  "decisions",
  "openQuestions",
  "risks",
  "participants",
  "roleTranscript",
  "cleanTranscript",
  "rawTranscript",
  "runLog"
];

// Raw Hinglish evidence and the run log are opt-in: they are long, and the raw layer is
// pre-correction text people rarely want to hand to a client.
export const DEFAULT_EXPORT_SECTIONS = EXPORT_SECTIONS.filter(
  (section) => !["rawTranscript", "runLog"].includes(section)
);

export const EXPORT_FORMATS = ["md", "json"];

// The whole store lives in memory and an export serializes every selected meeting at
// once, so the request is capped rather than allowed to balloon the heap.
export const MAX_EXPORT_MEETINGS = 200;

const SECTION_TITLES = {
  summary: "Summary",
  detailedNotes: "Detailed notes",
  actionItems: "Action items",
  decisions: "Decisions",
  openQuestions: "Open questions",
  risks: "Risks",
  participants: "Participants",
  roleTranscript: "Role-corrected transcript (English)",
  cleanTranscript: "Clean English transcript",
  rawTranscript: "Raw Hinglish transcript",
  runLog: "Run log"
};

const FORMAT_META = {
  md: { extension: "md", contentType: "text/markdown; charset=utf-8" },
  json: { extension: "json", contentType: "application/json; charset=utf-8" }
};

/**
 * Validate an export request body. Returns `{ok:false, errors}` rather than throwing so
 * the route can answer 400 with field-level detail.
 */
export function parseExportRequest(body = {}) {
  const errors = {};

  const format = body.format ?? "md";
  if (!EXPORT_FORMATS.includes(format)) {
    errors.format = `Format must be one of: ${EXPORT_FORMATS.join(", ")}.`;
  }

  let sections = DEFAULT_EXPORT_SECTIONS;
  if (body.sections !== undefined) {
    if (!Array.isArray(body.sections) || body.sections.length === 0) {
      errors.sections = "Pick at least one section to export.";
    } else {
      const unknown = body.sections.filter((section) => !EXPORT_SECTIONS.includes(section));
      if (unknown.length) {
        errors.sections = `Unknown sections: ${unknown.map((section) => String(section)).join(", ")}.`;
      } else {
        // Normalize to the canonical order so exports read the same however the UI ordered them.
        sections = EXPORT_SECTIONS.filter((section) => body.sections.includes(section));
      }
    }
  }

  let meetingIds = "all";
  if (body.meetingIds !== undefined && body.meetingIds !== "all") {
    if (!Array.isArray(body.meetingIds) || body.meetingIds.length === 0) {
      errors.meetingIds = "Select at least one meeting.";
    } else if (body.meetingIds.some((id) => typeof id !== "string" || !id)) {
      errors.meetingIds = "Meeting ids must be strings.";
    } else if (body.meetingIds.length > MAX_EXPORT_MEETINGS) {
      errors.meetingIds = `Export at most ${MAX_EXPORT_MEETINGS} meetings at a time.`;
    } else {
      meetingIds = [...body.meetingIds];
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { meetingIds, sections, format } };
}

/**
 * Pick the meetings a user is allowed to export. Ownership is applied before the
 * requested ids are honoured, so an id belonging to another tenant simply drops out
 * instead of leaking the meeting's existence.
 */
export function selectExportMeetings(meetings, userId, meetingIds = "all") {
  if (!userId) return [];
  const owned = (meetings || []).filter((meeting) => meeting?.ownerId && meeting.ownerId === userId);
  if (meetingIds === "all") return owned;
  const wanted = new Set(meetingIds);
  return owned.filter((meeting) => wanted.has(meeting.id));
}

/**
 * Package selected meetings into a single downloadable file.
 *
 * @returns {{filename: string, contentType: string, body: Buffer}}
 */
export function buildExportBundle({ meetings, sections = DEFAULT_EXPORT_SECTIONS, format = "md", now = new Date() }) {
  if (!Array.isArray(meetings) || meetings.length === 0) {
    throw new Error("Cannot export: no meetings selected.");
  }
  const meta = FORMAT_META[format];
  if (!meta) throw new Error(`Unsupported export format: ${format}`);

  const render = format === "json"
    ? (meeting) => `${JSON.stringify(buildMeetingJson(meeting, sections, now), null, 2)}\n`
    : (meeting) => buildMeetingMarkdown(meeting, sections, now);

  if (meetings.length === 1) {
    return {
      filename: exportFileName(meetings[0], meta.extension),
      contentType: meta.contentType,
      body: Buffer.from(render(meetings[0]), "utf8")
    };
  }

  const used = new Map();
  const entries = meetings.map((meeting) => ({
    name: uniqueName(used, exportFileName(meeting, meta.extension)),
    data: render(meeting)
  }));

  return {
    filename: `opennotetaker-export-${isoDate(now)}.zip`,
    contentType: "application/zip",
    body: createZip(entries, { modifiedAt: now })
  };
}

/** `2026-07-04-client-kickoff-call-11111111.md` */
export function exportFileName(meeting, extension) {
  const date = isoDate(new Date(meeting?.scheduledAt || meeting?.createdAt || Date.now()));
  const slug = slugify(meeting?.title) || "meeting";
  const shortId = String(meeting?.id || "")
    .replace(/[^a-z0-9]/giu, "")
    .slice(0, 8)
    .toLowerCase() || "unknown";
  return `${date}-${slug}-${shortId}.${extension}`;
}

export function buildMeetingMarkdown(meeting, sections = DEFAULT_EXPORT_SECTIONS, now = new Date()) {
  const selected = new Set(sections);
  const notes = meeting?.artifacts?.notes || {};
  const lines = [
    `# ${escapeInline(meeting?.title || "Untitled meeting")}`,
    "",
    `- **Meet:** ${meeting?.meetUrl || "Not provided"}`,
    `- **Scheduled:** ${formatDate(meeting?.scheduledAt)}`,
    `- **Status:** ${meeting?.status || "unknown"}${meeting?.statusMessage ? ` — ${escapeInline(meeting.statusMessage)}` : ""}`,
    `- **Meeting ID:** ${meeting?.id || "unknown"}`,
    `- **Exported:** ${formatDate(now.toISOString())}`
  ];

  for (const section of EXPORT_SECTIONS) {
    if (!selected.has(section)) continue;
    lines.push("", `## ${SECTION_TITLES[section]}`, "", renderMarkdownSection(section, meeting, notes));
  }

  lines.push("", "---", "", "Generated by OpenNotetaker. Check the transcript before acting on notes.");
  return `${lines.join("\n")}\n`;
}

export function buildMeetingJson(meeting, sections = DEFAULT_EXPORT_SECTIONS, now = new Date()) {
  const selected = new Set(sections);
  const notes = meeting?.artifacts?.notes || {};
  // Built field by field rather than by deleting keys from the stored meeting: the store
  // holds ownerId and the runner lease (worker ids, expiry) which must never leave the box.
  const output = {
    id: meeting?.id || null,
    title: meeting?.title || null,
    meetUrl: meeting?.meetUrl || null,
    scheduledAt: meeting?.scheduledAt || null,
    createdAt: meeting?.createdAt || null,
    updatedAt: meeting?.updatedAt || null,
    status: meeting?.status || null,
    statusMessage: meeting?.statusMessage || null,
    consentMode: meeting?.consentMode || null,
    retentionDays: meeting?.retentionDays ?? null,
    exportedAt: now.toISOString()
  };

  if (selected.has("summary")) output.summary = notes.summary || null;
  if (selected.has("detailedNotes")) output.detailedNotes = notes.detailedNotes || [];
  if (selected.has("actionItems")) output.actionItems = notes.actionItems || [];
  if (selected.has("decisions")) output.decisions = notes.decisions || [];
  if (selected.has("openQuestions")) output.openQuestions = notes.openQuestions || [];
  if (selected.has("risks")) output.risks = notes.risks || [];
  if (selected.has("participants")) output.participants = meeting?.artifacts?.participants || [];
  if (selected.has("roleTranscript")) output.roleTranscript = meeting?.artifacts?.reconstructedTranscript || null;
  if (selected.has("cleanTranscript")) output.cleanTranscript = meeting?.artifacts?.normalizedSegments || [];
  if (selected.has("rawTranscript")) output.rawTranscript = meeting?.artifacts?.rawSegments || [];
  if (selected.has("runLog")) output.runLog = meeting?.events || [];

  return output;
}

/* ---------- Markdown section renderers ---------- */

function renderMarkdownSection(section, meeting, notes) {
  switch (section) {
    case "summary":
      return notes.summary ? escapeInline(notes.summary) : "No summary was generated.";
    case "detailedNotes":
      return renderList(notes.detailedNotes);
    case "actionItems":
      return renderActionItems(notes.actionItems);
    case "decisions":
      return renderList(notes.decisions);
    case "openQuestions":
      return renderList(notes.openQuestions);
    case "risks":
      return renderList(notes.risks);
    case "participants":
      return renderList(meeting?.artifacts?.participants);
    case "roleTranscript":
      return renderRoleTranscript(meeting?.artifacts?.reconstructedTranscript);
    case "cleanTranscript":
      return renderSegments(
        meeting?.artifacts?.normalizedSegments,
        (segment) => segment.english || segment.raw || "",
        "No cleaned transcript was generated."
      );
    case "rawTranscript":
      return renderSegments(
        meeting?.artifacts?.rawSegments,
        (segment) => segment.text || segment.raw || "",
        "No raw transcript was captured."
      );
    case "runLog":
      return renderRunLog(meeting?.events);
    default:
      return "None.";
  }
}

function renderList(items) {
  if (!Array.isArray(items) || !items.length) return "None.";
  return items.map((item) => `- ${escapeInline(item)}`).join("\n");
}

function renderActionItems(items) {
  if (!Array.isArray(items) || !items.length) return "None.";
  return [
    "| Task | Owner | Due | Evidence |",
    "| --- | --- | --- | --- |",
    ...items.map((item) =>
      [
        cell(item?.task),
        cell(item?.owner, "Unknown"),
        cell(item?.due, "Not specified"),
        cell(item?.evidenceTimestamp)
      ].reduce((row, value) => `${row} ${value} |`, "|")
    )
  ].join("\n");
}

function renderRoleTranscript(transcript) {
  const turns = transcript?.turns || [];
  if (!turns.length) return "No role-corrected transcript was generated.";

  const roles = (transcript.roles || []).length
    ? [
        "**Participants**",
        "",
        ...(transcript.roles || []).map((role) => `- **${escapeInline(role.label)}** — ${escapeInline(role.description || "No description.")}`),
        ""
      ]
    : [];
  const warnings = (transcript.warnings || []).length
    ? ["**Warnings**", "", ...(transcript.warnings || []).map((warning) => `- ${escapeInline(warning)}`), ""]
    : [];

  return [
    ...roles,
    ...warnings,
    ...turns.map((turn) => {
      const flags = turn.flags?.length ? ` _(${turn.flags.join(", ")})_` : "";
      return `**[${timestampRange(turn.start, turn.end)}] ${escapeInline(turn.role || "Unknown")}**${flags}  \n${escapeInline(turn.text || "")}`;
    })
  ].join("\n");
}

function renderSegments(segments, pickText, emptyMessage) {
  if (!Array.isArray(segments) || !segments.length) return emptyMessage;
  return segments
    .map(
      (segment) =>
        `**[${timestampRange(segment.start, segment.end)}] ${escapeInline(segment.speaker || "Unknown")}**  \n${escapeInline(pickText(segment))}`
    )
    .join("\n\n");
}

function renderRunLog(events) {
  if (!Array.isArray(events) || !events.length) return "None.";
  return events
    .map((event) => `- \`${formatDate(event.at)}\` **${escapeInline(event.type || "event")}** — ${escapeInline(event.message || "")}`)
    .join("\n");
}

/* ---------- Formatting helpers ---------- */

function cell(value, fallback = "—") {
  const text = escapeInline(value ?? "").trim();
  // A stray pipe would otherwise split one action item across extra table columns.
  return (text || fallback).replace(/\|/gu, "\\|");
}

function escapeInline(value) {
  // Markdown is rendered as text, never as HTML, so only newlines need flattening to
  // keep list items and table rows on one line.
  return String(value ?? "").replace(/\r?\n/gu, " ").trim();
}

function uniqueName(used, name) {
  const count = used.get(name) || 0;
  used.set(name, count + 1);
  if (count === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? `${name}-${count + 1}` : `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}`;
}

function slugify(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "");
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return date.toISOString();
}

function timestampRange(start, end) {
  return `${timestamp(start)}–${timestamp(end)}`;
}

function timestamp(value) {
  // Floor, not round: this is a position in the recording, so 3.86s is still 00:03.
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
