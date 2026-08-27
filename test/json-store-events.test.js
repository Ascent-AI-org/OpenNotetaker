import test from "node:test";
import assert from "node:assert/strict";
import { capHeartbeats } from "../src/storage/json-store.js";

const heartbeat = (n) => ({ at: `2026-08-27T10:${String(n).padStart(2, "0")}:00Z`, type: "bot.heartbeat", message: `beat ${n}` });
const real = (type, n) => ({ at: `2026-08-27T10:${String(n).padStart(2, "0")}:00Z`, type, message: type });

test("leaves a short run log completely alone", () => {
  const events = [real("meeting.created", 1), heartbeat(2), heartbeat(3)];
  assert.deepEqual(capHeartbeats(events, 20), events);
});

test("drops the OLDEST heartbeats once over the cap, keeping the newest", () => {
  const events = Array.from({ length: 30 }, (_, i) => heartbeat(i));
  const kept = capHeartbeats(events, 5);
  assert.equal(kept.length, 5);
  // The survivors must be the last five, because recent beats are what answer
  // "is this recording still alive".
  assert.deepEqual(kept.map((e) => e.message), ["beat 25", "beat 26", "beat 27", "beat 28", "beat 29"]);
});

test("never drops a non-heartbeat event, however many heartbeats surround it", () => {
  const events = [
    real("meeting.created", 0),
    ...Array.from({ length: 50 }, (_, i) => heartbeat(i)),
    real("bot.recording_finished", 51),
    real("transcript.raw_ready", 52)
  ];
  const kept = capHeartbeats(events, 3);
  const types = kept.filter((e) => e.type !== "bot.heartbeat").map((e) => e.type);
  assert.deepEqual(types, ["meeting.created", "bot.recording_finished", "transcript.raw_ready"]);
  assert.equal(kept.filter((e) => e.type === "bot.heartbeat").length, 3);
});

test("preserves chronological order of what survives", () => {
  const events = [real("meeting.created", 0), heartbeat(1), real("bot.joined", 2), heartbeat(3), heartbeat(4)];
  const kept = capHeartbeats(events, 1);
  assert.deepEqual(kept.map((e) => e.type), ["meeting.created", "bot.joined", "bot.heartbeat"]);
});

test("tolerates junk instead of an event list", () => {
  assert.deepEqual(capHeartbeats(undefined), []);
  assert.deepEqual(capHeartbeats(null), []);
  assert.deepEqual(capHeartbeats([null, undefined], 1), [null, undefined]);
});
