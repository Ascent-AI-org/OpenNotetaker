// Integration tests: boot the real server and talk to it over HTTP.
//
// The unit tests cover the pure modules; these cover behaviour that only exists once
// the HTTP layer, the store, and concurrency are all in play — request-body handling,
// response headers, tenant isolation, and two writers racing on one meeting.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const RUNNER_TOKEN = "integration-test-token";

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
  const dataDir = await mkdtemp(join(tmpdir(), "opennotetaker-integration-"));
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

async function createMeeting(baseUrl, cookie, title = "Integration meeting") {
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

test("a client sending junk gets a 4xx, not a 500", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const malformed = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json"
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid_json");

  // A bare array would otherwise read as an object with every field undefined.
  const notAnObject = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[1,2,3]"
  });
  assert.equal(notAnObject.status, 400);

  const oversized = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "x".repeat(2 * 1024 * 1024) })
  });
  assert.equal(oversized.status, 413);

  // Rejecting mid-upload leaves unread bytes on the socket; the connection must be
  // closed rather than reused, or the *next* request on it fails instead.
  assert.equal(oversized.headers.get("connection"), "close");

  const stillHealthy = await fetch(`${server.baseUrl}/api/health`);
  assert.equal(stillHealthy.status, 200, "the server keeps serving after a rejected body");
  assert.equal(server.logs.join("").includes("internal_error"), false);
});

test("every response carries the security headers", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  for (const path of ["/", "/api/health", "/app.js"]) {
    const response = await fetch(`${server.baseUrl}${path}`);
    const csp = response.headers.get("content-security-policy") || "";
    assert.ok(csp.includes("script-src 'self'"), `${path} restricts scripts to same-origin`);
    assert.ok(csp.includes("frame-ancestors 'none'"), `${path} cannot be framed`);
    assert.ok(csp.includes("object-src 'none'"), `${path} blocks plugins`);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
  }
});

test("meetings do not leak across accounts", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const intruder = await signUp(server.baseUrl, "intruder@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);

  const read = await fetch(`${server.baseUrl}/api/meetings/${meeting.id}`, { headers: { Cookie: intruder } });
  assert.equal(read.status, 404, "another account cannot confirm the meeting even exists");

  const exported = await fetch(`${server.baseUrl}/api/meetings/export`, {
    method: "POST",
    headers: { Cookie: intruder, "Content-Type": "application/json" },
    body: JSON.stringify({ meetingIds: [meeting.id], format: "md" })
  });
  assert.equal(exported.status, 404, "ownership is applied before requested ids are honoured");

  const listed = await (await fetch(`${server.baseUrl}/api/meetings`, { headers: { Cookie: intruder } })).json();
  assert.deepEqual(listed.meetings, []);
});

test("runner endpoints reject a missing or wrong token", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);

  for (const headers of [{}, { Authorization: "Bearer wrong-token" }, { Authorization: RUNNER_TOKEN }]) {
    const response = await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, { headers });
    assert.equal(response.status, 401, `rejected for headers ${JSON.stringify(headers)}`);
  }

  const authorized = await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
    headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
  });
  assert.equal(authorized.status, 200);
});

test("concurrent segment flushes all land instead of overwriting each other", async (t) => {
  // Regression: the handler read the meeting once, then awaited the lease renewal and
  // the request body before merging. Two flushes in flight at the same time therefore
  // both merged onto the same stale base, and whichever wrote last silently discarded
  // the other's segments — a whole batch of transcript, gone with a 202 response.
  //
  // Reachable in fleet mode whenever a worker's lease expires while it is still alive:
  // the sweeper salvages server-side while the worker keeps flushing, and a re-claimed
  // meeting can have two workers posting at once.
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);

  const payloadFor = (prefix) =>
    JSON.stringify({
      segments: Array.from({ length: 20 }, (_, index) => ({
        id: `${prefix}-${index}`,
        speaker: "Speaker 1",
        start: index,
        end: index + 1,
        text: `${prefix} line ${index}`
      }))
    });

  // A normal HTTP client serialises these onto one connection, which hides the race.
  // Hold three sockets open with all-but-one byte of each body sent, so all three
  // handlers are parked inside readJsonBody, then release them together.
  const parked = await Promise.all(
    ["a", "b", "c"].map(
      (prefix) =>
        new Promise((resolve, reject) => {
          const body = Buffer.from(payloadFor(prefix), "utf8");
          const socket = net.connect(server.port, "127.0.0.1", () => {
            socket.write(
              `POST /api/runner/meetings/${meeting.id}/segments HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${server.port}\r\n` +
                `Authorization: Bearer ${RUNNER_TOKEN}\r\n` +
                "Content-Type: application/json\r\n" +
                `Content-Length: ${body.length}\r\n` +
                "Connection: close\r\n\r\n"
            );
            socket.write(body.subarray(0, body.length - 1));
            resolve({ socket, tail: body.subarray(body.length - 1) });
          });
          socket.on("error", reject);
        })
    )
  );

  const settled = parked.map(
    ({ socket }) =>
      new Promise((resolve) => {
        let response = "";
        socket.on("data", (chunk) => {
          response += chunk.toString();
        });
        socket.on("end", () => resolve(response));
        socket.on("close", () => resolve(response));
      })
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const { socket, tail } of parked) socket.write(tail);
  const responses = await Promise.all(settled);
  for (const response of responses) {
    assert.match(response, /^HTTP\/1\.1 202/u, `each flush is accepted, got: ${JSON.stringify(response.slice(0, 200))}`);
  }

  const stored = await (
    await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
    })
  ).json();
  const segments = stored.meeting.artifacts.rawSegments;
  const batches = [...new Set(segments.map((segment) => segment.id.split("-")[0]))].sort();

  assert.deepEqual(batches, ["a", "b", "c"], "no batch was dropped");
  assert.equal(segments.length, 60, "every segment survived");
});

test("re-flushing the same segment ids is idempotent", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  const owner = await signUp(server.baseUrl, "owner@example.com");
  const meeting = await createMeeting(server.baseUrl, owner);
  const segments = Array.from({ length: 10 }, (_, index) => ({
    id: `seg-${index}`,
    speaker: "Speaker 1",
    start: index,
    end: index + 1,
    text: `line ${index}`
  }));

  const flush = () =>
    fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}/segments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ segments })
    });

  await flush();
  await flush();

  const stored = await (
    await fetch(`${server.baseUrl}/api/runner/meetings/${meeting.id}`, {
      headers: { Authorization: `Bearer ${RUNNER_TOKEN}` }
    })
  ).json();
  assert.equal(stored.meeting.artifacts.rawSegments.length, 10, "a retried flush does not duplicate");
});

test("failed logins are throttled per account, not per (address, account)", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());

  await signUp(server.baseUrl, "victim@example.com");

  const attempt = (forwardedFor) =>
    fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify({ email: "victim@example.com", password: "wrong" })
    });

  // Eight wrong guesses are allowed, the ninth is refused — and rotating the claimed
  // source address must not hand the attacker a fresh budget.
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await attempt(`203.0.113.${index}`)).status, 401, `attempt ${index + 1}`);
  }
  assert.equal((await attempt("203.0.113.200")).status, 429, "the ninth guess is refused");

  // TRUST_PROXY_HOPS defaults to 0, so the forwarded header must not be trusted at all.
  assert.equal((await attempt("198.51.100.77")).status, 429, "a forged header cannot reset the budget");
});

test("successful logins do not spend the account budget", async (t) => {
  // Only failures are charged, so signing in repeatedly — several devices, a re-login
  // after clearing cookies — never walks the account toward a lockout.
  const server = await startServer();
  t.after(() => server.stop());

  await signUp(server.baseUrl, "regular@example.com");
  const login = () =>
    fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "regular@example.com", password: "correct-horse-battery-staple" })
    });

  for (let index = 0; index < 12; index += 1) {
    assert.equal((await login()).status, 200, `login ${index + 1} of 12 succeeds`);
  }

  // The budget is untouched, so a wrong password still gets the full allowance.
  const wrong = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "regular@example.com", password: "wrong" })
  });
  assert.equal(wrong.status, 401, "not 429 — the successful logins cost nothing");
});

test("a spent account budget locks the account out for the window, owner included", async (t) => {
  // The accepted trade-off, asserted so it is a decision rather than a surprise: the
  // budget is checked before the password is verified, because verifying costs ~100ms of
  // scrypt and doing that for every attempt is its own denial of service. Eight wrong
  // guesses therefore shut that one account for the rest of the 15-minute window.
  const server = await startServer();
  t.after(() => server.stop());

  await signUp(server.baseUrl, "victim@example.com");
  for (let index = 0; index < 8; index += 1) {
    await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@example.com", password: "wrong" })
    });
  }

  const owner = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "victim@example.com", password: "correct-horse-battery-staple" })
  });
  assert.equal(owner.status, 429, "the owner waits out the window too");

  // Only that account is affected; the instance stays usable for everyone else.
  await signUp(server.baseUrl, "bystander@example.com");
  const bystander = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "bystander@example.com", password: "correct-horse-battery-staple" })
  });
  assert.equal(bystander.status, 200, "other accounts are unaffected");
});
