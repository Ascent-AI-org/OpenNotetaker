// Regression tests for clip cutting. Each test is named after the failure it locks out:
// a range the route should never have accepted, a cut that starts on the wrong sentence,
// or an ffmpeg that never comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildClipRecord, cutClip, validateClipRange } from "../src/domain/clips.js";

const run = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

async function newDir() {
  return mkdtemp(join(tmpdir(), "opennotetaker-clips-"));
}

// A stand-in for a recording: ten seconds, a keyframe every five, and a brightness ramp
// so a decoded frame's mean luma says which second of the recording it came from. That
// ramp is the whole measuring instrument — see the frame-exactness test below.
async function writeRecording(path) {
  await run(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=10:duration=10",
    "-vf",
    "fade=t=in:st=0:d=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    "expr:gte(t,n_forced*5)",
    "-y",
    path
  ]);
}

// Mean luma of one decoded frame, straight out of ffmpeg as raw gray bytes — no ffprobe,
// same reason the production code avoids it. With keyframesOnly the decoder is asked for
// the first KEYFRAME instead of the first frame, and returns null when the file has none.
async function frameLuma(path, { atSeconds = 0, keyframesOnly = false } = {}) {
  const { stdout } = await run(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
      ...(atSeconds > 0 ? ["-ss", String(atSeconds)] : []),
      "-i",
      path,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-"
    ],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
  );
  if (!stdout.length) return null;
  let total = 0;
  for (const value of stdout) total += value;
  return total / stdout.length;
}

// A fake ffmpeg, so the error paths are tested on a process that behaves exactly as the
// test needs rather than on whatever a real ffmpeg happens to do today. Every fake writes
// a partial output file first, which is what the cleanup assertions look for.
async function writeFakeFfmpeg(dir, name, body) {
  const path = join(dir, name);
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      "const output = process.argv[process.argv.length - 1];",
      body
    ].join("\n"),
    { mode: 0o755 }
  );
  return path;
}

// Skip the cutting tests rather than fail them on a machine with no ffmpeg (or one built
// without libx264): they are about where a cut lands, not about the environment.
const fixtureDir = await newDir();
const recordingPath = join(fixtureDir, "recording.mp4");
const hasFfmpeg = await writeRecording(recordingPath).then(
  () => true,
  () => false
);
const noFfmpeg = hasFfmpeg ? false : `${ffmpegPath} with libx264 is not available here`;

/* ---------- validateClipRange ---------- */

test("a range that is not made of numbers is refused, never coerced to zero", () => {
  // Number(null), Number("") and Number([]) are all 0, so a missing field would otherwise
  // become a perfectly valid cut from the start of the recording.
  for (const value of [null, undefined, "", "  ", "abc", true, false, [], {}, [5], Number.NaN, Infinity]) {
    assert.equal(validateClipRange({ startMs: value, endMs: 5000, durationMs: 60_000 }).ok, false, `start ${JSON.stringify(value)}`);
    assert.equal(validateClipRange({ startMs: 0, endMs: value, durationMs: 60_000 }).ok, false, `end ${JSON.stringify(value)}`);
  }
  assert.equal(validateClipRange().ok, false, "no argument at all");
});

test("a clip cannot start before the recording does", () => {
  const result = validateClipRange({ startMs: -1, endMs: 5000, durationMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /before the recording/u);
});

test("a clip that ends where it starts, or earlier, is refused", () => {
  assert.equal(validateClipRange({ startMs: 5000, endMs: 5000, durationMs: 60_000 }).ok, false);
  assert.equal(validateClipRange({ startMs: 5000, endMs: 4000, durationMs: 60_000 }).ok, false);
});

test("a clip cannot start after the recording ends", () => {
  const result = validateClipRange({ startMs: 60_000, endMs: 61_000, durationMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /after the recording ends/u);
});

test("an end past the end of the recording is clamped, not refused", () => {
  // The duration itself is parsed out of ffmpeg's stderr and the UI lets people drag the
  // window to the end, so overshooting by a few frames is a rounding difference.
  const result = validateClipRange({ startMs: 50_000, endMs: 70_000, durationMs: 60_000, maxClipMs: 300_000 });
  assert.deepEqual(result, { ok: true, startMs: 50_000, endMs: 60_000 });
});

test("the cap measures the clip that will be cut, not the one that was asked for", () => {
  // "From here to the end" of a two-minute recording is legal even though the requested
  // end was an hour past it. Checking the cap before the clamp would refuse it.
  const result = validateClipRange({ startMs: 0, endMs: 3_600_000, durationMs: 120_000, maxClipMs: 300_000 });
  assert.deepEqual(result, { ok: true, startMs: 0, endMs: 120_000 });
});

test("a range longer than the cap is refused, and the message says how long is allowed", () => {
  const result = validateClipRange({ startMs: 0, endMs: 400_000, durationMs: 600_000, maxClipMs: 300_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /300 seconds/u);
  assert.equal(validateClipRange({ startMs: 0, endMs: 300_000, durationMs: 600_000, maxClipMs: 300_000 }).ok, true, "the cap itself is allowed");
});

test("a caller that forgets the cap gets the default, not an unbounded re-encode", () => {
  for (const cap of [undefined, null, 0, -1, "nonsense"]) {
    const result = validateClipRange({ startMs: 0, endMs: 400_000, durationMs: 600_000, maxClipMs: cap });
    assert.equal(result.ok, false, `cap ${JSON.stringify(cap)} must not mean "no cap"`);
    assert.match(result.error, /300 seconds/u);
  }
});

test("a recording whose duration could not be parsed can still be clipped", () => {
  // finalizeRecording reports 0 when ffmpeg's stderr does not yield a duration. Refusing
  // to clip a playable recording over that would be worse than letting the cut fail.
  for (const duration of [0, undefined, null, Number.NaN, "unknown"]) {
    assert.deepEqual(validateClipRange({ startMs: 10_000, endMs: 20_000, durationMs: duration, maxClipMs: 300_000 }), {
      ok: true,
      startMs: 10_000,
      endMs: 20_000
    });
  }
  // The cap is still the backstop when there is no duration to clamp against.
  assert.equal(validateClipRange({ startMs: 0, endMs: 400_000, durationMs: 0, maxClipMs: 300_000 }).ok, false);
});

test("a range too short to hold a frame is refused rather than cut into an unplayable file", () => {
  const result = validateClipRange({ startMs: 1000, endMs: 1050, durationMs: 60_000, maxClipMs: 300_000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /at least/u);
  // Clamping must not sneak a sub-frame range past this either.
  assert.equal(validateClipRange({ startMs: 59_950, endMs: 90_000, durationMs: 60_000, maxClipMs: 300_000 }).ok, false);
});

test("fractional and stringified milliseconds are normalized before they reach ffmpeg", () => {
  assert.deepEqual(validateClipRange({ startMs: 1000.4, endMs: 4999.6, durationMs: 60_000, maxClipMs: 300_000 }), {
    ok: true,
    startMs: 1000,
    endMs: 5000
  });
  assert.deepEqual(validateClipRange({ startMs: "1000", endMs: "5000", durationMs: "60000", maxClipMs: "300000" }), {
    ok: true,
    startMs: 1000,
    endMs: 5000
  });
});

/* ---------- cutClip ---------- */

test("a clip starts at the requested moment, not at the preceding keyframe", { skip: noFfmpeg }, async () => {
  // This is the reason cutClip re-encodes. The fixture has keyframes at 0s and 5s, and the
  // cut asks for 6s–7s. A stream copy of that range either rewinds to the 5s keyframe —
  // a second of the wrong conversation — or starts mid-GOP and produces a file whose
  // first frame is not a keyframe, which no browser will render.
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");

  const cut = await cutClip({ ffmpegPath, sourcePath: recordingPath, targetPath, startMs: 6000, endMs: 7000 });
  assert.equal(cut.path, targetPath);
  assert.ok(cut.bytes > 0);

  const clipStart = await frameLuma(targetPath, { keyframesOnly: true });
  assert.notEqual(clipStart, null, "the clip must open on a keyframe; a stream copy leaves it with none");

  const atCut = await frameLuma(recordingPath, { atSeconds: 6 });
  const atPrecedingKeyframe = await frameLuma(recordingPath, { atSeconds: 5 });
  assert.ok(
    Math.abs(clipStart - atCut) < 3,
    `the clip opens on 6s (luma ${clipStart}), not on the 5s keyframe (luma ${atPrecedingKeyframe}) or the start (luma 0)`
  );
});

test("a clip is no more readable than the recording it was cut from", { skip: noFfmpeg }, async () => {
  // DATA_DIR can sit on a volume other local accounts can read, so clips match the
  // 0600/0700 that MediaStore writes recordings and their directories with.
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");
  await cutClip({ ffmpegPath, sourcePath: recordingPath, targetPath, startMs: 1000, endMs: 2000 });

  assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "clips"))).mode & 0o777, 0o700);
});

test("an unvalidated range never reaches ffmpeg", async () => {
  // The route is supposed to call validateClipRange first. If it ever stops doing that, a
  // negative -ss or an unbounded -t must not go straight from a request body to a spawn.
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");
  const neverRuns = join(dir, "this-binary-does-not-exist");

  for (const range of [
    { startMs: -1000, endMs: 5000 },
    { startMs: 5000, endMs: 5000 },
    { startMs: 5000, endMs: 1000 },
    { startMs: null, endMs: 5000 },
    { startMs: 0, endMs: "later" }
  ]) {
    await assert.rejects(
      cutClip({ ffmpegPath: neverRuns, sourcePath: recordingPath, targetPath, ...range }),
      (error) => error.code === "invalid_range",
      JSON.stringify(range)
    );
  }
  // A spawn would have reported ffmpeg_missing instead, and the directory would exist.
  await assert.rejects(readdir(join(dir, "clips")), (error) => error.code === "ENOENT");
});

test("a path that did not come from the media store never reaches ffmpeg", async () => {
  // MediaStore's builders return absolute paths under the media root. Anything else got
  // here another way, and a path starting with "-" would be read by ffmpeg as an option.
  const dir = await newDir();
  const neverRuns = join(dir, "this-binary-does-not-exist");

  for (const paths of [
    { sourcePath: "recording.mp4", targetPath: join(dir, "cut.mp4") },
    { sourcePath: recordingPath, targetPath: "-f" },
    { sourcePath: "", targetPath: join(dir, "cut.mp4") },
    { sourcePath: recordingPath, targetPath: undefined }
  ]) {
    await assert.rejects(
      cutClip({ ffmpegPath: neverRuns, startMs: 1000, endMs: 2000, ...paths }),
      (error) => error.code === "invalid_path",
      JSON.stringify(paths)
    );
  }
});

test("a missing ffmpeg is reported as missing, not as a failed cut", async () => {
  const dir = await newDir();
  await assert.rejects(
    cutClip({
      ffmpegPath: join(dir, "no-such-ffmpeg"),
      sourcePath: recordingPath,
      targetPath: join(dir, "clips", "cut.mp4"),
      startMs: 1000,
      endMs: 2000
    }),
    (error) => error.code === "ffmpeg_missing"
  );
});

test("a wedged ffmpeg is killed instead of pinning the request forever", async () => {
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");
  // Writes a partial output and then never exits — a real ffmpeg stuck on a pathological
  // input behaves the same way from out here.
  const wedged = await writeFakeFfmpeg(dir, "wedged.mjs", 'writeFileSync(output, "partial");\nsetTimeout(() => {}, 600000);');

  const startedAt = Date.now();
  await assert.rejects(
    cutClip({ ffmpegPath: wedged, sourcePath: recordingPath, targetPath, startMs: 1000, endMs: 2000, timeoutMs: 150 }),
    (error) => error.code === "clip_timeout"
  );
  // The promise only settles when the process closes, so returning at all proves the kill
  // landed rather than the wait being abandoned.
  assert.ok(Date.now() - startedAt < 30_000, "the cut gave up on its own timeout");
  assert.deepEqual(await readdir(join(dir, "clips")), [], "the half-written clip is cleaned up");
});

test("a failed cut leaves nothing behind at the clip path", async () => {
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");
  const failing = await writeFakeFfmpeg(
    dir,
    "failing.mjs",
    'writeFileSync(output, "partial");\nprocess.stderr.write("Invalid data found when processing input\\n");\nprocess.exit(1);'
  );

  await assert.rejects(
    cutClip({ ffmpegPath: failing, sourcePath: recordingPath, targetPath, startMs: 1000, endMs: 2000 }),
    (error) => error.code === "ffmpeg_failed" && /Invalid data/u.test(error.stderr)
  );
  assert.deepEqual(await readdir(join(dir, "clips")), [], "no partial file is left where a viewer would stream it");
});

test("a cut that produces no video fails instead of storing a clip that plays nothing", async () => {
  // ffmpeg exits 0 for a range that lands past the end of its input, having muxed a header
  // and no frames. Left alone that becomes a clip in the meeting record that opens empty.
  const dir = await newDir();
  const targetPath = join(dir, "clips", "cut.mp4");
  const empty = await writeFakeFfmpeg(dir, "empty.mjs", 'writeFileSync(output, "");');

  await assert.rejects(
    cutClip({ ffmpegPath: empty, sourcePath: recordingPath, targetPath, startMs: 1000, endMs: 2000 }),
    (error) => error.code === "clip_empty"
  );
  assert.deepEqual(await readdir(join(dir, "clips")), []);
});

/* ---------- buildClipRecord ---------- */

test("a new clip is internal: it is born with no share on it", () => {
  const clip = buildClipRecord({ id: "clip-1", label: "Logs by Friday", startMs: 1000, endMs: 5000, bytes: 42 });
  assert.equal(clip.share, null);
  assert.deepEqual(Object.keys(clip), [
    "id",
    "label",
    "startMs",
    "endMs",
    "bytes",
    "createdAt",
    "createdBy",
    "sourceActionItemId",
    "share"
  ]);
});

test("a label is flattened to a single printable line and capped", () => {
  const clip = buildClipRecord({
    id: "clip-1",
    label: `  Dhruv\u0000 will\nshare\tthe logs\u007f  ${"x".repeat(400)}`,
    startMs: 0,
    endMs: 1000
  });
  assert.equal(clip.label.length, 120);
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(clip.label), "no control characters survive into the store");
  assert.match(clip.label, /^Dhruv will share the logs/u);
});

test("a clip with no label still has a name to render", () => {
  assert.equal(buildClipRecord({ id: "clip-1", label: "   ", startMs: 0, endMs: 1000 }).label, "Clip");
  assert.equal(buildClipRecord({ id: "clip-1", startMs: 0, endMs: 1000 }).label, "Clip");
});

test("missing optional fields become null rather than undefined", () => {
  // undefined disappears through JSON.stringify, so a record written with it would come
  // back from the store missing keys the client expects.
  const clip = buildClipRecord({ id: "clip-1", startMs: 0, endMs: 1000 });
  assert.equal(clip.createdBy, null);
  assert.equal(clip.sourceActionItemId, null);
  assert.equal(clip.bytes, 0);
  assert.ok(Number.isFinite(Date.parse(clip.createdAt)));
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(clip))), Object.keys(clip));
});

test("a nonsense range cannot produce a record with a negative or inverted span", () => {
  const clip = buildClipRecord({ id: "clip-1", startMs: -500, endMs: -900, bytes: -1 });
  assert.equal(clip.startMs, 0);
  assert.ok(clip.endMs >= clip.startMs);
  assert.equal(clip.bytes, 0);
});
