// Where video bytes live. The meeting store (data/meetings.json) is loaded fully into
// memory and rewritten in full on every persist(), so nothing here ever goes near it —
// the store keeps sizes and status, the filesystem keeps the bytes.
//
// Layout: <mediaDir>/<meetingId>/recording.part while a worker is streaming, then
// recording.mp4 once finalized, plus clips/<clipId>.mp4. One directory per meeting so
// deleting a meeting's media is a single rm -rf and can never strand a stray file.
import { spawn } from "node:child_process";
import { createReadStream as openReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, statfs, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A remux of a two-hour recording is seconds of work, but an ffmpeg that wedges on a
// pathological input would otherwise hold the finalize request open forever and keep
// the meeting stuck in "processing".
const DEFAULT_FINALIZE_TIMEOUT_MS = 10 * 60_000;

// ffmpeg's stderr is where the duration and frame size come from, and it also repeats a
// progress line for the whole run. Keep the head (stream header) and the tail (final
// stats) and drop the middle, so a long remux cannot grow this without bound.
const STDERR_KEEP_BYTES = 32 * 1024;

export function assertSafeId(id) {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    const error = new Error("Media ids must be UUIDs.");
    error.code = "invalid_id";
    throw error;
  }
  return id;
}

// Second half of the two-step guard, exported so it can be tested on its own: the id
// regex is what actually stops traversal today, and this is what still stops it if a
// future change loosens that regex. Comparing against root + separator matters — a bare
// startsWith would also accept a sibling directory whose name merely begins with the
// root's (…/media-backup), the same trap serveStatic() avoids in src/server.js.
export function assertInsideRoot(rootDir, candidatePath) {
  const root = resolve(rootDir);
  const path = resolve(candidatePath);
  if (path !== root && !path.startsWith(root + sep)) {
    const error = new Error("Refusing to touch a path outside the media root.");
    error.code = "outside_media_root";
    throw error;
  }
  return path;
}

export class MediaStore {
  constructor({ mediaDir, ffmpegPath = "ffmpeg", finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS }) {
    this.mediaDir = resolve(mediaDir);
    this.ffmpegPath = ffmpegPath;
    this.finalizeTimeoutMs = finalizeTimeoutMs;
    // One append at a time per meeting: a worker retrying a chunk it thinks failed can
    // arrive while the original is still being written, and both would read the same
    // pre-append size and append the same bytes twice.
    this.appendLocks = new Map();
  }

  meetingDir(meetingId) {
    assertSafeId(meetingId);
    return assertInsideRoot(this.mediaDir, join(this.mediaDir, meetingId));
  }

  recordingPartPath(meetingId) {
    return assertInsideRoot(this.mediaDir, join(this.meetingDir(meetingId), "recording.part"));
  }

  recordingPath(meetingId) {
    return assertInsideRoot(this.mediaDir, join(this.meetingDir(meetingId), "recording.mp4"));
  }

  clipPath(meetingId, clipId) {
    assertSafeId(clipId);
    return assertInsideRoot(this.mediaDir, join(this.meetingDir(meetingId), "clips", `${clipId}.mp4`));
  }

  async currentPartSize(meetingId) {
    const info = await statOrNull(this.recordingPartPath(meetingId));
    return info?.isFile() ? info.size : 0;
  }

  // Idempotent by byte offset, which is what lets a worker retry a chunk with no
  // server-side sequence state and survive a server restart mid-upload: the file's own
  // length is the only cursor. Returns the total bytes now held, so a worker that lost
  // track (or reconnected to a restarted server) can resume from the answer.
  async appendRecordingChunk(meetingId, offset, buffer) {
    const partPath = this.recordingPartPath(meetingId);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      const error = new Error("Chunk offset must be a non-negative integer.");
      error.code = "invalid_offset";
      throw error;
    }
    const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");

    return this.withAppendLock(meetingId, async () => {
      const size = await this.currentPartSize(meetingId);

      if (offset < size) {
        // The chunk already landed and the worker never saw the answer. Re-writing it
        // would splice duplicate bytes into the middle of the stream.
        return { bytes: size, duplicate: true };
      }
      if (offset > size) {
        // Bytes are missing between what we hold and what the worker is sending. There
        // is no way to fill a hole in a media stream, so refuse and tell the worker
        // where we actually are rather than writing a corrupt file.
        const error = new Error(`Expected chunk at offset ${size}, got ${offset}.`);
        error.code = "offset_gap";
        error.expected = size;
        throw error;
      }

      // 0600/0700, matching the mode users.json is written with: a self-hosted install
      // may keep DATA_DIR on a volume other local accounts can read, and a meeting
      // recording is the most sensitive thing this app stores.
      await mkdir(dirname(partPath), { recursive: true, mode: 0o700 });
      const handle = await open(partPath, "a", 0o600);
      try {
        const { bytesWritten } = await handle.write(chunk);
        if (bytesWritten !== chunk.length) {
          // write(2) returns short rather than failing when the volume fills partway
          // through the buffer. The number returned below IS the worker's resume cursor,
          // so reporting a length the file does not have would have it resume past a hole,
          // and its offset_gap resync would then re-send this payload over the bytes that
          // did land. Undo the partial append instead: the retry finds the file exactly
          // where it was and writes the whole chunk or none of it.
          await handle.truncate(size);
          const error = new Error(`Wrote ${bytesWritten} of ${chunk.length} bytes; the disk is likely full.`);
          error.code = "short_write";
          throw error;
        }
      } finally {
        await handle.close();
      }
      return { bytes: size + chunk.length, duplicate: false };
    });
  }

  // Remux, never re-encode: the worker already produced H.264, so this is a container
  // rewrite that costs seconds instead of an hour of CPU the app container does not
  // have. The input is assumed damaged — a worker killed mid-meeting leaves a truncated
  // fragmented MP4, and salvaging that is the whole point of writing fragments — so
  // ffmpeg is asked to keep whatever it can read rather than to validate.
  async finalizeRecording(meetingId) {
    const partPath = this.recordingPartPath(meetingId);
    const targetPath = this.recordingPath(meetingId);
    const tempPath = `${targetPath}.tmp`;

    const part = await statOrNull(partPath);
    if (!part?.isFile() || part.size === 0) {
      const error = new Error("There is no captured video to finalize.");
      error.code = "no_recording";
      throw error;
    }

    // -loglevel info (not warning) on purpose: the stream header carrying the frame
    // size is only printed at info, and it is the only source of dimensions that does
    // not require ffprobe, which is not guaranteed to be installed.
    const { code, signal, stderr } = await this.runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "info",
      "-stats",
      "-y",
      "-i",
      partPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      // The container has to be named: ffmpeg picks the muxer from the file extension,
      // and the output is written to a .tmp so a crash mid-remux never leaves a
      // half-written file at recordingPath.
      "-f",
      "mp4",
      tempPath
    ]);

    if (code !== 0) {
      await unlink(tempPath).catch(() => {});
      const error = new Error(`ffmpeg could not remux the recording (exit ${code ?? signal}).`);
      error.code = "ffmpeg_failed";
      error.stderr = stderr.slice(-2000);
      throw error;
    }

    // Rename last: until this point a crash leaves the .part intact and finalize can be
    // retried, and no half-written file is ever visible at recordingPath.
    await rename(tempPath, targetPath);
    // ffmpeg wrote the file, so the mode is whatever its umask gave it. Tightening is
    // best-effort — a filesystem that cannot express it is not a reason to fail a
    // finalize and lose the recording.
    await chmod(targetPath, 0o600).catch(() => {});
    await unlink(partPath).catch(() => {});

    const info = await statOrNull(targetPath);
    return {
      path: targetPath,
      bytes: info?.size ?? 0,
      ...parseMediaInfo(stderr)
    };
  }

  async deleteMeetingMedia(meetingId) {
    const dir = this.meetingDir(meetingId);
    const bytesFreed = await directoryBytes(dir);
    await rm(dir, { recursive: true, force: true });
    return { bytesFreed };
  }

  async deleteClip(meetingId, clipId) {
    const path = this.clipPath(meetingId, clipId);
    const info = await statOrNull(path);
    if (!info?.isFile()) return { bytesFreed: 0 };
    await unlink(path).catch(() => {});
    return { bytesFreed: info.size };
  }

  async usageBytes() {
    return directoryBytes(this.mediaDir);
  }

  // usageBytes(), split per meeting directory and returned with the total from the SAME
  // walk. The disk-budget sweep needs both numbers to add up: a total measured here and
  // per-meeting sizes read off the meeting records do not, because video.bytes only exists
  // after a successful finalize while a .part left by a killed worker fills the volume all
  // the same. Files loose at the root belong to no meeting and cannot be evicted, but they
  // still occupy the budget, so they count toward the total and nothing else.
  async usageByMeeting() {
    let entries;
    try {
      entries = await readdir(this.mediaDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { totalBytes: 0, byMeeting: new Map() };
      throw error;
    }

    const byMeeting = new Map();
    let totalBytes = 0;
    for (const entry of entries) {
      const path = join(this.mediaDir, entry.name);
      if (entry.isDirectory()) {
        const bytes = await directoryBytes(path);
        byMeeting.set(entry.name, bytes);
        totalBytes += bytes;
      } else if (entry.isFile()) {
        totalBytes += (await statOrNull(path))?.size ?? 0;
      }
    }
    return { totalBytes, byMeeting };
  }

  async freeDiskBytes() {
    // The media directory may not exist yet on a fresh install, and the answer is a
    // property of the filesystem, not the directory — so walk up to whatever ancestor
    // is already there rather than creating one as a side effect of a read.
    let path = this.mediaDir;
    for (;;) {
      try {
        const info = await statfs(path);
        return info.bavail * info.bsize;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(path);
        if (parent === path) return 0;
        path = parent;
      }
    }
  }

  async statFile(absPath) {
    const path = assertInsideRoot(this.mediaDir, absPath);
    const info = await statOrNull(path);
    return info?.isFile() ? { size: info.size } : null;
  }

  // start/end are inclusive, matching HTTP Range semantics, so a caller can hand a
  // parsed range straight through.
  createReadStream(absPath, { start, end } = {}) {
    const path = assertInsideRoot(this.mediaDir, absPath);
    return openReadStream(path, { start, end });
  }

  async withAppendLock(meetingId, fn) {
    const previous = this.appendLocks.get(meetingId) || Promise.resolve();
    const run = previous.then(fn);
    // What the map holds is a tail that cannot reject, so one failed append never
    // rejects every append queued behind it. The entry is dropped once nothing is
    // waiting; otherwise this map grows an entry per meeting for the life of the
    // process.
    const tail = run.then(
      () => {},
      () => {}
    );
    this.appendLocks.set(meetingId, tail);
    try {
      return await run;
    } finally {
      await tail;
      if (this.appendLocks.get(meetingId) === tail) this.appendLocks.delete(meetingId);
    }
  }

  runFfmpeg(args) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(this.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      } catch (error) {
        rejectPromise(error);
        return;
      }

      let head = "";
      let tail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (head.length < STDERR_KEEP_BYTES) head += chunk.slice(0, STDERR_KEEP_BYTES - head.length);
        tail = (tail + chunk).slice(-STDERR_KEEP_BYTES);
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.finalizeTimeoutMs);
      timer.unref?.();

      child.on("error", (error) => {
        clearTimeout(timer);
        // Almost always ENOENT: FFMPEG_PATH points at nothing. Say so, because the
        // caller only gets to log one line before it marks the video failed.
        error.code = error.code === "ENOENT" ? "ffmpeg_missing" : error.code;
        rejectPromise(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal, stderr: head === tail ? head : `${head}\n${tail}` });
      });
    });
  }
}

// Duration and frame size straight out of ffmpeg's own stderr. ffprobe would be the
// obvious tool and is deliberately not used: it is a separate binary that a minimal
// image may not ship, and a missing ffprobe would turn every finalize into a failure.
function parseMediaInfo(stderr) {
  const size = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/u.exec(stderr);
  return {
    durationMs: parseDurationMs(stderr),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0
  };
}

function parseDurationMs(stderr) {
  // The last progress line is the truth for a salvaged file: the container header of a
  // truncated recording still advertises the duration the worker intended to write,
  // while time= counts what was actually muxed out.
  let lastTime = 0;
  const progress = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/gu;
  for (const match of stderr.matchAll(progress)) {
    lastTime = clockToMs(match);
  }
  if (lastTime > 0) return lastTime;

  const header = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(stderr);
  return header ? clockToMs(header) : 0;
}

function clockToMs([, hours, minutes, seconds]) {
  return Math.round((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000);
}

// Retention sweeps, disk eviction and an operator with rm -rf all race each other, so a
// file vanishing between the listing and the stat is normal, not an error.
async function statOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function directoryBytes(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return 0;
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      const info = await statOrNull(path);
      total += info?.size ?? 0;
    }
  }
  return total;
}
