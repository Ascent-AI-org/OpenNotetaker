import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = {
  version: 1,
  meetings: []
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    let data;
    try {
      data = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
      return;
    }

    try {
      const parsed = JSON.parse(data);
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        meetings: Array.isArray(parsed.meetings) ? parsed.meetings : []
      };
    } catch {
      // A corrupted store file must not crash-loop the server on boot. Keep the bad
      // file for manual recovery and start from an empty state.
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, backupPath);
      console.error(`meetings store was not valid JSON; moved it to ${backupPath} and started fresh.`);
      this.state = structuredClone(EMPTY_STATE);
      await this.persist();
    }
  }

  listMeetings() {
    return [...this.state.meetings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMeeting(id) {
    return this.state.meetings.find((meeting) => meeting.id === id) || null;
  }

  async createMeeting(input) {
    const meeting = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId || null,
      title: input.title,
      meetUrl: input.meetUrl,
      scheduledAt: input.scheduledAt,
      consentMode: input.consentMode,
      retentionDays: input.retentionDays,
      status: "scheduled",
      statusMessage: "Waiting for the bot runner.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: input.source || null,
      artifacts: {
        rawSegments: [],
        normalizedSegments: [],
        notes: null
      },
      events: [
        {
          at: new Date().toISOString(),
          type: "meeting.created",
          message: "Notetaker job created."
        }
      ]
    };

    this.state.meetings.push(meeting);
    await this.persist();
    return meeting;
  }

  async updateMeeting(id, patch) {
    const index = this.state.meetings.findIndex((meeting) => meeting.id === id);
    if (index === -1) return null;

    const current = this.state.meetings[index];
    const next = {
      ...current,
      ...patch,
      artifacts: {
        ...current.artifacts,
        ...(patch.artifacts || {})
      },
      updatedAt: new Date().toISOString()
    };
    // Retention is a ceiling on how long the verbatim transcript is kept, so the clock
    // has to start when that transcript first exists — not when the meeting record was
    // created. Stamped here because every write path (runner segment flushes, pipeline
    // finalization, follower copies) funnels through updateMeeting, so no caller can
    // forget it. Records written before this stamp existed fall back to createdAt.
    const hadSegments = (current.artifacts?.rawSegments?.length || 0) > 0;
    const hasSegments = (next.artifacts?.rawSegments?.length || 0) > 0;
    if (!hadSegments && hasSegments) {
      // An explicit value in the patch wins, so a backfill can date an imported
      // transcript correctly instead of resetting its clock to the import.
      next.transcriptCapturedAt = patch.transcriptCapturedAt ?? next.updatedAt;
      // A re-recorded meeting starts a fresh window; leaving the old marker in place
      // would exempt the new transcript from retention forever.
      next.artifactsPurgedAt = patch.artifactsPurgedAt ?? null;
    }
    this.state.meetings[index] = next;
    await this.persist();
    return next;
  }

  async appendEvent(id, event) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    return this.updateMeeting(id, {
      events: capHeartbeats([
        ...meeting.events,
        {
          at: new Date().toISOString(),
          ...event
        }
      ])
    });
  }

  // Applies the heartbeat cap to events already on disk. appendEvent only caps what it
  // writes, so without this the beats accumulated before the cap existed would stay
  // forever — on this instance that was 49,981 of 52,575 events. Runs at boot, before the
  // server serves traffic: a standalone script could not do this safely, because the
  // running server holds the whole store in memory and the next persist() would write the
  // uncapped copy straight back over it. Idempotent, so booting twice is harmless.
  async pruneStoredHeartbeats() {
    let removed = 0;
    for (const meeting of this.state.meetings) {
      const before = meeting.events?.length || 0;
      if (!before) continue;
      const capped = capHeartbeats(meeting.events);
      if (capped.length === before) continue;
      meeting.events = capped;
      removed += before - capped.length;
    }
    // One persist for the whole pass, not one per meeting: this file is tens of megabytes.
    if (removed > 0) await this.persist();
    return removed;
  }

  // Clears the raw/normalized transcript once the transcript itself is past the
  // meeting's configured retentionDays, so the store (loaded fully into memory and
  // rewritten in full on every persist()) doesn't grow without bound. The meeting
  // record and its generated notes survive; only the bulky verbatim transcript is
  // purged. Never touches meetings still mid-recording (isActiveStatus) or already
  // purged, and batches every change into a single persist() instead of one per
  // meeting.
  async pruneExpiredArtifacts(now, { isActiveStatus }) {
    let prunedCount = 0;
    for (const meeting of this.state.meetings) {
      if (meeting.artifactsPurgedAt) continue;
      if (isActiveStatus(meeting.status)) continue;

      const rawCount = meeting.artifacts?.rawSegments?.length || 0;
      const normalizedCount = meeting.artifacts?.normalizedSegments?.length || 0;
      if (rawCount === 0 && normalizedCount === 0) continue;

      const retentionDays = Number.isInteger(meeting.retentionDays) ? meeting.retentionDays : 30;
      const ageMs = now - retentionAnchorMs(meeting);
      if (!(ageMs >= retentionDays * 24 * 60 * 60 * 1000)) continue;

      const purgedAt = new Date(now).toISOString();
      meeting.artifacts.rawSegments = [];
      meeting.artifacts.normalizedSegments = [];
      meeting.artifactsPurgedAt = purgedAt;
      meeting.updatedAt = purgedAt;
      meeting.events.push({
        at: purgedAt,
        type: "retention.artifacts_purged",
        message: `Raw transcript purged after the ${retentionDays}-day retention window (${rawCount} raw / ${normalizedCount} normalized segments removed).`
      });
      prunedCount += 1;
    }

    if (prunedCount > 0) await this.persist();
    return prunedCount;
  }

  async persist() {
    // Recover the chain from a previous failed write before appending the next one:
    // chaining .then() onto a rejected promise would silently skip every future write,
    // while the caller of THIS write still needs to observe its own failure.
    const write = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      // Compact, not pretty-printed. Indentation cost 34MB of the 83MB written on EVERY
      // persist() — and this file is read by JSON.parse and by node one-liners, never by
      // eye at this size.
      await writeFile(tempPath, `${JSON.stringify(this.state)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    });
    this.writeQueue = write;
    return write;
  }
}

// bot.heartbeat is a liveness signal, not a record. One lands every few seconds of every
// recording and nothing ever removed them: pruneExpiredArtifacts clears transcripts but has
// never touched events, so heartbeats outlived even the meetings whose transcripts were
// purged. They reached 49,981 of 52,575 stored events and 5.8MB of the meeting-list payload
// before this cap existed. Keep a short tail — enough to see a recording is progressing —
// and drop the rest. Other event types are an audit trail and are never dropped.
const HEARTBEAT_TYPE = "bot.heartbeat";
const HEARTBEAT_KEEP = 20;

export function capHeartbeats(events, keep = HEARTBEAT_KEEP) {
  const list = Array.isArray(events) ? events : [];
  let seen = 0;
  for (const event of list) {
    if (event?.type === HEARTBEAT_TYPE) seen += 1;
  }
  if (seen <= keep) return list;

  // Drop the OLDEST heartbeats: the recent ones are the ones that answer "is it alive".
  let toDrop = seen - keep;
  const kept = [];
  for (const event of list) {
    if (event?.type === HEARTBEAT_TYPE && toDrop > 0) {
      toDrop -= 1;
      continue;
    }
    kept.push(event);
  }
  return kept;
}

// When the retention clock starts for a meeting's transcript. Prefer the moment the
// transcript was first captured; fall back to createdAt for records written before
// that stamp existed, and for meetings whose stamp is unparseable.
function retentionAnchorMs(meeting) {
  const captured = Date.parse(meeting.transcriptCapturedAt || "");
  if (Number.isFinite(captured)) return captured;
  const created = Date.parse(meeting.createdAt || "");
  return Number.isFinite(created) ? created : 0;
}
