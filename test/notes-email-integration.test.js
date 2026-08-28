// Integration tests for the notes-email composer endpoint: boot the real server and talk
// to it over HTTP.
//
// The unit tests (notes-email-selection.test.js, notes-email-render.test.js) cover the
// pure modules in isolation. What only exists once the HTTP layer is in play is auth,
// ownership scoping (404 vs 403), status-code mapping from the domain module's error
// codes, and — the actual point of this task — that a send leaves an audit trail behind.
//
// Sending mail for real needs a connected Gmail OAuth token, which this harness cannot
// provision (see the note above the "send" describe block at the bottom of the file for
// exactly what that leaves untested).
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const RUNNER_TOKEN = "notes-email-integration-token";

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

// Boots the server against its own DATA_DIR so each test gets a clean store, and
// resolves once /api/health answers.
async function startServer(env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "opennotetaker-notes-email-"));
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
      // This suite never intends to reach a real Gmail send (every case here is rejected
      // before that point, or is a preview). Blanking these rather than inheriting a
      // developer's real .env values means a bug that lets a test fall through to the
      // send path fails loudly against no credentials instead of quietly calling Google.
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
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

  return {
    baseUrl,
    port,
    logs,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dataDir, { recursive: true, force: true });
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

async function createMeeting(baseUrl, cookie, title = "Notes email meeting") {
  const response = await fetch(`${baseUrl}/api/meetings`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      meetUrl: "https://meet.google.com/abc-defg-hij",
      retentionDays: 30
    })
  });
  const body = await response.text();
  assert.equal(response.status, 201, `create failed: ${body}`);
  return JSON.parse(body).meeting;
}

async function getMeeting(baseUrl, cookie, meetingId) {
  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}`, { headers: { Cookie: cookie } });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForCompleted(baseUrl, cookie, meetingId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getMeeting(baseUrl, cookie, meetingId);
    if (body.meeting.status === "completed") return body.meeting;
    if (body.meeting.status === "failed") {
      throw new Error(`meeting failed while waiting to complete: ${body.meeting.statusMessage}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`meeting did not complete in time; last status ${body.meeting.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Drives a meeting through the same worker path a real bot uses (raw-transcript ->
// normalize -> notes) so the fixture has real normalizedSegments with known ids, instead
// of a hand-built store record that could drift from what the pipeline actually produces.
async function completeMeeting(baseUrl, cookie, title) {
  const meeting = await createMeeting(baseUrl, cookie, title);
  const rawSegments = [
    { id: "turn-1", speaker: "Speaker 1", start: 0, end: 2, text: "Let's kick off the meeting." },
    { id: "turn-2", speaker: "Speaker 2", start: 2, end: 5, text: "Sure, first the landing page update." },
    { id: "turn-3", speaker: "Speaker 1", start: 5, end: 8, text: "Sounds good, I will send it tomorrow." }
  ];
  const response = await fetch(`${baseUrl}/api/runner/meetings/${meeting.id}/raw-transcript`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rawSegments })
  });
  assert.equal(response.status, 202, `raw-transcript submission failed: ${await response.text()}`);
  return waitForCompleted(baseUrl, cookie, meeting.id);
}

function postNotesEmail(baseUrl, cookie, meetingId, payload, { preview = false } = {}) {
  const query = preview ? "?preview=1" : "";
  return fetch(`${baseUrl}/api/meetings/${meetingId}/notes-email${query}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

test("preview renders without sending and records nothing", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await completeMeeting(server.baseUrl, owner);

  const selection = {
    // Same domain as the signed-up owner, so this exercises the render path without
    // also tripping the external-recipient confirmation this file tests separately.
    recipients: ["teammate@example.com"],
    sections: { summary: true, transcript: true },
    transcript: { includeIds: ["turn-1", "turn-2"], edits: {} }
  };

  const preview = await postNotesEmail(server.baseUrl, owner, meeting.id, selection, { preview: true });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.match(body.text, /SUMMARY/);
  assert.match(body.text, /TRANSCRIPT/);
  assert.ok(body.html.includes("<h1"), "preview also returns the html the send would use");

  // Nothing recorded, because nothing was sent.
  const after = await getMeeting(server.baseUrl, owner, meeting.id);
  assert.equal(after.body.meeting.delivery?.notesEmail, undefined);
});

test("preview does not consume the send rate limiter's budget", async (t) => {
  // notesEmailLimiter caps sends at 20 per 15-minute window. If preview shared that
  // budget, the 21st preview in this loop would 429 — it must not, because preview is
  // free by design (rendering is cheap and changes nothing; only the send is bounded).
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await completeMeeting(server.baseUrl, owner);
  const selection = { recipients: ["teammate@example.com"], sections: { summary: true } };

  for (let index = 0; index < 25; index += 1) {
    const response = await postNotesEmail(server.baseUrl, owner, meeting.id, selection, { preview: true });
    assert.equal(response.status, 200, `preview ${index + 1} of 25`);
  }
});

test("a non-owner gets 404, not 403", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const intruder = await signUp(server.baseUrl, "intruder@example.com");
  const meeting = await completeMeeting(server.baseUrl, owner);

  const selection = { recipients: ["teammate@example.com"], sections: { summary: true } };
  const response = await postNotesEmail(server.baseUrl, intruder, meeting.id, selection, { preview: true });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "not_found");
});

test("an unknown segment id is rejected with 400", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await completeMeeting(server.baseUrl, owner);

  const selection = {
    recipients: ["teammate@example.com"],
    sections: { summary: true },
    transcript: { edits: { nope: "injected text" } }
  };
  const response = await postNotesEmail(server.baseUrl, owner, meeting.id, selection);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unknown_segment");
});

test("an external recipient without confirmExternal is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await completeMeeting(server.baseUrl, owner);

  const selection = {
    recipients: ["outsider@somewhere-else.com"],
    sections: { summary: true }
  };
  const response = await postNotesEmail(server.baseUrl, owner, meeting.id, selection);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "external_not_confirmed");
});

test("a meeting that is not completed is refused", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  // Never sent through raw-transcript, so it stays "scheduled".
  const meeting = await createMeeting(server.baseUrl, owner);

  const selection = { recipients: ["teammate@example.com"], sections: { summary: true } };
  const response = await postNotesEmail(server.baseUrl, owner, meeting.id, selection);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "meeting_not_completed");
});

// NOT covered by this file: the actual Gmail send (success, partial failure across
// several recipients, and the pre-send guards for "Gmail not configured" / "no sending
// account connected" / "no usable token"). All of those need a real connected Google
// account's OAuth token on disk, which this harness has no way to provision — signing up
// a test user here never runs the OAuth flow. See task-4-report.md for the full list of
// what that leaves unverified and how it was reasoned through instead.
