// Video capture is additive: it may never be the reason a meeting fails to transcribe.
// Every test here is named after the production failure it locks out — a wrong ffmpeg
// flag that only surfaces as "exited with code 1" an hour into a real call, an unbounded
// upload queue that OOMs the worker (taking the audio capture and the un-flushed
// transcript with it), or a batch that the server rejects whole and that then retries
// forever.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUFFER_CAP_BYTES,
  backpressureAction,
  buildVideoArgs,
  planUploadBatch,
  videoCapExceeded
} from "../src/bot-runner/video-source.js";

const MB = 1024 * 1024;

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

/* ---------- ffmpeg arguments ---------- */

test("x11grab capture grabs the worker's Xvfb display and the PulseAudio monitor", () => {
  const args = buildVideoArgs({
    driver: "x11grab",
    source: ":99",
    framerate: 15,
    size: "1280x720",
    crf: 30,
    preset: "veryfast",
    audioSource: "open_notetaker.monitor"
  });

  assert.deepEqual(args, [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-thread_queue_size",
    "512",
    "-f",
    "x11grab",
    "-framerate",
    "15",
    "-video_size",
    "1280x720",
    "-i",
    ":99",
    "-thread_queue_size",
    "512",
    "-f",
    "pulse",
    "-i",
    "open_notetaker.monitor",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ac",
    "1",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1"
  ]);
});

test("the capture is a fragmented MP4 on an explicit muxer, or a killed worker's file is a brick", () => {
  const args = buildVideoArgs({ driver: "x11grab", source: ":99", audioSource: "open_notetaker.monitor" });

  // A plain MP4 writes its index last, so a worker killed mid-meeting leaves an
  // unplayable file. Fragments keep it readable up to the last complete one, which is
  // exactly what the app-side finalize salvages.
  assert.equal(argValue(args, "-movflags"), "+frag_keyframe+empty_moov+default_base_moof");
  // ffmpeg cannot infer a muxer from "pipe:1" and refuses to start without this.
  assert.equal(args.at(-3), "-f");
  assert.equal(args.at(-2), "mp4");
  assert.equal(args.at(-1), "pipe:1");
});

test("avfoundation takes video and audio as one device and never grows a pulse input", () => {
  const args = buildVideoArgs({
    driver: "avfoundation",
    source: "1:0",
    framerate: 15,
    size: "1280x720",
    // A macOS dev box has no PulseAudio; passing a monitor name must not add an input
    // that would make ffmpeg fail on the second -i.
    audioSource: "open_notetaker.monitor"
  });

  assert.deepEqual(
    args.filter((arg) => arg === "-i"),
    ["-i"]
  );
  assert.ok(!args.includes("pulse"));
  assert.equal(argValue(args, "-f"), "avfoundation");
  assert.equal(argValue(args, "-i"), "1:0");
});

test("x11grab with no audio source records silent video instead of failing to start", () => {
  const args = buildVideoArgs({ driver: "x11grab", source: ":99", audioSource: "" });

  assert.ok(!args.includes("pulse"));
  assert.deepEqual(
    args.filter((arg) => arg === "-i"),
    ["-i"]
  );
});

test("size, framerate, crf and preset reach ffmpeg instead of being silently defaulted", () => {
  const args = buildVideoArgs({
    driver: "x11grab",
    source: ":42",
    framerate: 24,
    size: "1920x1080",
    crf: 18,
    preset: "ultrafast",
    audioSource: "sink.monitor"
  });

  assert.equal(argValue(args, "-video_size"), "1920x1080");
  assert.equal(argValue(args, "-framerate"), "24");
  assert.equal(argValue(args, "-crf"), "18");
  assert.equal(argValue(args, "-preset"), "ultrafast");
  assert.equal(argValue(args, "-i"), ":42");
});

test("the keyframe interval follows the framerate so a truncated file loses two seconds, not two minutes", () => {
  // -g is also the fragment boundary: it is the upper bound on what a killed worker
  // loses off the end of the recording.
  assert.equal(argValue(buildVideoArgs({ driver: "x11grab", source: ":99", framerate: 15 }), "-g"), "30");
  assert.equal(argValue(buildVideoArgs({ driver: "x11grab", source: ":99", framerate: 24 }), "-g"), "48");
});

test("a malformed VIDEO_SIZE is refused at build time, not discovered as an ffmpeg exit code", () => {
  assert.throws(() => buildVideoArgs({ driver: "x11grab", source: ":99", size: "1280*720" }), /VIDEO_SIZE/);
  assert.throws(() => buildVideoArgs({ driver: "x11grab", source: ":99", framerate: 0 }), /VIDEO_FRAMERATE/);
});

test("an unknown capture driver throws instead of spawning something meaningless", () => {
  assert.throws(
    () => buildVideoArgs({ driver: "gdigrab", source: "desktop" }),
    /Unsupported VIDEO_CAPTURE_DRIVER/
  );
});

/* ---------- Backpressure ---------- */

test("a full upload queue pauses the pipe instead of growing the worker's heap", () => {
  // Unbounded buffering is how a slow upload turns into an OOM kill that takes the audio
  // capture and the un-flushed transcript down with the video.
  assert.equal(
    backpressureAction({ pendingBytes: DEFAULT_BUFFER_CAP_BYTES, capBytes: DEFAULT_BUFFER_CAP_BYTES, paused: false }),
    "pause"
  );
  assert.equal(backpressureAction({ pendingBytes: 17 * MB, capBytes: 16 * MB, paused: false }), "pause");
});

test("a paused pipe stays paused until the queue is genuinely drained", () => {
  // Resuming the moment one 64KB chunk lands would let the next chunk re-pause it,
  // thrashing ffmpeg's writer thousands of times a minute.
  assert.equal(backpressureAction({ pendingBytes: 15 * MB, capBytes: 16 * MB, paused: true }), "hold");
  assert.equal(backpressureAction({ pendingBytes: 9 * MB, capBytes: 16 * MB, paused: true }), "hold");
  assert.equal(backpressureAction({ pendingBytes: 8 * MB, capBytes: 16 * MB, paused: true }), "resume");
  assert.equal(backpressureAction({ pendingBytes: 0, capBytes: 16 * MB, paused: true }), "resume");
});

test("a flowing pipe below the cap is left alone", () => {
  assert.equal(backpressureAction({ pendingBytes: 0, capBytes: 16 * MB, paused: false }), "hold");
  assert.equal(backpressureAction({ pendingBytes: 15 * MB, capBytes: 16 * MB, paused: false }), "hold");
});

test("a missing or nonsense cap falls back to the default rather than to unbounded", () => {
  assert.equal(backpressureAction({ pendingBytes: DEFAULT_BUFFER_CAP_BYTES, capBytes: 0, paused: false }), "pause");
  assert.equal(
    backpressureAction({ pendingBytes: DEFAULT_BUFFER_CAP_BYTES, capBytes: Number.NaN, paused: false }),
    "pause"
  );
});

/* ---------- Size ceiling ---------- */

test("one runaway meeting stops at VIDEO_MAX_MB instead of eating the whole disk budget", () => {
  assert.equal(videoCapExceeded({ capturedBytes: 2047 * MB, maxBytes: 2048 * MB }), false);
  assert.equal(videoCapExceeded({ capturedBytes: 2048 * MB, maxBytes: 2048 * MB }), true);
  assert.equal(videoCapExceeded({ capturedBytes: 9000 * MB, maxBytes: 2048 * MB }), true);
});

test("no ceiling configured means unlimited, not zero-length recordings", () => {
  assert.equal(videoCapExceeded({ capturedBytes: 5 * MB, maxBytes: 0 }), false);
  assert.equal(videoCapExceeded({ capturedBytes: 5 * MB, maxBytes: undefined }), false);
  assert.equal(videoCapExceeded({ capturedBytes: 5 * MB, maxBytes: Number.NaN }), false);
});

/* ---------- Upload batching ---------- */

test("a batch never crosses the server's chunk cap, which would reject the whole payload", () => {
  // A rejected batch is retried with the same bytes forever, so the ceiling has to hold
  // here rather than be discovered as a 413.
  const chunks = Array.from({ length: 200 }, () => 64 * 1024);

  const { count, bytes } = planUploadBatch(chunks, { targetBytes: 4 * MB, maxBytes: 6 * MB });

  assert.ok(bytes <= 6 * MB, `batch of ${bytes} bytes exceeds the cap`);
  assert.ok(bytes >= 4 * MB, "a full queue should fill the batch, not dribble");
  assert.equal(count, 64);
});

test("draining a nearly empty queue takes everything rather than waiting for a full batch", () => {
  // The end-of-meeting drain: these are the closing seconds of the recording and there
  // is no next chunk coming to round the batch out.
  const { count, bytes } = planUploadBatch([1000, 2000, 3000], { targetBytes: 4 * MB, maxBytes: 6 * MB });

  assert.equal(count, 3);
  assert.equal(bytes, 6000);
});

test("an empty queue plans no request", () => {
  assert.deepEqual(planUploadBatch([], { targetBytes: 4 * MB, maxBytes: 6 * MB }), { count: 0, bytes: 0 });
});

test("a single chunk larger than the cap is still sent, or the upload loop stalls forever", () => {
  // Cannot happen with ffmpeg's ~64KB pipe writes, but returning zero here would spin
  // the drain loop on a payload it refuses to send and never end the meeting's upload.
  const { count, bytes } = planUploadBatch([9 * MB, 1000], { targetBytes: 4 * MB, maxBytes: 6 * MB });

  assert.equal(count, 1);
  assert.equal(bytes, 9 * MB);
});

test("gives every input its own enlarged packet queue", () => {
  const args = buildVideoArgs({
    driver: "x11grab",
    source: ":99",
    audioSource: "open_notetaker.monitor"
  });

  // One per input. ffmpeg's default of 8 packets is about half a second at 15fps, and a
  // stalled encoder overflows it long before the other input notices.
  const queueFlags = args.filter((arg) => arg === "-thread_queue_size");
  assert.equal(queueFlags.length, 2);

  // The flag configures the input that FOLLOWS it, so it has to sit before each -f.
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-thread_queue_size") continue;
    assert.equal(Number.isInteger(Number(args[i + 1])), true);
    assert.ok(Number(args[i + 1]) >= 512);
    assert.equal(args[i + 2], "-f");
  }
});

test("still enlarges the queue when there is no audio monitor to record", () => {
  const args = buildVideoArgs({ driver: "x11grab", source: ":99", audioSource: "" });
  assert.equal(args.filter((a) => a === "-thread_queue_size").length, 1);
  assert.equal(args.includes("-i"), true);
});
