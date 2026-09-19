import test from "node:test";
import assert from "node:assert/strict";
import {
  canReadMeeting,
  isMeetingOwner,
  isSharedWithTeam,
  meetingVisibility,
  parseVisibility,
  visibleMeetingsFor
} from "../src/domain/meeting-visibility.js";

const sanya = { id: "user-sanya", email: "sanya@ostryaai.com" };
const raghav = { id: "user-raghav", email: "raghav@ostryaai.com" };

const privateMeeting = { id: "m1", ownerId: sanya.id, title: "1:1" };
const sharedMeeting = { id: "m2", ownerId: sanya.id, title: "Standup", visibility: "team" };

test("a meeting with no visibility field is private", () => {
  assert.equal(meetingVisibility(privateMeeting), "private");
  assert.equal(isSharedWithTeam(privateMeeting), false);
  assert.equal(canReadMeeting(privateMeeting, raghav), false);
});

test("the owner reads their own meeting either way", () => {
  assert.equal(canReadMeeting(privateMeeting, sanya), true);
  assert.equal(canReadMeeting(sharedMeeting, sanya), true);
  assert.equal(isMeetingOwner(privateMeeting, sanya), true);
  assert.equal(isMeetingOwner(privateMeeting, raghav), false);
});

test("a shared meeting is readable by a teammate", () => {
  assert.equal(canReadMeeting(sharedMeeting, raghav), true);
});

test("a meeting shared then unshared goes back to private", () => {
  assert.equal(canReadMeeting({ ...sharedMeeting, visibility: "private" }, raghav), false);
});

// The stored value decides who reads the meeting, so a value nobody wrote deliberately
// must not be the one that opens it.
test("an unrecognised stored visibility is treated as private", () => {
  for (const visibility of ["public", "TEAM", "everyone", "", null, true, 1, {}]) {
    assert.equal(canReadMeeting({ ...privateMeeting, visibility }, raghav), false, `visibility ${JSON.stringify(visibility)}`);
  }
});

test("a meeting whose owner is gone is readable by nobody, even when it was shared", () => {
  const orphan = { id: "m3", ownerId: null, visibility: "team" };
  assert.equal(canReadMeeting(orphan, sanya), false);
  assert.equal(canReadMeeting(orphan, raghav), false);
});

test("nobody reads anything without a signed-in user", () => {
  assert.equal(canReadMeeting(sharedMeeting, null), false);
  assert.equal(canReadMeeting(sharedMeeting, {}), false);
});

test("the list keeps a teammate's shared meetings alongside your own private ones", () => {
  const raghavPrivate = { id: "m4", ownerId: raghav.id };
  const meetings = [privateMeeting, sharedMeeting, raghavPrivate, { id: "m5", ownerId: null, visibility: "team" }];

  assert.deepEqual(visibleMeetingsFor(meetings, raghav).map((meeting) => meeting.id), ["m2", "m4"]);
  assert.deepEqual(visibleMeetingsFor(meetings, sanya).map((meeting) => meeting.id), ["m1", "m2"]);
  assert.deepEqual(visibleMeetingsFor(null, sanya), []);
});

test("only the two known visibilities are accepted from a client", () => {
  assert.deepEqual(parseVisibility("team"), { ok: true, value: "team" });
  assert.deepEqual(parseVisibility("private"), { ok: true, value: "private" });
  for (const bad of ["public", "Team", "", undefined, null, 1, ["team"]]) {
    assert.equal(parseVisibility(bad).ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});
