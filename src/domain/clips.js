// Clips: a short window cut out of a finished meeting recording, almost always the
// moment an action item was agreed. A clip is the only piece of a recording anyone is
// likely to hand to someone else, so two things drive everything here — the cut has to
// land on the words that were actually said, and the file it produces has to be as
// locked down as the recording it came from.
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

// Used when a caller does not pass a cap. An absent cap must not mean "no cap": that
// would let one request start an unbounded re-encode on the same box that is running
// transcription. Matches the VIDEO_MAX_CLIP_SECONDS default.
const DEFAULT_MAX_CLIP_MS = 300_000;

// Under about three frames at the capture's 15fps there is nothing to encode, and
// ffmpeg exits 0 having written a file no player will open.
const MIN_CLIP_MS = 200;

const MAX_LABEL_LENGTH = 120;

// A clip is capped at VIDEO_MAX_CLIP_SECONDS (300 by default) of 720p15, which the
// veryfast preset chews through in a fraction of that. Past two minutes the process is
// wedged rather than slow, and a wedged ffmpeg holding a request open is how one bad
// clip stops the app from answering anything else.
const DEFAULT_CLIP_TIMEOUT_MS = 120_000;

const STDERR_KEEP_BYTES = 8 * 1024;

/**
 * Check a requested clip range against the recording it will be cut from.
 *
 * Returns `{ok:false, error}` rather than throwing so the route can answer 400 with the
 * message as it stands. A durationMs of 0 means "unknown", not "empty": finalizeRecording
 * parses the duration out of ffmpeg's own stderr and reports 0 when it cannot, and
 * refusing to clip a perfectly playable recording because a progress line did not parse
 * is worse than letting the cut run and fail on an empty output.
 */
export function validateClipRange({ startMs, endMs, durationMs, maxClipMs } = {}) {
  const start = toInteger(startMs);
  const end = toInteger(endMs);
  if (start === null || end === null) {
    return { ok: false, error: "Clip start and end must be times in milliseconds." };
  }
  if (start < 0) {
    return { ok: false, error: "A clip cannot start before the recording does." };
  }
  if (end <= start) {
    return { ok: false, error: "A clip must end after it starts." };
  }

  const duration = toInteger(durationMs);
  const durationKnown = duration !== null && duration > 0;
  if (durationKnown && start >= duration) {
    return { ok: false, error: "A clip cannot start after the recording ends." };
  }

  // The end is clamped, not rejected. People drag a clip window to the end of the video
  // constantly, and the duration being compared against is itself parsed out of ffmpeg's
  // stderr — a request that overshoots by a few frames is a rounding difference, not a
  // mistake anyone can act on.
  const clampedEnd = durationKnown ? Math.min(end, duration) : end;
  if (clampedEnd - start < MIN_CLIP_MS) {
    return { ok: false, error: "A clip must be at least 0.2 seconds long." };
  }

  // The cap is applied after the clamp, so it measures the clip that will actually be
  // cut: "from here to the end" of a two-minute recording is legal even when the
  // requested end was hours past it.
  const requestedCap = toInteger(maxClipMs);
  const cap = requestedCap !== null && requestedCap > 0 ? requestedCap : DEFAULT_MAX_CLIP_MS;
  if (clampedEnd - start > cap) {
    return { ok: false, error: `Clips are capped at ${Math.round(cap / 1000)} seconds.` };
  }

  return { ok: true, startMs: start, endMs: clampedEnd };
}

/**
 * Cut `sourcePath` down to one range and write it to `targetPath`.
 *
 * Re-encodes, deliberately. A stream copy snaps the cut back to the preceding keyframe —
 * seconds earlier at the capture's GOP — and these ranges come from action-item evidence
 * timestamps, so "Dhruv, share the logs by Friday" would start mid-sentence or in the
 * previous topic. `-ss` ahead of `-i` keeps the seek cheap (ffmpeg jumps to the keyframe,
 * then decodes and discards up to the requested moment) while the re-encode is what makes
 * the first output frame the requested one.
 */
export async function cutClip({
  ffmpegPath = "ffmpeg",
  sourcePath,
  targetPath,
  startMs,
  endMs,
  preset = "veryfast",
  // A notch better than the capture's CRF on purpose: this is a re-encode of already
  // compressed video, and matching the source CRF stacks a second generation of loss on
  // top of the first. Do not wire config.video.crf in here — that number describes the
  // capture, not a copy of it.
  crf = 23,
  timeoutMs = DEFAULT_CLIP_TIMEOUT_MS
} = {}) {
  const start = toInteger(startMs);
  const end = toInteger(endMs);
  // validateClipRange is the caller's job, and this is the second lock on the same door:
  // a route that forgets it would otherwise hand ffmpeg a negative -ss or an unbounded
  // -t straight from a request body.
  if (start === null || end === null || start < 0 || end <= start) {
    const error = new Error("A clip needs a validated millisecond range.");
    error.code = "invalid_range";
    throw error;
  }
  // Both paths come from MediaStore's guarded path builders, which return absolute paths.
  // Insisting on that here means a path that somehow arrived from somewhere else — and in
  // particular one starting with "-" — can never be handed to ffmpeg as an option.
  if (!isAbsolute(sourcePath || "") || !isAbsolute(targetPath || "")) {
    const error = new Error("A clip needs absolute source and target paths.");
    error.code = "invalid_path";
    throw error;
  }

  // 0700/0600, the same modes MediaStore writes recordings with: a self-hosted install
  // may keep DATA_DIR on a volume other local accounts can read, and a clip is a copy of
  // the most sensitive thing this app stores.
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });

  // Written to a .tmp so a crash or a kill never leaves a half-written file sitting at
  // the path a viewer streams from.
  const tempPath = `${targetPath}.tmp`;
  const result = await runFfmpeg(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      secondsArg(start),
      "-i",
      sourcePath,
      "-t",
      secondsArg(end - start),
      "-c:v",
      "libx264",
      "-preset",
      String(preset),
      "-crf",
      String(crf),
      // Anything but yuv420p is unplayable in Safari and in plenty of Chrome builds, and
      // the whole point of a clip is that it opens for someone else.
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      // Clips are streamed with Range requests; without this the index lands at the end
      // of the file and a player has to fetch the tail before it can show a frame.
      "-movflags",
      "+faststart",
      // ffmpeg picks its muxer from the file extension, and the extension here is .tmp.
      "-f",
      "mp4",
      tempPath
    ],
    timeoutMs
  );

  if (result.timedOut) {
    await unlink(tempPath).catch(() => {});
    const error = new Error(`Cutting the clip took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`);
    error.code = "clip_timeout";
    throw error;
  }
  if (result.code !== 0) {
    await unlink(tempPath).catch(() => {});
    const error = new Error(`ffmpeg could not cut the clip (exit ${result.code ?? result.signal}).`);
    error.code = "ffmpeg_failed";
    error.stderr = result.stderr.slice(-2000);
    throw error;
  }

  const info = await stat(tempPath).catch(() => null);
  if (!info?.size) {
    // ffmpeg exits 0 for a range that lands past the end of the input, having muxed a
    // header and nothing else. Catching it here keeps a zero-byte clip out of the
    // meeting record, where it would show up as a playable clip that plays nothing.
    await unlink(tempPath).catch(() => {});
    const error = new Error("That range produced no video.");
    error.code = "clip_empty";
    throw error;
  }

  // Tightened before the rename, so the file is never visible at its final path with
  // whatever mode ffmpeg's umask gave it.
  await chmod(tempPath, 0o600).catch(() => {});
  await rename(tempPath, targetPath);
  return { path: targetPath, bytes: info.size, startMs: start, endMs: end };
}

/** The stored shape of a clip. Pure: the bytes are already on disk by the time it runs. */
export function buildClipRecord({ id, label, startMs, endMs, bytes, createdBy, createdAt, sourceActionItemId } = {}) {
  const start = Math.max(0, toInteger(startMs) ?? 0);
  const end = Math.max(start, toInteger(endMs) ?? start);
  return {
    id,
    label: cleanLabel(label),
    startMs: start,
    endMs: end,
    bytes: Math.max(0, toInteger(bytes) ?? 0),
    createdAt: createdAt || new Date().toISOString(),
    createdBy: createdBy || null,
    // Kept so the dashboard can show a clip next to the action item it was cut for, and
    // so a re-extraction can tell which items already have their evidence cut.
    sourceActionItemId: sourceActionItemId ? String(sourceActionItemId).slice(0, 120) : null,
    // A new clip is internal, always. Session-and-owner is the only way to reach it until
    // somebody deliberately mints a share link for this one clip.
    share: null
  };
}

// The label is typed by a person, stored in meetings.json and rendered in the dashboard —
// and, once a clip is shared, on a page anyone holding the link can open. Flattening it
// to one printable line here keeps the stored value sane; escaping on the way out is
// still the renderer's job.
function cleanLabel(value) {
  const label = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
  return label || "Clip";
}

// Fixed decimals rather than a bare number: ffmpeg reads these as time specs, and an
// exponent — which String() produces for small values, 1e-7 — is not one.
function secondsArg(ms) {
  return (ms / 1000).toFixed(3);
}

// Null for anything that is not plainly a number, so the falsy-coercion traps —
// Number(null), Number(""), Number([]) all being 0 — cannot turn a missing field into a
// valid start time.
function toInteger(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP_BYTES);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: the situation this exists for is a process that has stopped
      // responding, and there is nothing worth flushing — the output is a .tmp that is
      // about to be deleted either way.
      child.kill("SIGKILL");
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    child.on("error", (error) => {
      clearTimeout(timer);
      // Almost always ENOENT: FFMPEG_PATH points at nothing. Name it, because the caller
      // gets one line to log before it tells the user the clip failed.
      error.code = error.code === "ENOENT" ? "ffmpeg_missing" : error.code;
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stderr, timedOut });
    });
  });
}
