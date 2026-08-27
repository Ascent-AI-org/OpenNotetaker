// Decides which meetings lose their video, and why. Pure functions over plain meeting
// records: nowMs is a parameter rather than a Date.now() call so a sweep is reproducible
// and testable, and nothing here touches the filesystem — the caller pairs a plan with
// MediaStore.deleteMeetingMedia() and reports the bytes it actually freed.
//
// Two independent pressures decide this. Time: video must never outlive the transcript
// it belongs to. Space: the box has a finite disk and video fills it far faster than
// transcripts ever did.

const DAY_MS = 24 * 60 * 60 * 1000;

// Video states that cannot have left bytes on disk. Everything else may have, including
// "failed" — a capture that died mid-meeting leaves a recording.part behind, and that
// leftover is exactly the kind of orphan a retention sweep exists to reclaim.
const NO_BYTES_STATUSES = new Set(["pending", "skipped", "purged"]);

// The operator's video default is a ceiling, never an extension: a meeting kept for 1
// day does not get its video kept for 7. Whichever window is shorter wins.
export function effectiveVideoRetentionDays(meeting, defaultDays) {
  const windows = [defaultDays, meeting?.retentionDays].filter((days) => Number.isInteger(days) && days > 0);
  return windows.length ? Math.min(...windows) : 0;
}

export function videoExpired(meeting, nowMs, defaultDays) {
  const days = effectiveVideoRetentionDays(meeting, defaultDays);
  // No usable window on either side means the record is malformed, not that it is due
  // for deletion. Same for a video we cannot date. Deleting someone's recording because
  // a timestamp failed to parse is not a recoverable mistake, so this direction fails
  // toward keeping it — the disk budget still reclaims it under real pressure.
  if (days <= 0) return false;
  const anchorMs = videoAnchorMs(meeting);
  if (anchorMs === null) return false;
  return nowMs - anchorMs >= days * DAY_MS;
}

export function planVideoPurge(meetings, nowMs, { defaultDays, isActiveStatus }) {
  const plan = [];
  for (const meeting of meetings || []) {
    if (!isPurgeable(meeting, isActiveStatus)) continue;
    if (!videoExpired(meeting, nowMs, defaultDays)) continue;
    plan.push({
      meetingId: meeting.id,
      reason: "retention",
      bytes: meetingMediaBytes(meeting)
    });
  }
  return plan;
}

// Oldest video goes first when the media directory outgrows its budget.
//
// `diskBytes` is an optional meetingId -> bytes map of what the media directory actually
// holds, and passing it is what keeps this honest. video.bytes is only written by a
// successful finalize, so a recording.part left behind by a killed worker reads as zero
// here while counting in full toward the usageBytes the caller measured — an overage that
// can only ever be paid for by deleting somebody else's finished recording. With real
// sizes the orphan becomes a candidate for the space it is occupying.
export function planDiskEviction(meetings, { usageBytes, budgetBytes, isActiveStatus, diskBytes } = {}) {
  const plan = [];
  if (!(usageBytes > budgetBytes)) return plan;

  const sizeOf = (meeting) => meetingDiskBytes(meeting, diskBytes);
  const candidates = (meetings || [])
    .filter((meeting) => isPurgeable(meeting, isActiveStatus) && sizeOf(meeting) > 0)
    .sort(byEvictionPriority);

  let projected = usageBytes;
  for (const meeting of candidates) {
    if (projected <= budgetBytes) break;
    const bytes = sizeOf(meeting);
    plan.push({ meetingId: meeting.id, bytes, reason: "disk_budget" });
    projected -= bytes;
  }
  return plan;
}

// What deleting this meeting's media directory would really free. The measured size wins
// whenever the caller has one; the recorded sizes are the fallback for a caller that
// cannot stat the disk (and for planVideoPurge, which is deciding on age, not on space).
function meetingDiskBytes(meeting, diskBytes) {
  const measured = diskBytes?.get?.(meeting?.id);
  return Number.isFinite(measured) && measured > 0 ? measured : meetingMediaBytes(meeting);
}

// A meeting's whole media footprint. Clips are cut copies, not views into the
// recording, so they are real bytes that a purge frees and a budget must count.
export function meetingMediaBytes(meeting) {
  const video = meeting?.video;
  const clips = Array.isArray(meeting?.clips) ? meeting.clips : [];
  const clipBytes = clips.reduce((total, clip) => total + toBytes(clip?.bytes), 0);
  return toBytes(video?.bytes) + clipBytes;
}

// A meeting still queued, recording or running through the pipeline is being written to
// right now; deleting its media mid-flight would break the run in progress. This is the
// same rule the transcript sweep applies in JsonStore.pruneExpiredArtifacts.
function isPurgeable(meeting, isActiveStatus) {
  const video = meeting?.video;
  if (!video) return false;
  if (video.purgedAt) return false;
  if (isActiveStatus(meeting.status)) return false;
  if (toBytes(video.bytes) === 0 && NO_BYTES_STATUSES.has(video.status)) return false;
  return true;
}

// When the retention clock starts for a video: the earliest stamp that belongs to this
// recording, not the first one that happens to be set.
//
// capturedAt is stamped when the remux finishes, which is the END of the meeting, while
// JsonStore.pruneExpiredArtifacts dates the transcript from transcriptCapturedAt — its
// first segment, at the START. Preferring capturedAt would start the video's clock later
// than the transcript's by the length of the meeting, so a two-hour call would keep video
// of every participant's face for two hours after its transcript was erased. createdAt is
// the fallback of last resort and never competes with the rest: a calendar import can
// create a record weeks early, and dating the video from that would delete it before it
// was ever recorded — the bug the transcript sweep already had to fix once.
function videoAnchorMs(meeting) {
  const video = meeting?.video || {};
  const stamps = [video.capturedAt, video.endedAt, video.startedAt, meeting?.transcriptCapturedAt]
    .map((stamp) => Date.parse(stamp || ""))
    .filter((parsed) => Number.isFinite(parsed));
  if (stamps.length) return Math.min(...stamps);

  const created = Date.parse(meeting?.createdAt || "");
  return Number.isFinite(created) ? created : null;
}

// Under disk pressure the first thing to go is video nobody can watch. A capture that
// never finalized is bytes no route will ever serve, so it is evicted ahead of a finished
// recording that is still inside its window and that somebody is expecting to find.
function byEvictionPriority(a, b) {
  const playable = (meeting) => (meeting?.video?.status === "ready" ? 1 : 0);
  const diff = playable(a) - playable(b);
  if (diff !== 0) return diff;
  return byAgeThenId(a, b);
}

function byAgeThenId(a, b) {
  // A video we cannot date sorts oldest: it predates the stamp or its record is broken,
  // and under disk pressure it is the least defensible thing to keep. The id tiebreak
  // keeps a plan stable, so two sweeps over the same data log the same eviction order.
  const left = videoAnchorMs(a) ?? 0;
  const right = videoAnchorMs(b) ?? 0;
  if (left !== right) return left - right;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function toBytes(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
