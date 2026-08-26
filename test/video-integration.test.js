// Integration tests for video: boot the real server and put a real MP4 through it.
//
// The unit tests cover MediaStore, the range parser, clip cutting and the share model in
// isolation. What only exists once the HTTP layer, the store and ffmpeg are all in play is
// the seam between them: that the resume protocol the worker implements is the one the
// server speaks, that a finalized recording is still a file a player can open, that a
// Range response carries the bytes it claims, and that the one credential in this feature
// — the share token — never comes back out of the store in any serialization.
//
// Everything here needs a real ffmpeg. Where it is missing the tests skip with a reason
// rather than asserting something weaker, because the thing they are checking is precisely
// that the bytes survived the round trip.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const RUNNER_TOKEN = "video-integration-token";
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

// config.js calls loadDotEnv(), so the developer's own .env in the repo root reaches every
// server spawned here for any key the test does not set. Everything these tests assert on
// is therefore pinned, not defaulted — VIDEO_RECORDING_ENABLED because it is off unless an
// operator opts in, and the rest because a local override of any of them would fail the
// suite with a message about video that is really a message about someone's .env.
const VIDEO_ENV = {
  VIDEO_RECORDING_ENABLED: "true",
  VIDEO_RECORD_BY_DEFAULT: "true",
  VIDEO_MAX_MB: "2048",
  VIDEO_MAX_CLIP_SECONDS: "300",
  VIDEO_RETENTION_DAYS: "7",
  VIDEO_SHARE_DEFAULT_DAYS: "7",
  // The real floor is 5GB. These fixtures are ~100KB, so a developer box that is merely
  // tight on space would fail every test here as "low_disk" — a true statement about the
  // box that says nothing about the code.
  VIDEO_MIN_FREE_DISK_GB: "1",
  FFMPEG_PATH: ffmpegPath
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

// Fragmented MP4, the same container the worker writes: finalize's whole crash-salvage
// story rests on a partial upload still being readable, and a plain MP4 fixture would test
// a file shape this feature never produces.
async function writeCapture(path) {
  await run(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=4:size=640x480:rate=15",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    // Near-lossless on purpose: a well-compressed test pattern is a few tens of KB, and
    // the upload protocol is only exercised by a file big enough to need several chunks.
    "-qp",
    "12",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "-y",
    path
  ]);
}

const fixtureDir = await mkdtemp(join(tmpdir(), "opennotetaker-video-fixture-"));
after(() => rm(fixtureDir, { recursive: true, force: true }));

const capturePath = join(fixtureDir, "capture.mp4");
const noVideo = await (async () => {
  try {
    await writeCapture(capturePath);
  } catch (error) {
    return `${ffmpegPath} with libx264 is not available here (${error.message})`;
  }
  const { bsize, bavail } = await statfs(tmpdir());
  // VIDEO_MIN_FREE_DISK_GB above is 1GB; below that the server correctly refuses to record
  // and the failure would look like a bug in this file.
  if (bsize * bavail < 2 * 1024 ** 3) return `${tmpdir()} has under 2GB free, and video uploads refuse a full disk`;
  return false;
})();
const capture = noVideo ? Buffer.alloc(0) : await readFile(capturePath);

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Takes an existing dataDir so a test can stop the server, edit the store, and boot again
// on the same data — the only way to reach a state the API deliberately refuses to mint
// (buildShareRecord clamps every window to at least one day, so no request can create an
// already-expired link).
async function startServer({ dataDir: existingDir, env = {} } = {}) {
  const dataDir = existingDir || (await mkdtemp(join(tmpdir(), "opennotetaker-video-")));
  const port = await freePort();
  const child = spawn(process.execPath, [join(rootDir, "src", "server.js")], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      BOT_PROVIDER: "fleet",
      LLM_PROVIDER: "mock",
      RUNNER_TOKEN,
      GOOGLE_CALENDAR_SYNC_ENABLED: "false",
      // Share links are minted from the operator's public base URL rather than from the
      // socket a request arrived on — correct behind a proxy, and the reason this must be
      // pinned to the ephemeral port instead of inherited from a developer's .env.
      OPENNOTETAKER_BASE_URL: `http://127.0.0.1:${port}`,
      ...VIDEO_ENV,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      const health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Captured once rather than per call: a second stop() would otherwise wait on an "exit"
  // that already fired and never resolve, which surfaces as the whole test file hanging.
  const exited = new Promise((resolve) => child.once("exit", resolve));

  return {
    baseUrl,
    port,
    dataDir,
    logs,
    async stop({ keepData = false } = {}) {
      child.kill("SIGKILL");
      await exited;
      if (!keepData) await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function signUp(baseUrl, email) {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", name: "Test" })
  });
  const body = await response.text();
  assert.equal(response.status, 201, `signup failed: ${body}`);
  const cookie = (response.headers.getSetCookie?.() || [])
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie, "signup must set a session cookie");
  return cookie;
}

async function createMeeting(baseUrl, cookie, body = {}) {
  const response = await fetch(`${baseUrl}/api/meetings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Video integration meeting",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      retentionDays: 30,
      ...body
    })
  });
  const text = await response.text();
  assert.equal(response.status, 201, `create failed: ${text}`);
  return JSON.parse(text).meeting;
}

function uploadChunk(server, meetingId, offset, chunk) {
  return fetch(`${server.baseUrl}/api/runner/meetings/${meetingId}/video?offset=${offset}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/octet-stream" },
    body: chunk
  });
}

function finalizeVideo(server, meetingId) {
  return fetch(`${server.baseUrl}/api/runner/meetings/${meetingId}/video/finalize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
  });
}

function chunksOf(buffer, size) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return chunks;
}

// The worker's happy path, compressed: create the meeting, stream the capture up in
// chunks taking the server's reported size as the next offset every time, then finalize.
async function recordMeeting(server, cookie, { chunkSize = 40 * 1024 } = {}) {
  const meeting = await createMeeting(server.baseUrl, cookie);
  let offset = 0;
  for (const chunk of chunksOf(capture, chunkSize)) {
    const response = await uploadChunk(server, meeting.id, offset, chunk);
    // Read the body once: an assert message is a template literal, so awaiting the text in
    // it would consume the body whether or not the assertion fails.
    const body = await response.text();
    assert.equal(response.status, 200, `chunk at ${offset} was refused: ${body}`);
    offset = JSON.parse(body).bytesReceived;
  }
  const finalized = await finalizeVideo(server, meeting.id);
  const finalizedBody = await finalized.text();
  assert.equal(finalized.status, 200, `finalize failed: ${finalizedBody}`);
  const { video } = JSON.parse(finalizedBody);
  assert.equal(video.status, "ready");
  return { meeting, video };
}

async function createClip(server, cookie, meetingId, body = {}) {
  const response = await fetch(`${server.baseUrl}/api/meetings/${meetingId}/clips`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Decision", startMs: 500, endMs: 1500, ...body })
  });
  const text = await response.text();
  assert.equal(response.status, 201, `clip failed: ${text}`);
  return JSON.parse(text).clip;
}

async function mintShare(server, cookie, meetingId, clipId, body = {}) {
  const response = await fetch(`${server.baseUrl}/api/meetings/${meetingId}/clips/${clipId}/share`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInDays: 7, ...body })
  });
  const text = await response.text();
  assert.equal(response.status, 201, `share failed: ${text}`);
  const payload = JSON.parse(text);
  assert.ok(payload.url.startsWith(`${server.baseUrl}/s/`), `share url points at this server: ${payload.url}`);
  return { ...payload, token: payload.url.slice(`${server.baseUrl}/s/`.length), body: text };
}

/* ---------- Upload protocol ---------- */

test("a capture uploads in chunks, survives a retry, and refuses a gap", { skip: noVideo }, async (t) => {
  // The three things the worker actually depends on. It keeps no server-side sequence
  // state: it sends bytes at an offset and takes the reported size as its next cursor,
  // which is what makes a restart on either end recoverable — and what makes an
  // off-by-one here corrupt every recording rather than fail loudly.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);
  assert.equal(meeting.video.enabled, true, "recording defaults on once the operator has enabled it");
  assert.equal(meeting.video.status, "pending");

  const [first, second, ...rest] = chunksOf(capture, 24 * 1024);
  assert.ok(rest.length >= 1, "the fixture must be big enough to need several chunks");

  const firstResponse = await uploadChunk(server, meeting.id, 0, first);
  assert.equal(firstResponse.status, 200);
  // The TOTAL held, not this chunk's length. Sending the length instead would put every
  // upload after the first one at the wrong offset.
  assert.equal((await firstResponse.json()).bytesReceived, first.length);

  const recording = await (
    await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
    })
  ).json();
  assert.equal(recording.meeting.video.status, "recording", "the first bytes move the record once");

  const secondResponse = await uploadChunk(server, meeting.id, first.length, second);
  assert.equal(secondResponse.status, 200);
  const afterSecond = (await secondResponse.json()).bytesReceived;
  assert.equal(afterSecond, first.length + second.length);

  // A retry of a chunk that already landed: the worker resends whenever a response is lost,
  // and an append here would splice a duplicate into the stream that nothing downstream
  // could detect.
  const replay = await uploadChunk(server, meeting.id, first.length, second);
  assert.equal(replay.status, 200, "a replayed chunk is accepted, not rejected");
  assert.equal((await replay.json()).bytesReceived, afterSecond, "and it appends nothing");

  // A hole cannot be filled after the fact, so the server refuses rather than writing a
  // recording with a gap in the middle, and says where the file actually ends.
  const gap = await uploadChunk(server, meeting.id, afterSecond + 4096, rest[0]);
  assert.equal(gap.status, 409);
  assert.deepEqual(await gap.json(), { error: "offset_gap", expected: afterSecond });

  const badOffset = await uploadChunk(server, meeting.id, "abc", rest[0]);
  assert.equal(badOffset.status, 400, "a non-numeric offset is refused, never read as zero");

  let offset = afterSecond;
  for (const chunk of rest) {
    const response = await uploadChunk(server, meeting.id, offset, chunk);
    assert.equal(response.status, 200);
    offset = (await response.json()).bytesReceived;
  }
  // The proof that the replay did not double-append: a duplicated chunk would leave the
  // part longer than the file that was sent.
  assert.equal(offset, capture.length, "exactly the captured bytes are held, no more");

  const finalized = await finalizeVideo(server, meeting.id);
  assert.equal(finalized.status, 200);
  const { video } = await finalized.json();
  assert.equal(video.status, "ready");
  assert.ok(video.bytes > 0);
  assert.ok(video.durationMs >= 3500, `a 4s capture reports about 4s, got ${video.durationMs}ms`);
  assert.equal(video.width, 640);
  assert.equal(video.height, 480);
  assert.ok(video.capturedAt, "retention is anchored on capturedAt, so finalize must stamp it");

  // The worker abandons a slow finalize and retries; re-running it must not report a ready
  // recording as failed just because the .part it consumed is gone.
  const again = await finalizeVideo(server, meeting.id);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).video.status, "ready");
});

test("a meeting that opted out of recording refuses bytes", { skip: noVideo }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner, { recordVideo: false });
  assert.equal(meeting.video.enabled, false);
  // "skipped", not "pending": a meeting that opted out must not look like one whose
  // recording is still on its way.
  assert.equal(meeting.video.status, "skipped");

  const refused = await uploadChunk(server, meeting.id, 0, capture.subarray(0, 1024));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "video_disabled");
});

test("the dashboard can find out whether video is on at all", async (t) => {
  // The client cannot ask the config; it asks this route, and a failure means "no video".
  // While it was missing the request fell through to the static handler, which answered
  // index.html with a 200 — so the dashboard failed closed and hid the per-meeting opt-out
  // checkbox on an install that was recording every meeting by default. The flags are not
  // secret, but they describe this install, so a session is required to read them.
  const server = await startServer({ env: { VIDEO_MAX_CLIP_SECONDS: "120", VIDEO_SHARE_DEFAULT_DAYS: "3" } });
  t.after(() => server.stop());

  const anonymous = await fetch(`${server.baseUrl}/api/features`);
  assert.equal(anonymous.status, 401);

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const response = await fetch(`${server.baseUrl}/api/features`, { headers: { Cookie: owner } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /application\/json/u, "not the static index.html");
  const { features } = await response.json();
  assert.deepEqual(features.video, {
    enabled: true,
    recordByDefault: true,
    // Read off this server's own config rather than a copy of the defaults, or the UI
    // would draw caps the server does not enforce.
    retentionDays: 7,
    maxClipSeconds: 120,
    shareDefaultDays: 3
  });
});

test("with video off the flag says so and a meeting carries no video at all", async (t) => {
  // The default posture for an install that never opted in: not a disabled player, no
  // video field on the record whatsoever, because there is no consent decision to record.
  const server = await startServer({ env: { VIDEO_RECORDING_ENABLED: "false" } });
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const { features } = await (await fetch(`${server.baseUrl}/api/features`, { headers: { Cookie: owner } })).json();
  assert.equal(features.video.enabled, false);

  // Even asked for explicitly: the operator switch wins over the request.
  const meeting = await createMeeting(server.baseUrl, owner, { recordVideo: true });
  assert.equal(meeting.video, undefined);
  assert.deepEqual(meeting.clips ?? [], []);

  const refused = await uploadChunk(server, meeting.id, 0, Buffer.from("not video"));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "video_disabled");
  assert.equal((await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/video`, { headers: { Cookie: owner } })).status, 404);
});

/* ---------- Playback ---------- */

test("the finalized recording is a playable file served correctly over Range", { skip: noVideo }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const { meeting, video } = await recordMeeting(server, owner);

  const whole = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/video`, { headers: { Cookie: owner } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
  const bytes = Buffer.from(await whole.arrayBuffer());
  assert.equal(bytes.length, video.bytes, "the served file is the one finalize measured");

  // What the whole feature is for: the bytes that come back are still a video. A remux
  // that produced a plausible-looking but unopenable file would pass every byte-count
  // assertion above.
  const playablePath = join(fixtureDir, "served.mp4");
  await writeFile(playablePath, bytes);
  const decoded = await run(ffmpegPath, ["-hide_banner", "-v", "error", "-i", playablePath, "-f", "null", "-"]);
  assert.equal(decoded.trim(), "", `the served recording decodes without errors: ${decoded}`);

  const range = async (header) =>
    fetch(`${server.baseUrl}/api/meetings/${meeting.id}/video`, {
      headers: { Cookie: owner, Range: header }
    });

  const middle = await range("bytes=1000-1999");
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get("content-range"), `bytes 1000-1999/${bytes.length}`);
  assert.equal(middle.headers.get("content-length"), "1000");
  assert.deepEqual(Buffer.from(await middle.arrayBuffer()), bytes.subarray(1000, 2000), "the slice is byte-exact");

  // The two forms a player actually sends: an open-ended read while streaming, and a
  // suffix read to find the moov atom.
  const openEnded = await range(`bytes=${bytes.length - 500}-`);
  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers.get("content-range"), `bytes ${bytes.length - 500}-${bytes.length - 1}/${bytes.length}`);
  assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), bytes.subarray(bytes.length - 500));

  const suffix = await range("bytes=-256");
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 256));

  // An end past EOF is clamped rather than refused; players ask for more than is there all
  // the time and a 416 would stall playback.
  const overshoot = await range(`bytes=0-${bytes.length + 10_000}`);
  assert.equal(overshoot.status, 206);
  assert.equal(overshoot.headers.get("content-range"), `bytes 0-${bytes.length - 1}/${bytes.length}`);

  const past = await range(`bytes=${bytes.length}-`);
  assert.equal(past.status, 416, "a start past the end is unsatisfiable, not an empty 206");
  assert.equal(past.headers.get("content-range"), `bytes */${bytes.length}`);

  const head = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/video`, {
    method: "HEAD",
    headers: { Cookie: owner }
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.text()).length, 0);
});

test("another account cannot see, play or clip a recording", { skip: noVideo }, async (t) => {
  // 404 everywhere, never 403: a 403 confirms the recording exists, which is the one thing
  // an id someone guessed must not learn.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const intruder = await signUp(server.baseUrl, "intruder@example.com");
  const { meeting } = await recordMeeting(server, owner);
  const clip = await createClip(server, owner, meeting.id);

  const base = `${server.baseUrl}/api/meetings/${meeting.id}`;
  const attempts = [
    ["GET", `${base}/video`],
    ["GET", `${base}/clips`],
    ["GET", `${base}/clips/${clip.id}`],
    ["DELETE", `${base}/clips/${clip.id}`],
    ["POST", `${base}/clips/${clip.id}/share`],
    ["DELETE", `${base}/clips/${clip.id}/share`],
    // A crafted id must be refused by the route, not by ffmpeg or the filesystem.
    ["GET", `${server.baseUrl}/api/meetings/${meeting.id}/clips/..%2F..%2Fmeetings.json`],
    ["GET", `${server.baseUrl}/api/meetings/not-a-uuid/video`]
  ];

  for (const [method, target] of attempts) {
    const response = await fetch(target, {
      method,
      headers: { Cookie: intruder, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {})
    });
    assert.equal(response.status, 404, `${method} ${target}`);
  }

  const clipAttempt = await fetch(`${base}/clips`, {
    method: "POST",
    headers: { Cookie: intruder, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "theirs", startMs: 0, endMs: 1000 })
  });
  assert.equal(clipAttempt.status, 404);

  // Signed out entirely is 401 — there is no session to scope, so there is nothing to hide.
  const anonymous = await fetch(`${base}/video`);
  assert.equal(anonymous.status, 401);
  assert.equal(server.logs.join("").includes("internal_error"), false, "none of that reached an error handler");
});

/* ---------- Clips and public links ---------- */

test("a clip can be cut, shared publicly, then revoked", { skip: noVideo }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const { meeting } = await recordMeeting(server, owner);

  const clip = await createClip(server, owner, meeting.id, { startMs: 500, endMs: 1500 });
  assert.equal(clip.startMs, 500);
  assert.equal(clip.endMs, 1500);
  assert.ok(clip.bytes > 0, "the record carries the cut's real size, or the disk budget under-counts it");
  assert.equal(clip.share, null);

  const clipBody = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}`, {
    headers: { Cookie: owner }
  });
  assert.equal(clipBody.status, 200);
  const clipBytes = Buffer.from(await clipBody.arrayBuffer());
  assert.equal(clipBytes.length, clip.bytes);

  const share = await mintShare(server, owner, meeting.id, clip.id);
  assert.ok(Date.parse(share.expiresAt) > Date.now());

  const played = await fetch(`${server.baseUrl}/s/${share.token}`);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get("content-type"), "video/mp4");
  assert.equal(played.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(played.headers.get("referrer-policy"), "no-referrer");
  assert.equal(played.headers.get("cache-control"), "private, no-store");
  assert.equal(played.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(
    Buffer.from(await played.arrayBuffer()),
    clipBytes,
    "the public link serves the same clip the owner sees"
  );

  const publicRange = await fetch(`${server.baseUrl}/s/${share.token}`, { headers: { Range: "bytes=0-99" } });
  assert.equal(publicRange.status, 206, "a public clip is seekable too, or a browser cannot scrub it");
  assert.deepEqual(Buffer.from(await publicRange.arrayBuffer()), clipBytes.subarray(0, 100));

  const unknown = await fetch(`${server.baseUrl}/s/${"a".repeat(43)}`);
  assert.equal(unknown.status, 404);

  // Views are deduped over a window on purpose: one playback is a burst of Range requests
  // and every store write rewrites the whole of meetings.json.
  const viewed = await (await fetch(`${server.baseUrl}/api/meetings/${meeting.id}`, { headers: { Cookie: owner } })).json();
  const viewedClip = viewed.meeting.clips.find((entry) => entry.id === clip.id);
  assert.equal(viewedClip.share.active, true);
  assert.equal(viewedClip.share.views, 1, "two requests inside the dedupe window are one view");

  // Regenerating is the only way back to a link, since the raw token was never stored.
  const regenerated = await mintShare(server, owner, meeting.id, clip.id);
  assert.notEqual(regenerated.token, share.token);
  assert.equal((await fetch(`${server.baseUrl}/s/${share.token}`)).status, 404, "the replaced link dies immediately");
  assert.equal((await fetch(`${server.baseUrl}/s/${regenerated.token}`)).status, 200);

  const revoked = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}/share`, {
    method: "DELETE",
    headers: { Cookie: owner }
  });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${server.baseUrl}/s/${regenerated.token}`)).status, 404, "a revoked link is dead");

  // The owner keeps the clip; only the public link went away.
  const stillThere = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}`, {
    headers: { Cookie: owner }
  });
  assert.equal(stillThere.status, 200);

  const deleted = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}`, {
    method: "DELETE",
    headers: { Cookie: owner }
  });
  assert.equal(deleted.status, 200);
  assert.ok((await deleted.json()).bytesFreed > 0, "deleting a clip reports the bytes it actually reclaimed");
  assert.equal(
    (await fetch(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}`, { headers: { Cookie: owner } })).status,
    404
  );
});

test("an expired share link is as dead as a revoked one", { skip: noVideo }, async (t) => {
  // buildShareRecord clamps every window to at least a day, so an expired link cannot be
  // created through the API. Mint a live one, stop the server, age the record in the store
  // and boot again on the same data — which also proves expiry is decided at read time
  // rather than by a timer that a restart would lose.
  const first = await startServer();
  const dataDir = first.dataDir;
  // Registered before anything can throw: a server left running holds the test runner's
  // event loop open long after the assertions have finished.
  t.after(() => first.stop({ keepData: true }));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const owner = await signUp(first.baseUrl, "owner@example.com");
  const { meeting } = await recordMeeting(first, owner);
  const clip = await createClip(first, owner, meeting.id);
  const share = await mintShare(first, owner, meeting.id, clip.id, { expiresInDays: 1 });
  assert.equal((await fetch(`${first.baseUrl}/s/${share.token}`)).status, 200, "live before it is aged");
  await first.stop({ keepData: true });

  const storePath = join(dataDir, "meetings.json");
  const state = JSON.parse(await readFile(storePath, "utf8"));
  const stored = state.meetings.find((entry) => entry.id === meeting.id).clips.find((entry) => entry.id === clip.id);
  assert.ok(stored.share.tokenHash, "the store keeps the hash, which is what makes the link recoverable-proof");
  stored.share.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const second = await startServer({ dataDir });
  t.after(() => second.stop({ keepData: true }));

  const expired = await fetch(`${second.baseUrl}/s/${share.token}`);
  assert.equal(expired.status, 404, "an expired link is refused");
  // Identical to the unknown-token answer: telling a prober that their guess hit a real but
  // expired link is exactly the signal the token exists to deny.
  assert.deepEqual(await expired.json(), { error: "not_found" });
  const missing = await fetch(`${second.baseUrl}/s/${"b".repeat(43)}`);
  assert.deepEqual(await missing.json(), { error: "not_found" });

  const owner2 = await signUp(second.baseUrl, "owner2@example.com");
  assert.ok(owner2, "the store survived the edit and the server still works");
});

/* ---------- The one credential in this feature ---------- */

test("no response body anywhere carries a share token or its hash", { skip: noVideo }, async (t) => {
  // The raw token is returned exactly once, at creation. Everything else the store holds is
  // the sha256, and a leak of meetings.json must not hand over live video links — which is
  // only true while no serialization path publishes the hash either.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const { meeting } = await recordMeeting(server, owner);
  const clip = await createClip(server, owner, meeting.id, { label: "Budget decision" });
  const share = await mintShare(server, owner, meeting.id, clip.id);
  const tokenHash = createHash("sha256").update(share.token).digest("hex");

  // Warm every field a share touches before sampling: a view stamp, an event log line, and
  // a second share record are all things that could carry the token if written carelessly.
  await fetch(`${server.baseUrl}/s/${share.token}`);

  const owned = (target, init = {}) =>
    fetch(target, { ...init, headers: { Cookie: owner, "Content-Type": "application/json", ...(init.headers || {}) } });

  const bodies = [
    ["meeting list", await owned(`${server.baseUrl}/api/meetings`)],
    ["meeting detail", await owned(`${server.baseUrl}/api/meetings/${meeting.id}`)],
    ["clip list", await owned(`${server.baseUrl}/api/meetings/${meeting.id}/clips`)],
    [
      "runner view",
      await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
        headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
      })
    ],
    [
      "markdown export",
      await owned(`${server.baseUrl}/api/meetings/export`, {
        method: "POST",
        body: JSON.stringify({ meetingIds: [meeting.id], format: "md" })
      })
    ],
    [
      "json export",
      await owned(`${server.baseUrl}/api/meetings/export`, {
        method: "POST",
        body: JSON.stringify({ meetingIds: [meeting.id], format: "json" })
      })
    ],
    [
      "second clip",
      await owned(`${server.baseUrl}/api/meetings/${meeting.id}/clips`, {
        method: "POST",
        body: JSON.stringify({ label: "Another", startMs: 1000, endMs: 2000 })
      })
    ],
    [
      "share revoke",
      await owned(`${server.baseUrl}/api/meetings/${meeting.id}/clips/${clip.id}/share`, { method: "DELETE" })
    ]
  ];

  for (const [label, response] of bodies) {
    const text = await response.text();
    assert.ok(response.status < 400, `${label} answered ${response.status}: ${text.slice(0, 200)}`);
    // The field name, in case a rename keeps the value; the value, in case a rename keeps
    // the leak.
    assert.equal(text.includes("tokenHash"), false, `${label} names the hash field`);
    assert.equal(text.includes(tokenHash), false, `${label} carries the hash value`);
    assert.equal(text.includes(share.token), false, `${label} carries the raw token`);
  }

  // The creation response is the single exception, and it is the raw token only — the hash
  // does not ride along with it.
  assert.ok(share.body.includes(share.token));
  assert.equal(share.body.includes(tokenHash), false);

  // Nor does the token reach the server's own logs, where it would outlive the link.
  assert.equal(server.logs.join("").includes(share.token), false, "the raw token is never logged");

  const stored = JSON.parse(await readFile(join(server.dataDir, "meetings.json"), "utf8"));
  const storedText = JSON.stringify(stored);
  assert.equal(storedText.includes(share.token), false, "the raw token is never written down");
  assert.ok(storedText.includes(tokenHash), "only its hash is, which is what a revoke still needs to match");
});

/* ---------- Consent ---------- */

test("a meeting that never saw the create dialog can still be opted out of", { skip: noVideo }, async (t) => {
  // Calendar sync imports meetings with no checkbox anywhere in the flow, and it is the
  // path most meetings arrive on. Without this route the owner of an auto-imported meeting
  // has no way to answer the consent question, and the artifact is video of every
  // participant's face and whatever they shared.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);
  assert.equal(meeting.video.enabled, true, "the operator default is on, which is what makes an opt-out necessary");

  const patch = (body, cookie = owner) =>
    fetch(`${server.baseUrl}/api/meetings/${meeting.id}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

  const off = await patch({ recordVideo: false });
  const offBody = await off.text();
  assert.equal(off.status, 200, `opt-out failed: ${offBody}`);
  assert.equal(JSON.parse(offBody).meeting.video.enabled, false);
  assert.equal(JSON.parse(offBody).meeting.video.status, "skipped", "not 'pending', which promises a recording");

  // The opt-out is enforced on the upload route, not just in the UI: a worker on an older
  // image must not be able to record a meeting whose owner said no.
  const refused = await uploadChunk(server, meeting.id, 0, capture.subarray(0, 4096));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "video_disabled");

  assert.equal((await patch({ recordVideo: true })).status, 200, "and it can be turned back on");
  assert.equal((await patch({ recordVideo: "yes" })).status, 400, "a non-boolean is refused, not coerced");

  // Somebody else's meeting is a 404 here exactly as it is everywhere else.
  const stranger = await signUp(server.baseUrl, "stranger@example.com");
  assert.equal((await patch({ recordVideo: false }, stranger)).status, 404);

  // Once the bot is on its way the decision has been acted on; flipping it then would
  // promise a recording of the part nobody captured.
  await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "recording" })
  });
  const late = await patch({ recordVideo: false });
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error, "not_scheduled");
});

test("the session response carries the feature flags the create dialog needs", { skip: noVideo }, async (t) => {
  // The client draws no opt-out checkbox until it knows video exists, while the server
  // records by default the whole time. Sending the flags with the session closes the
  // window where those two disagree.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const me = await (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { Cookie: owner } })).json();

  assert.equal(me.features.video.enabled, true);
  assert.equal(me.features.video.recordByDefault, true);
  assert.equal(me.features.video.retentionDays, 7);
});

/* ---------- Retention ---------- */

test("a re-recorded meeting is not exempt from retention by the purge that came before it", { skip: noVideo }, async (t) => {
  // video.purgedAt short-circuits every sweep, and patchVideo merges, so a marker left by
  // a purge would outlive the recording it belonged to: the replacement would never expire
  // and never be evictable while still counting against the disk budget.
  const first = await startServer();
  const owner = await signUp(first.baseUrl, "owner@example.com");
  const { meeting } = await recordMeeting(first, owner);
  await first.stop({ keepData: true });

  // The state a purge leaves behind, reached by hand: minting it through the API would
  // need a retention window to elapse.
  const storePath = join(first.dataDir, "meetings.json");
  const data = JSON.parse(await readFile(storePath, "utf8"));
  const record = (data.meetings || data).find?.((entry) => entry.id === meeting.id) || data[meeting.id];
  record.video = { ...record.video, status: "purged", purgedAt: new Date().toISOString(), bytes: 0 };
  await writeFile(storePath, JSON.stringify(data));

  const second = await startServer({ dataDir: first.dataDir });
  t.after(() => second.stop());

  let offset = 0;
  for (const chunk of chunksOf(capture, 40 * 1024)) {
    const response = await uploadChunk(second, meeting.id, offset, chunk);
    const body = await response.text();
    assert.equal(response.status, 200, `re-record chunk at ${offset} was refused: ${body}`);
    offset = JSON.parse(body).bytesReceived;
  }
  const finalized = await finalizeVideo(second, meeting.id);
  const finalizedBody = await finalized.text();
  assert.equal(finalized.status, 200, `re-finalize failed: ${finalizedBody}`);

  const { video } = JSON.parse(finalizedBody);
  assert.equal(video.status, "ready");
  assert.equal(video.purgedAt, null, "the new recording starts a fresh retention window");
});
