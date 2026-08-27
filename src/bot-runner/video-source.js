// Screen+audio capture for the recording worker, deliberately a SECOND ffmpeg process
// rather than a second output on the audio one. The audio source feeds transcription
// and transcription is the product: a video encoder that dies, wedges, or eats the box
// must be killable on its own without touching the pipeline that produces the notes.
import { spawn } from "node:child_process";

// ffmpeg's stdout produces frames faster than an HTTP upload drains them, so bytes wait
// in memory between capture and POST. Unbounded, that queue grows the worker's RSS
// until the OOM killer takes the container down — and the container is also holding the
// audio capture and the un-flushed tail of the transcript. At the cap the pipe is
// paused instead: ffmpeg blocks on write and x11grab drops frames, which is exactly the
// thing worth trading away.
export const DEFAULT_BUFFER_CAP_BYTES = 16 * 1024 * 1024;

// Resume well below the cap, not at it. Resuming the moment one 64KB chunk drains would
// let the very next chunk re-pause the pipe, thrashing ffmpeg's writer thousands of
// times a minute for no gain.
const RESUME_RATIO = 0.5;

const SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/u;

// A capture that ignores SIGTERM is not allowed to decide how long teardown takes: the
// meeting's transcript submission is queued behind it.
const STOP_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 2_000;

// Pure so the exact argv can be pinned by tests without spawning anything: an ffmpeg
// flag typo only shows up as "exited with code 1" an hour into a real meeting.
export function buildVideoArgs({
  driver = "x11grab",
  source = "",
  framerate = 15,
  size = "1280x720",
  crf = 30,
  preset = "veryfast",
  audioSource = ""
} = {}) {
  if (!SIZE_PATTERN.test(String(size))) {
    throw new Error(`Invalid VIDEO_SIZE: ${size}. Expected WIDTHxHEIGHT, e.g. 1280x720.`);
  }
  const fps = requirePositiveInt(framerate, "VIDEO_FRAMERATE");
  const quality = requirePositiveInt(crf, "VIDEO_CRF");
  const inputs = [];

  if (driver === "x11grab") {
    inputs.push("-f", "x11grab", "-framerate", String(fps), "-video_size", String(size), "-i", String(source));
    // The video's audio track comes off the same PulseAudio monitor the transcription
    // capture reads; Pulse fans a monitor source out to every reader, so the two ffmpegs
    // do not compete for it. With no monitor configured the recording is silent rather
    // than absent.
    if (audioSource) inputs.push("-f", "pulse", "-i", String(audioSource));
  } else if (driver === "avfoundation") {
    // macOS local dev only. avfoundation takes video and audio as one "<video>:<audio>"
    // device string, so there is no second input to add and audioSource is not used.
    inputs.push("-f", "avfoundation", "-framerate", String(fps), "-video_size", String(size), "-i", String(source));
  } else {
    throw new Error(`Unsupported VIDEO_CAPTURE_DRIVER: ${driver}.`);
  }

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...inputs,
    "-c:v",
    "libx264",
    "-preset",
    String(preset),
    "-crf",
    String(quality),
    // A keyframe every two seconds, which is also the fragment boundary below: it caps
    // what a killed worker loses off the end of the file at two seconds.
    "-g",
    String(fps * 2),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-ac",
    "1",
    // Fragmented MP4 is the whole crash-salvage story: a normal MP4 writes its index
    // last, so a truncated one is an unplayable brick, while this stays playable up to
    // the last complete fragment. empty_moov puts the header first (there is no
    // seekable output to go back and patch) and default_base_moof is what keeps the
    // fragments readable by strict parsers, including the app-side remux.
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    // Without an explicit muxer ffmpeg cannot infer one from "pipe:1".
    "-f",
    "mp4",
    "pipe:1"
  ];
}

// Pure backpressure decision, split out because getting it wrong is invisible until a
// worker OOMs mid-meeting. Hysteresis lives here rather than in the caller.
export function backpressureAction({ pendingBytes, capBytes = DEFAULT_BUFFER_CAP_BYTES, paused = false }) {
  const cap = Number.isFinite(capBytes) && capBytes > 0 ? capBytes : DEFAULT_BUFFER_CAP_BYTES;
  if (!paused && pendingBytes >= cap) return "pause";
  if (paused && pendingBytes <= cap * RESUME_RATIO) return "resume";
  return "hold";
}

// VIDEO_MAX_MB stops one runaway meeting (a screen share of a video call, an encoder
// that never reaches its target bitrate) from eating the whole global disk budget.
// A zero or missing ceiling means unlimited, matching every other optional limit here.
export function videoCapExceeded({ capturedBytes, maxBytes }) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  return capturedBytes >= maxBytes;
}

// How many queued chunks belong in the next POST. The server rejects a body over its
// own chunk cap, and a batch that overshoots it is rejected whole — the same bytes
// would then be retried forever, so the ceiling is enforced here rather than discovered
// as a 413. A lone chunk larger than the ceiling is still returned: video bytes are an
// append-only stream where any split is legal, and returning zero would stall the loop.
export function planUploadBatch(chunkSizes, { targetBytes, maxBytes }) {
  let bytes = 0;
  let count = 0;
  for (const size of chunkSizes) {
    if (count > 0 && bytes + size > maxBytes) break;
    bytes += size;
    count += 1;
    if (bytes >= targetBytes) break;
  }
  return { count, bytes };
}

export class FfmpegVideoSource {
  constructor({
    ffmpegPath = "ffmpeg",
    driver = "x11grab",
    source = ":99",
    framerate = 15,
    size = "1280x720",
    crf = 30,
    preset = "veryfast",
    audioSource = "",
    bufferCapBytes = DEFAULT_BUFFER_CAP_BYTES
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.driver = driver;
    this.source = source;
    this.framerate = framerate;
    this.size = size;
    this.crf = crf;
    this.preset = preset;
    this.audioSource = audioSource;
    this.bufferCapBytes = bufferCapBytes;
    this.process = null;
    this.closed = Promise.resolve(null);
    this.paused = false;
    this.bytesCaptured = 0;
    this.lastStderr = "";
  }

  start(onChunk, { onExit, onStderr } = {}) {
    if (this.process) throw new Error("Video capture is already running.");
    this.bytesCaptured = 0;
    this.lastStderr = "";
    this.paused = false;
    const child = spawn(this.ffmpegPath, this.buildArgs(), { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;

    child.stdout.on("data", (chunk) => {
      this.bytesCaptured += chunk.length;
      onChunk(chunk);
    });
    // A ChildProcess or a pipe that emits "error" with no listener throws, and an
    // uncaught throw in the worker kills the audio capture and the un-flushed transcript
    // with it. All three listeners exist for that reason alone: a missing ffmpeg binary
    // (spawn ENOENT) and the EPIPE that follows a SIGKILL are the two real cases, and
    // stderr is as much a pipe as stdout is — teardown can tear either of them.
    child.on("error", (error) => {
      this.lastStderr = error.message;
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      this.lastStderr = line.slice(-1000);
      onStderr?.(this.lastStderr);
      console.error(`[ffmpeg:video] ${line.slice(0, 500)}`);
    });

    this.closed = new Promise((resolve) => {
      // "close", not "exit": exit fires while stdout can still be holding the tail of
      // the last fragment, and those are the bytes that decide whether the final seconds
      // of the meeting are in the file.
      child.on("close", (code, signal) => {
        this.process = null;
        const outcome = { code, signal, bytesCaptured: this.bytesCaptured, lastStderr: this.lastStderr };
        console.log(`video capture exited with code ${code ?? "none"} and signal ${signal ?? "none"}`);
        onExit?.(outcome);
        resolve(outcome);
      });
    });

    return child;
  }

  // Called by the uploader with its own queue depth: the source owns stdout, so it is
  // the only thing that can push back on ffmpeg, but it has no idea how far behind the
  // upload is. Returns whether the pipe is now paused.
  applyBackpressure(pendingBytes) {
    const action = backpressureAction({
      pendingBytes,
      capBytes: this.bufferCapBytes,
      paused: this.paused
    });
    const stdout = this.process?.stdout;
    if (!stdout) return this.paused;
    if (action === "pause") {
      stdout.pause();
      this.paused = true;
    } else if (action === "resume") {
      stdout.resume();
      this.paused = false;
    }
    return this.paused;
  }

  async stop({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
    const child = this.process;
    if (!child) return { bytesCaptured: this.bytesCaptured, lastStderr: this.lastStderr };

    // Resume before signalling. ffmpeg blocked writing into a paused pipe never reaches
    // the point where it acts on SIGTERM, so stopping a backed-up capture without this
    // hangs until the SIGKILL below — and throws away the trailing fragment.
    child.stdout.resume();
    this.paused = false;
    child.kill("SIGTERM");

    const outcome = await Promise.race([this.closed, delay(timeoutMs).then(() => null)]);
    if (!outcome) {
      child.kill("SIGKILL");
      await Promise.race([this.closed, delay(KILL_TIMEOUT_MS)]);
    }
    return { bytesCaptured: this.bytesCaptured, lastStderr: this.lastStderr };
  }

  buildArgs() {
    return buildVideoArgs({
      driver: this.driver,
      source: this.source,
      framerate: this.framerate,
      size: this.size,
      crf: this.crf,
      preset: this.preset,
      audioSource: this.audioSource
    });
  }
}

function requirePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}: ${value}.`);
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
