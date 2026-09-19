import test from "node:test";
import assert from "node:assert/strict";
import { MeetBrowserBot, offMeetGuardSnippet } from "../src/bot-runner/meet-browser.js";

// Production 2026-09-19: Meet redirected a guest bot to workspace.google.com mid-admission,
// one Runtime.evaluate reply never arrived, and the single worker sat on that await for
// 11 hours. Every meeting queued behind it — including the next standup — never got a bot.

function botWithSilentChrome(timeoutMs) {
  const bot = new MeetBrowserBot({ meetUrl: "https://meet.google.com/abc-defg-hij", cdpCommandTimeoutMs: timeoutMs });
  // A socket that accepts commands and never answers.
  bot.cdpSocket = { readyState: WebSocket.OPEN, send() {} };
  return bot;
}

test("a DevTools command Chrome never answers rejects instead of hanging the worker", async () => {
  const bot = botWithSilentChrome(1000);
  const started = Date.now();

  await assert.rejects(bot.rawCdpCommand("Runtime.evaluate"), /did not answer Runtime\.evaluate/);

  assert.ok(Date.now() - started < 5000, "must give up near the configured timeout");
  assert.equal(bot.cdpPending.size, 0, "the abandoned command must not leak a pending entry");
});

test("the admission wait ends when Chrome stops answering, well before the admission deadline", async () => {
  const bot = botWithSilentChrome(1000);

  await assert.rejects(
    bot.waitForRawCdpAdmission({ timeoutMs: 10 * 60_000 }),
    /did not answer/
  );
});

function runGuard(hostname) {
  // The snippet is a statement block that returns early; wrap it the way the page scripts do.
  const fn = new Function("location", `${offMeetGuardSnippet()}\nreturn null;`);
  return fn({ hostname });
}

test("a bot redirected off Meet reports left_meet so the wait stops", () => {
  const state = runGuard("workspace.google.com");
  assert.equal(state.status, "left_meet");
  assert.match(state.message, /workspace\.google\.com/);
});

test("a bot still on Meet falls through to the normal page checks", () => {
  assert.equal(runGuard("meet.google.com"), null);
});
