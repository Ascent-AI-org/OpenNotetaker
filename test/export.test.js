import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { createZip } from "../src/domain/zip.js";
import {
  DEFAULT_EXPORT_SECTIONS,
  EXPORT_SECTIONS,
  ExportTooLargeError,
  buildExportBundle,
  buildMeetingJson,
  buildMeetingMarkdown,
  exportFileName,
  parseExportRequest,
  selectExportMeetings
} from "../src/domain/export.js";

function sampleMeeting(overrides = {}) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    ownerId: "user-a",
    title: "Client kickoff call",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-07-04T09:30:00.000Z",
    createdAt: "2026-07-04T09:00:00.000Z",
    updatedAt: "2026-07-04T11:00:00.000Z",
    status: "completed",
    statusMessage: "Notes ready.",
    consentMode: "announced",
    retentionDays: 30,
    runner: { workerId: "worker-7", claimedAt: "2026-07-04T09:31:00.000Z", expiresAt: "2026-07-04T09:41:00.000Z" },
    artifacts: {
      participants: ["Dhruv", "Sanya"],
      notes: {
        summary: "Kickoff covered scope and timeline.",
        detailedNotes: ["Scope locked to phase one."],
        decisions: ["Ship phase one first."],
        actionItems: [
          { task: "Send the SOW", owner: "Dhruv", due: "Friday", evidenceTimestamp: "71.08" }
        ],
        openQuestions: ["Who signs off on billing?"],
        risks: ["Timeline is tight."]
      },
      reconstructedTranscript: {
        roles: [{ label: "Host", description: "Runs the call." }],
        warnings: ["One chunk was skipped."],
        turns: [{ role: "Host", start: 0.66, end: 3.86, text: "Hello everyone.", confidence: "high", flags: [] }]
      },
      normalizedSegments: [
        { id: "seg-1", speaker: "Speaker 1", start: 0.66, end: 3.86, raw: "Hello.", english: "Hello." }
      ],
      rawSegments: [
        { id: "seg-1", speaker: "Speaker 1", start: 0.66, end: 3.86, text: "Haan bhai hello." }
      ]
    },
    events: [{ at: "2026-07-04T09:31:00.000Z", type: "meeting.created", message: "Notetaker job created." }],
    ...overrides
  };
}

/* ---------- Section selection ---------- */

test("markdown export includes only the requested sections", () => {
  const markdown = buildMeetingMarkdown(sampleMeeting(), ["summary", "actionItems"]);

  assert.match(markdown, /## Summary/u);
  assert.match(markdown, /Kickoff covered scope and timeline\./u);
  assert.match(markdown, /## Action items/u);
  assert.match(markdown, /Send the SOW/u);
  assert.doesNotMatch(markdown, /## Risks/u);
  assert.doesNotMatch(markdown, /## Clean English transcript/u);
  assert.doesNotMatch(markdown, /Haan bhai hello/u);
});

test("markdown export always carries the meeting header, whatever the sections", () => {
  const markdown = buildMeetingMarkdown(sampleMeeting(), ["risks"]);

  assert.match(markdown, /^# Client kickoff call/u);
  assert.match(markdown, /https:\/\/meet\.google\.com\/abc-defg-hij/u);
  assert.match(markdown, /## Risks/u);
});

test("action item rows keep owner, due date, and evidence", () => {
  const markdown = buildMeetingMarkdown(sampleMeeting(), ["actionItems"]);

  assert.match(markdown, /Send the SOW/u);
  assert.match(markdown, /Dhruv/u);
  assert.match(markdown, /Friday/u);
  assert.match(markdown, /71\.08/u);
});

test("markdown escapes pipes so a task cannot break out of the action item table", () => {
  const meeting = sampleMeeting();
  meeting.artifacts.notes.actionItems = [
    { task: "Ship a | b", owner: "Dhruv", due: "", evidenceTimestamp: "" }
  ];

  const markdown = buildMeetingMarkdown(meeting, ["actionItems"]);
  const row = markdown.split("\n").find((line) => line.includes("Ship a"));

  assert.match(row, /Ship a \\\| b/u);
  assert.equal(row.split("|").length, 7, "row must stay a four-column table row");
});

test("empty sections render an explicit placeholder rather than vanishing", () => {
  const meeting = sampleMeeting();
  meeting.artifacts.notes.risks = [];

  const markdown = buildMeetingMarkdown(meeting, ["risks"]);

  assert.match(markdown, /## Risks/u);
  assert.match(markdown, /None\./u);
});

test("transcript sections render timestamps and speakers", () => {
  const markdown = buildMeetingMarkdown(sampleMeeting(), ["roleTranscript", "cleanTranscript", "rawTranscript"]);

  assert.match(markdown, /\[00:00–00:03\] Host/u);
  assert.match(markdown, /Hello everyone\./u);
  assert.match(markdown, /Speaker 1/u);
  assert.match(markdown, /Haan bhai hello\./u);
});

test("default sections cover the notes and clean transcript but not raw evidence or the run log", () => {
  assert.ok(DEFAULT_EXPORT_SECTIONS.includes("summary"));
  assert.ok(DEFAULT_EXPORT_SECTIONS.includes("actionItems"));
  assert.ok(DEFAULT_EXPORT_SECTIONS.includes("cleanTranscript"));
  assert.ok(!DEFAULT_EXPORT_SECTIONS.includes("rawTranscript"));
  assert.ok(!DEFAULT_EXPORT_SECTIONS.includes("runLog"));
  assert.ok(DEFAULT_EXPORT_SECTIONS.every((section) => EXPORT_SECTIONS.includes(section)));
});

/* ---------- JSON export ---------- */

test("json export drops owner and runner lease internals", () => {
  const json = buildMeetingJson(sampleMeeting(), EXPORT_SECTIONS);

  assert.equal(json.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(json.title, "Client kickoff call");
  assert.equal(json.ownerId, undefined);
  assert.equal(json.runner, undefined);
  assert.equal(JSON.stringify(json).includes("worker-7"), false);
});

test("json export honours the section selection", () => {
  const json = buildMeetingJson(sampleMeeting(), ["actionItems"]);

  assert.deepEqual(json.actionItems, [
    { task: "Send the SOW", owner: "Dhruv", due: "Friday", evidenceTimestamp: "71.08" }
  ]);
  assert.equal(json.summary, undefined);
  assert.equal(json.rawTranscript, undefined);
  assert.equal(json.cleanTranscript, undefined);
});

/* ---------- Filenames ---------- */

test("export filenames are slugged, dated, and id-suffixed", () => {
  const name = exportFileName(sampleMeeting(), "md");

  assert.equal(name, "2026-07-04-client-kickoff-call-11111111.md");
});

test("a hostile title cannot escape the archive directory", () => {
  const name = exportFileName(sampleMeeting({ title: "../../etc/passwd" }), "md");

  assert.ok(!name.includes("/"), `expected no path separators in ${name}`);
  assert.ok(!name.includes("\\"), `expected no backslashes in ${name}`);
  assert.ok(!name.includes(".."), `expected no parent traversal in ${name}`);
  assert.match(name, /\.md$/u);
});

test("titles that slug to nothing still produce a usable filename", () => {
  const name = exportFileName(sampleMeeting({ title: "🙂🙂🙂" }), "json");

  assert.match(name, /^2026-07-04-meeting-11111111\.json$/u);
});

test("filenames stay bounded for very long titles", () => {
  const name = exportFileName(sampleMeeting({ title: "a".repeat(400) }), "md");

  assert.ok(name.length <= 100, `filename was ${name.length} chars`);
});

/* ---------- Tenancy ---------- */

test("selectExportMeetings never returns another user's meetings", () => {
  const mine = sampleMeeting({ id: "mine", ownerId: "user-a" });
  const theirs = sampleMeeting({ id: "theirs", ownerId: "user-b" });

  const all = selectExportMeetings([mine, theirs], "user-a", "all");
  assert.deepEqual(all.map((meeting) => meeting.id), ["mine"]);

  const picked = selectExportMeetings([mine, theirs], "user-a", ["mine", "theirs"]);
  assert.deepEqual(picked.map((meeting) => meeting.id), ["mine"]);

  const stolen = selectExportMeetings([mine, theirs], "user-a", ["theirs"]);
  assert.deepEqual(stolen, []);
});

test("selectExportMeetings hides legacy ownerless meetings", () => {
  const orphan = sampleMeeting({ id: "orphan", ownerId: null });

  assert.deepEqual(selectExportMeetings([orphan], "user-a", "all"), []);
  assert.deepEqual(selectExportMeetings([orphan], "user-a", ["orphan"]), []);
});

/* ---------- Request validation ---------- */

test("parseExportRequest accepts a well formed request", () => {
  const parsed = parseExportRequest({
    meetingIds: ["a", "b"],
    sections: ["summary", "actionItems"],
    format: "md"
  });

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, {
    meetingIds: ["a", "b"],
    sections: ["summary", "actionItems"],
    format: "md"
  });
});

test("parseExportRequest defaults sections and scope when omitted", () => {
  const parsed = parseExportRequest({ format: "json" });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.meetingIds, "all");
  assert.deepEqual(parsed.value.sections, DEFAULT_EXPORT_SECTIONS);
});

test("parseExportRequest rejects unknown formats and sections", () => {
  assert.equal(parseExportRequest({ format: "pdf" }).ok, false);
  assert.equal(parseExportRequest({ format: "md", sections: ["summary", "secrets"] }).ok, false);
  assert.equal(parseExportRequest({ format: "md", sections: [] }).ok, false);
  assert.equal(parseExportRequest({ format: "md", sections: "summary" }).ok, false);
});

test("parseExportRequest rejects malformed and oversized id lists", () => {
  assert.equal(parseExportRequest({ format: "md", meetingIds: "everything" }).ok, false);
  assert.equal(parseExportRequest({ format: "md", meetingIds: [42] }).ok, false);
  assert.equal(parseExportRequest({ format: "md", meetingIds: [] }).ok, false);
  assert.equal(
    parseExportRequest({ format: "md", meetingIds: Array.from({ length: 201 }, (_, i) => `id-${i}`) }).ok,
    false
  );
});

/* ---------- Bundling ---------- */

test("a single meeting downloads as a plain file", () => {
  const bundle = buildExportBundle({
    meetings: [sampleMeeting()],
    sections: ["summary"],
    format: "md"
  });

  assert.equal(bundle.filename, "2026-07-04-client-kickoff-call-11111111.md");
  assert.equal(bundle.contentType, "text/markdown; charset=utf-8");
  assert.match(bundle.body.toString("utf8"), /Kickoff covered scope and timeline\./u);
});

test("several meetings download as a zip with one file each", () => {
  const bundle = buildExportBundle({
    meetings: [sampleMeeting(), sampleMeeting({ id: "99999999-0000-0000-0000-000000000000", title: "Standup" })],
    sections: ["summary"],
    format: "md",
    now: new Date("2026-08-13T00:00:00.000Z")
  });

  assert.equal(bundle.filename, "opennotetaker-export-2026-08-13.zip");
  assert.equal(bundle.contentType, "application/zip");

  const names = readZipEntryNames(bundle.body);
  assert.deepEqual(names, [
    "2026-07-04-client-kickoff-call-11111111.md",
    "2026-07-04-standup-99999999.md"
  ]);
});

test("a json bundle of several meetings keeps each meeting parseable on its own", () => {
  const bundle = buildExportBundle({
    meetings: [sampleMeeting(), sampleMeeting({ id: "99999999-0000-0000-0000-000000000000", title: "Standup" })],
    sections: ["summary"],
    format: "json"
  });

  const entries = readZipEntries(bundle.body);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const parsed = JSON.parse(entry.data.toString("utf8"));
    assert.equal(typeof parsed.id, "string");
    assert.equal(parsed.summary, "Kickoff covered scope and timeline.");
  }
});

test("meetings that would share a filename are disambiguated inside the zip", () => {
  const twin = sampleMeeting();
  const bundle = buildExportBundle({ meetings: [twin, { ...twin }], sections: ["summary"], format: "md" });

  const names = readZipEntryNames(bundle.body);
  assert.equal(new Set(names).size, 2, `zip entry names must be unique, got ${names.join(", ")}`);
});

test("an export past the byte budget is refused instead of filling the heap", () => {
  // One meeting whose transcript alone blows the budget.
  const huge = sampleMeeting();
  huge.artifacts.normalizedSegments = Array.from({ length: 40_000 }, (_, index) => ({
    id: `seg-${index}`,
    speaker: "Speaker 1",
    start: index,
    end: index + 1,
    english: "x".repeat(2000)
  }));

  assert.throws(
    () => buildExportBundle({ meetings: [huge], sections: ["cleanTranscript"], format: "md" }),
    (error) => error instanceof ExportTooLargeError && /larger than 64 MB/u.test(error.message)
  );
});

test("the byte budget also stops a many-meeting archive part way through", () => {
  const bulky = () => {
    const meeting = sampleMeeting({ id: `${Math.random()}`.slice(2, 14) });
    meeting.artifacts.normalizedSegments = Array.from({ length: 12_000 }, (_, index) => ({
      id: `seg-${index}`,
      speaker: "Speaker 1",
      start: index,
      end: index + 1,
      english: "y".repeat(2000)
    }));
    return meeting;
  };

  assert.throws(
    () => buildExportBundle({ meetings: [bulky(), bulky(), bulky()], sections: ["cleanTranscript"], format: "md" }),
    ExportTooLargeError
  );
});

test("exporting nothing is refused rather than shipping an empty archive", () => {
  assert.throws(() => buildExportBundle({ meetings: [], sections: ["summary"], format: "md" }), /no meetings/iu);
});

/* ---------- Zip writer ---------- */

test("zip entries round-trip through inflate with the original bytes", () => {
  const payload = "Hinglish notes — कल milte hain.\n".repeat(50);
  const zip = createZip([
    { name: "one.md", data: payload },
    { name: "two.md", data: "short" }
  ]);

  const entries = readZipEntries(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ["one.md", "two.md"]);
  assert.equal(entries[0].data.toString("utf8"), payload);
  assert.equal(entries[1].data.toString("utf8"), "short");
});

test("zip records a correct crc32 for every entry", () => {
  const zip = createZip([{ name: "a.txt", data: "The quick brown fox jumps over the lazy dog" }]);
  const [entry] = readZipEntries(zip);

  // Known CRC-32 of that sentence.
  assert.equal(entry.crc >>> 0, 0x414fa339);
});

test("zip central directory agrees with the local headers", () => {
  const zip = createZip([
    { name: "a.txt", data: "alpha" },
    { name: "b.txt", data: "beta" }
  ]);

  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "end of central directory record must exist");
  assert.equal(zip.readUInt16LE(eocd + 8), 2, "entry count on this disk");
  assert.equal(zip.readUInt16LE(eocd + 10), 2, "total entry count");
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(centralOffset + centralSize, eocd, "central directory must end where the EOCD starts");
});

test("zip refuses duplicate entry names", () => {
  assert.throws(
    () => createZip([{ name: "same.md", data: "a" }, { name: "same.md", data: "b" }]),
    /duplicate/iu
  );
});

/* ---------- Minimal zip reader used only by these tests ---------- */

function readZipEntryNames(zip) {
  return readZipEntries(zip).map((entry) => entry.name);
}

function readZipEntries(zip) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const crc = zip.readUInt32LE(offset + 14);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const uncompressedSize = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const stored = zip.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(data.length, uncompressedSize, `declared size mismatch for ${name}`);
    entries.push({ name, data, crc });
    offset = dataStart + compressedSize;
  }
  return entries;
}
