// Regression tests for the correctness and security fixes in this change. Each test is
// named after the failure it locks out, not the code it touches.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/storage/json-store.js";
import { SlidingWindowRateLimiter } from "../src/domain/rate-limit.js";
import { resolveClientIp } from "../src/domain/client-ip.js";
import { isGoogleMeetUrl } from "../src/domain/validation.js";
import { buildMeetingMarkdown } from "../src/domain/export.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["queued", "recording", "transcribing", "normalizing", "reconstructing", "following"]);
const isActiveStatus = (status) => ACTIVE.has(status);

async function newStore() {
  const dir = await mkdtemp(join(tmpdir(), "opennotetaker-hardening-"));
  const store = new JsonStore(join(dir, "meetings.json"));
  await store.load();
  return store;
}

function meetingInput(overrides = {}) {
  return {
    ownerId: "user-1",
    title: "Weekly sync",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: new Date().toISOString(),
    consentMode: "host_confirmed",
    retentionDays: 30,
    ...overrides
  };
}

function segments(count, prefix = "seg") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    speaker: "Speaker 1",
    start: index,
    end: index + 1,
    text: `line ${index}`
  }));
}

/* ---------- Retention ---------- */

test("retention runs from transcript capture, not meeting creation", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 30 }));

  // The meeting record was created 40 days ago — a calendar import or a job that sat
  // scheduled — but the call was only recorded a moment ago.
  meeting.createdAt = new Date(Date.now() - 40 * DAY_MS).toISOString();
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(3) } });

  const pruned = await store.pruneExpiredArtifacts(Date.now(), { isActiveStatus });
  assert.equal(pruned, 0, "a transcript captured minutes ago must not be purged");
  assert.equal(store.getMeeting(meeting.id).artifacts.rawSegments.length, 3);
});

test("retention still purges a transcript once it is past the window", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 30 }));
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(3) } });

  const pruned = await store.pruneExpiredArtifacts(Date.now() + 31 * DAY_MS, { isActiveStatus });
  assert.equal(pruned, 1);
  const purged = store.getMeeting(meeting.id);
  assert.deepEqual(purged.artifacts.rawSegments, []);
  assert.deepEqual(purged.artifacts.normalizedSegments, []);
  assert.ok(purged.artifactsPurgedAt, "the purge is recorded on the meeting");
  assert.ok(
    purged.events.some((event) => event.type === "retention.artifacts_purged"),
    "the purge is visible in the run log"
  );
});

test("a transcript still inside its window survives the sweep", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 30 }));
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(2) } });

  assert.equal(await store.pruneExpiredArtifacts(Date.now() + 29 * DAY_MS, { isActiveStatus }), 0);
  assert.equal(store.getMeeting(meeting.id).artifacts.rawSegments.length, 2);
});

test("a meeting recorded again after a purge starts a fresh retention window", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 30 }));
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(2) } });
  await store.pruneExpiredArtifacts(Date.now() + 31 * DAY_MS, { isActiveStatus });
  assert.ok(store.getMeeting(meeting.id).artifactsPurgedAt);

  // Re-recorded: the new transcript must be retained for its own full window, and must
  // not be exempted forever by the stale purge marker either.
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(4, "new") } });
  const refreshed = store.getMeeting(meeting.id);
  assert.equal(refreshed.artifactsPurgedAt, null, "the old purge marker is cleared");

  assert.equal(await store.pruneExpiredArtifacts(Date.now(), { isActiveStatus }), 0);
  assert.equal(store.getMeeting(meeting.id).artifacts.rawSegments.length, 4);
  assert.equal(await store.pruneExpiredArtifacts(Date.now() + 31 * DAY_MS, { isActiveStatus }), 1);
});

test("an in-flight recording is never purged mid-meeting", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 1 }));
  await store.updateMeeting(meeting.id, { status: "recording", artifacts: { rawSegments: segments(2) } });

  assert.equal(await store.pruneExpiredArtifacts(Date.now() + 10 * DAY_MS, { isActiveStatus }), 0);
  assert.equal(store.getMeeting(meeting.id).artifacts.rawSegments.length, 2);
});

test("meetings stored before this stamp existed still fall back to createdAt", async () => {
  // The upgrade path: an existing data/meetings.json has no transcriptCapturedAt on any
  // record, and those transcripts must still age out rather than being retained forever.
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput({ retentionDays: 30 }));
  await store.updateMeeting(meeting.id, { status: "completed", artifacts: { rawSegments: segments(2) } });

  const legacy = store.getMeeting(meeting.id);
  delete legacy.transcriptCapturedAt;
  legacy.createdAt = new Date(Date.now() - 31 * DAY_MS).toISOString();

  assert.equal(await store.pruneExpiredArtifacts(Date.now(), { isActiveStatus }), 1);
  assert.deepEqual(store.getMeeting(meeting.id).artifacts.rawSegments, []);
});

test("transcriptCapturedAt is stamped once and survives later updates", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput());
  assert.equal(store.getMeeting(meeting.id).transcriptCapturedAt, undefined);

  await store.updateMeeting(meeting.id, { artifacts: { rawSegments: segments(1) } });
  const stamped = store.getMeeting(meeting.id).transcriptCapturedAt;
  assert.ok(stamped, "the stamp appears with the first segments");

  await store.updateMeeting(meeting.id, { artifacts: { rawSegments: segments(5) } });
  assert.equal(store.getMeeting(meeting.id).transcriptCapturedAt, stamped, "later flushes do not reset it");
});

/* ---------- Store durability ---------- */

test("the store rewrites atomically and stays parseable", async () => {
  const store = await newStore();
  const meeting = await store.createMeeting(meetingInput());
  await store.updateMeeting(meeting.id, { artifacts: { rawSegments: segments(2) } });

  const onDisk = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(onDisk.meetings.length, 1);
  assert.equal(onDisk.meetings[0].artifacts.rawSegments.length, 2);
});

/* ---------- Rate limiting ---------- */

test("check() reports the budget without spending it", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, true, "checking is not a hit");

  limiter.consume("a");
  limiter.consume("a");
  assert.equal(limiter.check("a").allowed, false, "check() sees a spent budget");
});

test("a failed-login budget is per account, so one address cannot spend another's", () => {
  // The bug this locks out: keying the account limiter by `${ip}:${email}` gave every
  // source address its own full budget against the same account, so a spray from many
  // addresses was never throttled.
  const limiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const victim = "victim@example.com";

  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(limiter.check(victim).allowed, true);
    limiter.consume(victim);
  }
  assert.equal(limiter.check(victim).allowed, false, "the 9th guess is refused whatever address it comes from");
  assert.equal(limiter.check("someone-else@example.com").allowed, true, "other accounts are unaffected");
});

test("a spent budget frees up once the window passes", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, max: 1 });
  const start = 1_000_000;
  limiter.consume("a", start);
  assert.equal(limiter.check("a", start + 500).allowed, false);
  assert.equal(limiter.check("a", start + 1500).allowed, true);
});

/* ---------- Client IP ---------- */

test("without a configured proxy the socket address wins over a forged header", () => {
  const request = {
    headers: { "x-forwarded-for": "1.2.3.4" },
    socket: { remoteAddress: "10.0.0.9" }
  };
  assert.equal(resolveClientIp(request, 0), "10.0.0.9");
});

test("with one trusted proxy the address that proxy saw is used", () => {
  const request = {
    headers: { "x-forwarded-for": "203.0.113.7" },
    socket: { remoteAddress: "10.0.0.9" }
  };
  assert.equal(resolveClientIp(request, 1), "203.0.113.7");
});

test("a client cannot forge its address by prepending entries", () => {
  // The client controls everything to the left; only the rightmost entries were written
  // by proxies we trust.
  const request = {
    headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.7" },
    socket: { remoteAddress: "10.0.0.9" }
  };
  assert.equal(resolveClientIp(request, 1), "203.0.113.7");
  assert.equal(resolveClientIp(request, 2), "8.8.8.8");
});

test("a missing or too-short forwarded header falls back to the socket address", () => {
  const noHeader = { headers: {}, socket: { remoteAddress: "10.0.0.9" } };
  assert.equal(resolveClientIp(noHeader, 2), "10.0.0.9");

  const tooShort = { headers: { "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "10.0.0.9" } };
  assert.equal(resolveClientIp(tooShort, 2), "10.0.0.9", "fewer hops than declared means fail closed");
});

test("an unidentifiable client still yields a stable key", () => {
  assert.equal(resolveClientIp({ headers: {}, socket: {} }, 0), "unknown");
  assert.equal(resolveClientIp(undefined, 1), "unknown");
});

/* ---------- Meet URL validation ---------- */

test("Meet URLs are accepted only over http(s)", () => {
  assert.equal(isGoogleMeetUrl("https://meet.google.com/abc-defg-hij"), true);
  assert.equal(isGoogleMeetUrl("http://meet.google.com/abc-defg-hij"), true);
  assert.equal(isGoogleMeetUrl("ftp://meet.google.com/abc-defg-hij"), false);
  assert.equal(isGoogleMeetUrl("javascript://meet.google.com/abc-defg-hij"), false);
});

test("lookalike hosts and malformed codes are rejected", () => {
  assert.equal(isGoogleMeetUrl("https://meet.google.com.evil.test/abc-defg-hij"), false);
  assert.equal(isGoogleMeetUrl("https://meet.google.com/not-a-code"), false);
  assert.equal(isGoogleMeetUrl("not a url"), false);
});

/* ---------- Export rendering ---------- */

test("participants export as names, whether stored as objects or strings", () => {
  // The runner stores {name, firstSeenAt, lastSeenAt}; before this fix every participant
  // rendered as "[object Object]" in the Markdown export.
  const markdown = buildMeetingMarkdown(
    {
      id: "m1",
      title: "Weekly sync",
      artifacts: {
        participants: [
          { name: "Dhruv", firstSeenAt: "2026-01-01T10:00:00.000Z" },
          "Sanya",
          { firstSeenAt: "2026-01-01T10:01:00.000Z" }
        ]
      }
    },
    ["participants"],
    new Date("2026-01-01T12:00:00.000Z")
  );

  assert.ok(!markdown.includes("[object Object]"), "no participant renders as [object Object]");
  assert.match(markdown, /^- Dhruv$/mu);
  assert.match(markdown, /^- Sanya$/mu);
});

test("a meeting with no participants renders the empty state", () => {
  const markdown = buildMeetingMarkdown({ id: "m1", title: "T", artifacts: {} }, ["participants"], new Date());
  assert.match(markdown, /## Participants\n\nNone\./u);
});
