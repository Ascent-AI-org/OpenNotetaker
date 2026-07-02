// Claim/lease bookkeeping for fleet mode: recording workers claim queued meetings
// over the API, and every authenticated runner call renews the claim lease. If a
// worker dies, its lease expires and the meeting is either re-queued (never started)
// or salvaged from the segments it already flushed (died mid-recording).

export const ACTIVE_RECORDING_STATUSES = ["queued", "recording"];

// Statuses where a recording or its pipeline is still producing artifacts that a
// same-meeting follower could reuse.
const PEER_ACTIVE_STATUSES = new Set(["queued", "recording", "transcribing", "normalizing", "reconstructing"]);
const PEER_TIME_WINDOW_MS = 10 * 60_000;
const PEER_COMPLETED_FRESHNESS_MS = 6 * 60 * 60_000;

// Cross-user dedupe: when two users import or start the same Meet, only one bot should
// join. Returns an existing meeting whose recording this one can follow, or null.
export function findRecordingPeer(meetings, meeting, nowMs = Date.now()) {
  const scheduled = Date.parse(meeting.scheduledAt || "");
  return (
    meetings.find((candidate) => {
      if (candidate.id === meeting.id) return false;
      if (candidate.meetUrl !== meeting.meetUrl) return false;
      // Followers must not chain onto other followers; follow the recorder itself.
      if (candidate.followsMeetingId) return false;

      const candidateScheduled = Date.parse(candidate.scheduledAt || "");
      const sameSlot =
        Number.isFinite(scheduled) &&
        Number.isFinite(candidateScheduled) &&
        Math.abs(candidateScheduled - scheduled) <= PEER_TIME_WINDOW_MS;
      if (!sameSlot) return false;

      if (PEER_ACTIVE_STATUSES.has(candidate.status)) return true;
      // A finished recording of the same slot still serves followers who start late.
      if (candidate.status === "completed") {
        const updated = Date.parse(candidate.updatedAt || "");
        return Number.isFinite(updated) && nowMs - updated <= PEER_COMPLETED_FRESHNESS_MS;
      }
      return false;
    }) || null
  );
}

export function buildLease(workerId, nowMs, leaseSeconds) {
  return {
    workerId: String(workerId || "unknown-worker").slice(0, 120),
    claimedAt: new Date(nowMs).toISOString(),
    leaseExpiresAt: new Date(nowMs + leaseSeconds * 1000).toISOString()
  };
}

export function renewLease(lease, nowMs, leaseSeconds) {
  return {
    ...lease,
    leaseExpiresAt: new Date(nowMs + leaseSeconds * 1000).toISOString()
  };
}

export function leaseExpired(meeting, nowMs) {
  const expiresAt = Date.parse(meeting?.runner?.leaseExpiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt < nowMs;
}

export function pickClaimableMeeting(meetings, nowMs) {
  return (
    meetings
      .filter((meeting) => meeting.status === "queued")
      .filter((meeting) => !meeting.runner || leaseExpired(meeting, nowMs))
      .sort((a, b) => String(a.scheduledAt || "").localeCompare(String(b.scheduledAt || "")))[0] || null
  );
}

// A claimed-but-never-started meeting whose worker died can simply be re-queued.
export function shouldReleaseClaim(meeting, nowMs) {
  return meeting.status === "queued" && Boolean(meeting.runner) && leaseExpired(meeting, nowMs);
}

// A recording whose worker died cannot resume audio capture, but the segments the
// worker already flushed can still be finalized into notes.
export function shouldSalvageRecording(meeting, nowMs) {
  return meeting.status === "recording" && Boolean(meeting.runner) && leaseExpired(meeting, nowMs);
}
