// Regression tests for the two pressures that delete video: the retention window, and
// the disk budget. Each test is named after the failure it locks out — video outliving
// the transcript it belongs to, a purge landing on a meeting that is still recording, or
// an eviction sweep that frees more than it needed to.
import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveVideoRetentionDays,
  meetingMediaBytes,
  planDiskEviction,
  planVideoPurge,
  videoExpired
} from "../src/domain/video-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const ACTIVE = new Set(["queued", "recording", "transcribing", "normalizing", "reconstructing", "following"]);
const isActiveStatus = (status) => ACTIVE.has(status);

function daysAgo(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function meeting(id, overrides = {}) {
  const { videoStatus = "ready", bytes = 1000, capturedAt = daysAgo(1), purgedAt = null, ...rest } = overrides;
  return {
    id,
    status: "completed",
    retentionDays: 30,
    createdAt: daysAgo(1),
    clips: [],
    video: { enabled: true, status: videoStatus, bytes, capturedAt, purgedAt },
    ...rest
  };
}

/* ---------- The effective window ---------- */

test("the shorter of the two windows wins", () => {
  assert.equal(effectiveVideoRetentionDays({ retentionDays: 30 }, 7), 7, "the operator default caps a long meeting");
  assert.equal(effectiveVideoRetentionDays({ retentionDays: 1 }, 7), 1, "video never outlives the transcript");
  assert.equal(effectiveVideoRetentionDays({ retentionDays: 90 }, 90), 90);
});

test("a meeting with no usable retention falls back to the operator default", () => {
  // Records written before retentionDays existed, and records with junk in the field.
  assert.equal(effectiveVideoRetentionDays({}, 7), 7);
  assert.equal(effectiveVideoRetentionDays({ retentionDays: 0 }, 7), 7);
  assert.equal(effectiveVideoRetentionDays({ retentionDays: "30" }, 7), 7);
  assert.equal(effectiveVideoRetentionDays(null, 7), 7);
});

/* ---------- Expiry ---------- */

test("a video kept for 1 day goes at day 2, even though the video default is 7", () => {
  // The case the min() exists for: a meeting on a 1-day transcript window must not keep
  // its video for the operator's full 7 days.
  const short = meeting("m1", { retentionDays: 1, capturedAt: daysAgo(2) });
  assert.equal(videoExpired(short, NOW, 7), true);

  const fresh = meeting("m2", { retentionDays: 1, capturedAt: daysAgo(0.5) });
  assert.equal(videoExpired(fresh, NOW, 7), false);
});

test("expiry runs from when the video was captured, not when the meeting was created", () => {
  // A calendar import creates the record weeks before the call happens. Dating the video
  // from createdAt would delete a recording made this morning — the same bug the
  // transcript sweep already had to fix once.
  const imported = meeting("m1", { retentionDays: 30, createdAt: daysAgo(40), capturedAt: daysAgo(1) });
  assert.equal(videoExpired(imported, NOW, 7), false);

  const old = meeting("m2", { retentionDays: 30, createdAt: daysAgo(40), capturedAt: daysAgo(8) });
  assert.equal(videoExpired(old, NOW, 7), true);
});

test("a video that cannot be dated is kept, not deleted", () => {
  // Deleting someone's recording because a timestamp failed to parse is not a mistake
  // that can be undone. The disk budget still reclaims it under real pressure.
  const undateable = meeting("m1", { capturedAt: null, createdAt: "not a date" });
  undateable.video.endedAt = undefined;
  assert.equal(videoExpired(undateable, NOW, 7), false);
});

test("a video with an ended stamp but no capture stamp still ages", () => {
  const salvaged = meeting("m1", { capturedAt: null, createdAt: daysAgo(0) });
  salvaged.video.endedAt = daysAgo(9);
  assert.equal(videoExpired(salvaged, NOW, 7), true);
});

/* ---------- Purge planning ---------- */

test("the purge plan covers expired video and reports what it will free", () => {
  const target = meeting("m1", {
    capturedAt: daysAgo(9),
    bytes: 1000,
    clips: [{ id: "c1", bytes: 250 }, { id: "c2", bytes: 100 }]
  });

  assert.deepEqual(planVideoPurge([target], NOW, { defaultDays: 7, isActiveStatus }), [
    { meetingId: "m1", reason: "retention", bytes: 1350 }
  ]);
  assert.equal(meetingMediaBytes(target), 1350, "clips are real bytes on disk, not views into the recording");
});

test("a meeting still being recorded is never purged out from under the worker", () => {
  // Its retentionDays is 1 and the capture started days ago (a long-running job), so the
  // only thing standing between it and deletion is the active-status check.
  const live = meeting("m1", { status: "recording", retentionDays: 1, capturedAt: daysAgo(3), videoStatus: "recording" });
  assert.deepEqual(planVideoPurge([live], NOW, { defaultDays: 7, isActiveStatus }), []);
});

test("the sweep skips what it has already done and what it has nothing to do to", () => {
  const alreadyPurged = meeting("m1", { capturedAt: daysAgo(9), purgedAt: daysAgo(1), videoStatus: "purged" });
  const noVideo = { id: "m2", status: "completed", retentionDays: 1, createdAt: daysAgo(40) };
  // Recording was never attempted, so there is nothing on disk and stamping a purge on
  // it would just churn meetings.json, which is rewritten in full on every write.
  const optedOut = meeting("m3", { capturedAt: daysAgo(9), videoStatus: "skipped", bytes: 0 });
  const notStarted = meeting("m4", { capturedAt: daysAgo(9), videoStatus: "pending", bytes: 0 });

  assert.deepEqual(planVideoPurge([alreadyPurged, noVideo, optedOut, notStarted], NOW, { defaultDays: 7, isActiveStatus }), []);
});

test("a capture that failed mid-meeting is still swept, because it left a .part behind", () => {
  // bytes is only stamped at finalize, so a crashed capture reports zero while holding
  // real disk. Skipping it would leak that file forever.
  const crashed = meeting("m1", { capturedAt: daysAgo(9), videoStatus: "failed", bytes: 0 });
  assert.deepEqual(planVideoPurge([crashed], NOW, { defaultDays: 7, isActiveStatus }), [
    { meetingId: "m1", reason: "retention", bytes: 0 }
  ]);
});

test("video inside its window survives the sweep", () => {
  const fresh = meeting("m1", { capturedAt: daysAgo(6) });
  assert.deepEqual(planVideoPurge([fresh], NOW, { defaultDays: 7, isActiveStatus }), []);
});

/* ---------- Disk eviction ---------- */

test("nothing is evicted while usage is inside the budget", () => {
  const meetings = [meeting("m1"), meeting("m2")];
  assert.deepEqual(planDiskEviction(meetings, { usageBytes: 2000, budgetBytes: 2000, isActiveStatus }), []);
  assert.deepEqual(planDiskEviction(meetings, { usageBytes: 1, budgetBytes: 2000, isActiveStatus }), []);
});

test("eviction takes the oldest video first and stops as soon as it is under budget", () => {
  const meetings = [
    meeting("newest", { capturedAt: daysAgo(1) }),
    meeting("oldest", { capturedAt: daysAgo(3) }),
    meeting("middle", { capturedAt: daysAgo(2) })
  ];

  const plan = planDiskEviction(meetings, { usageBytes: 3000, budgetBytes: 1500, isActiveStatus });

  assert.deepEqual(plan, [
    { meetingId: "oldest", bytes: 1000, reason: "disk_budget" },
    { meetingId: "middle", bytes: 1000, reason: "disk_budget" }
  ]);
});

test("an active meeting is never evicted, however old its video is", () => {
  const meetings = [
    meeting("live", { status: "recording", capturedAt: daysAgo(30), bytes: 5000 }),
    meeting("done", { capturedAt: daysAgo(1), bytes: 1000 })
  ];

  const plan = planDiskEviction(meetings, { usageBytes: 6000, budgetBytes: 1000, isActiveStatus });

  assert.deepEqual(plan, [{ meetingId: "done", bytes: 1000, reason: "disk_budget" }]);
});

test("eviction returns what it can rather than padding the plan with meetings that free nothing", () => {
  // Everything eligible is gone and the budget is still blown because live recordings
  // hold the rest. The plan must not list already-purged or zero-byte meetings just to
  // reach the target.
  const meetings = [
    meeting("purged", { capturedAt: daysAgo(20), purgedAt: daysAgo(1), videoStatus: "purged", bytes: 0 }),
    meeting("empty", { capturedAt: daysAgo(19), videoStatus: "failed", bytes: 0 }),
    meeting("real", { capturedAt: daysAgo(18), bytes: 1000 })
  ];

  const plan = planDiskEviction(meetings, { usageBytes: 50_000, budgetBytes: 1000, isActiveStatus });

  assert.deepEqual(plan, [{ meetingId: "real", bytes: 1000, reason: "disk_budget" }]);
});

test("a meeting's clips count toward what evicting it frees", () => {
  const meetings = [meeting("m1", { capturedAt: daysAgo(3), bytes: 1000, clips: [{ id: "c1", bytes: 400 }] })];

  const plan = planDiskEviction(meetings, { usageBytes: 1400, budgetBytes: 100, isActiveStatus });
  assert.deepEqual(plan, [{ meetingId: "m1", bytes: 1400, reason: "disk_budget" }]);
});

test("two sweeps over the same data plan the same eviction order", () => {
  // Same capture instant on every record: without a tiebreak the plan depends on array
  // order, and the operator's logs stop being reproducible.
  const meetings = ["b", "a", "c"].map((id) => meeting(id, { capturedAt: daysAgo(5) }));
  const options = { usageBytes: 3000, budgetBytes: 1000, isActiveStatus };

  const plan = planDiskEviction(meetings, options);
  assert.deepEqual(
    plan.map((entry) => entry.meetingId),
    ["a", "b"]
  );
  assert.deepEqual(planDiskEviction([...meetings].reverse(), options), plan);
});

/* ---------- Regressions ---------- */

test("the video clock starts with the transcript's, not when the remux finished", () => {
  // capturedAt is stamped at the END of the meeting while the transcript is dated from
  // its first segment, so preferring capturedAt kept video of everyone's face for the
  // length of the meeting after the transcript had already been erased for compliance.
  const twoHourCall = meeting("m1", {
    retentionDays: 3,
    capturedAt: daysAgo(3 - 2 / 24),
    transcriptCapturedAt: daysAgo(3)
  });

  assert.equal(videoExpired(twoHourCall, NOW, 7), true);
});

test("an orphaned .part is evictable once the sweep measures the disk", () => {
  // video.bytes is only written by a successful finalize, so a recording left behind by a
  // killed worker reads as zero on the record while filling the volume. Without the
  // measured sizes it is excluded from the plan and the overage is paid off by deleting
  // finished recordings that did nothing wrong.
  const meetings = [
    meeting("orphan", { capturedAt: null, createdAt: daysAgo(1), videoStatus: "failed", bytes: 0 }),
    meeting("good", { capturedAt: daysAgo(5), bytes: 1000 })
  ];
  const options = { usageBytes: 9000, budgetBytes: 1000, isActiveStatus };

  assert.deepEqual(planDiskEviction(meetings, options), [{ meetingId: "good", bytes: 1000, reason: "disk_budget" }]);

  const withDisk = planDiskEviction(meetings, {
    ...options,
    diskBytes: new Map([
      ["orphan", 8000],
      ["good", 1000]
    ])
  });
  assert.deepEqual(withDisk, [{ meetingId: "orphan", bytes: 8000, reason: "disk_budget" }]);
});

test("video nobody can play is evicted before a finished recording somebody is waiting for", () => {
  const meetings = [
    meeting("ready", { capturedAt: daysAgo(9), bytes: 1000 }),
    meeting("failed", { capturedAt: daysAgo(1), videoStatus: "failed", bytes: 500 })
  ];

  const plan = planDiskEviction(meetings, { usageBytes: 1500, budgetBytes: 1200, isActiveStatus });
  assert.deepEqual(
    plan.map((entry) => entry.meetingId),
    ["failed"],
    "the older recording is still watchable; the newer one is bytes no route will serve"
  );
});
