import test from "node:test";
import assert from "node:assert/strict";
import { admissionTimeoutMs, aloneDeadlineMs } from "../src/bot-runner/meet-browser.js";

const MINUTE = 60_000;

// Calendar autostart dispatches the bot BOT_AUTOSTART_LEAD_MINUTES (2 in production)
// before the meeting starts. Every patience timer used to be measured from bot launch,
// so the bot gave up right around the scheduled start — before any human had joined to
// admit it. These tests pin the timers to the scheduled start instead.

test("admission wait outlasts a bot that asked to join before the meeting started", () => {
  const scheduledStartMs = Date.parse("2026-07-30T12:00:00Z");
  // Bot asked to join 85s early, exactly as production logs show.
  const nowMs = scheduledStartMs - 85_000;

  const timeout = admissionTimeoutMs({
    baseTimeoutMs: 90_000,
    scheduledStartMs,
    graceMs: 10 * MINUTE,
    nowMs
  });

  // The old behaviour was a flat 90s, which expired 5s after the scheduled start.
  assert.ok(
    nowMs + timeout >= scheduledStartMs + 10 * MINUTE,
    `bot must keep waiting until 10m past the scheduled start, got ${timeout / 1000}s`
  );
});

test("admission wait never drops below the base timeout for a meeting already underway", () => {
  const scheduledStartMs = Date.parse("2026-07-30T12:00:00Z");
  // Manual "Run again" 40 minutes into a live meeting: the grace window is long gone.
  const nowMs = scheduledStartMs + 40 * MINUTE;

  const timeout = admissionTimeoutMs({
    baseTimeoutMs: 90_000,
    scheduledStartMs,
    graceMs: 10 * MINUTE,
    nowMs
  });

  assert.equal(timeout, 90_000);
});

test("admission wait falls back to the base timeout when the start time is unknown", () => {
  const timeout = admissionTimeoutMs({
    baseTimeoutMs: 90_000,
    scheduledStartMs: Number.NaN,
    graceMs: 10 * MINUTE,
    nowMs: Date.parse("2026-07-30T12:00:00Z")
  });

  assert.equal(timeout, 90_000);
});

test("bot alone before the meeting starts waits for the no-show grace, not 45s", () => {
  const scheduledStartMs = Date.parse("2026-07-30T12:00:00Z");
  // Admitted 90s early into an empty call; nobody has ever joined.
  const aloneSinceMs = scheduledStartMs - 90_000;

  const deadline = aloneDeadlineMs({
    aloneSinceMs,
    sawOthers: false,
    aloneTimeoutMs: 45_000,
    scheduledStartMs,
    noShowGraceMs: 10 * MINUTE
  });

  // Old behaviour: left at scheduledStart - 45s, i.e. before the meeting even began.
  assert.ok(
    deadline >= scheduledStartMs + 10 * MINUTE,
    `bot must hold an empty call until 10m past the scheduled start, got ${(deadline - scheduledStartMs) / 1000}s after start`
  );
});

test("bot alone after everyone left still leaves on the short alone timeout", () => {
  const scheduledStartMs = Date.parse("2026-07-30T12:00:00Z");
  // Meeting ran for 30 minutes, then the last human left.
  const aloneSinceMs = scheduledStartMs + 30 * MINUTE;

  const deadline = aloneDeadlineMs({
    aloneSinceMs,
    sawOthers: true,
    aloneTimeoutMs: 45_000,
    scheduledStartMs,
    noShowGraceMs: 10 * MINUTE
  });

  assert.equal(deadline, aloneSinceMs + 45_000);
});

test("no-show grace does not delay an ad-hoc meeting with no scheduled start", () => {
  const aloneSinceMs = Date.parse("2026-07-30T12:00:00Z");

  const deadline = aloneDeadlineMs({
    aloneSinceMs,
    sawOthers: false,
    aloneTimeoutMs: 45_000,
    scheduledStartMs: Number.NaN,
    noShowGraceMs: 10 * MINUTE
  });

  assert.equal(deadline, aloneSinceMs + 45_000);
});
