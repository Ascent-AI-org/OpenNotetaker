// Who, besides its owner, may READ a meeting.
//
// Every meeting is private until its owner shares it, and a stored meeting with no
// visibility field at all reads as private — that is what makes this safe to deploy over
// an existing store: nothing becomes readable because the code shipped.
//
// Reading is all this decides. Editing, sending, re-recording, clipping and minting share
// links stay with the owner, and those routes keep asking getOwnedMeeting.

export const MEETING_VISIBILITIES = ["private", "team"];

// Anything that is not exactly "team" is private: an unknown value, a missing field, a
// meeting written before this feature existed, null.
export function meetingVisibility(meeting) {
  return meeting?.visibility === "team" ? "team" : "private";
}

export function isSharedWithTeam(meeting) {
  return meetingVisibility(meeting) === "team";
}

export function isMeetingOwner(meeting, user) {
  return Boolean(meeting?.ownerId) && Boolean(user?.id) && meeting.ownerId === user.id;
}

export function canReadMeeting(meeting, user) {
  if (!meeting || !user?.id) return false;
  if (isMeetingOwner(meeting, user)) return true;
  // A meeting whose owner is gone (removed teammate, pre-auth legacy row) stays invisible
  // to everyone: there is nobody left who could decide to share or unshare it.
  if (!meeting.ownerId) return false;
  return isSharedWithTeam(meeting);
}

export function visibleMeetingsFor(meetings, user) {
  return (Array.isArray(meetings) ? meetings : []).filter((meeting) => canReadMeeting(meeting, user));
}

// Parses the client's requested visibility. Rejects rather than coercing: a typo in the
// field would otherwise quietly mean "private" on a meeting the owner meant to share, or
// worse, be read as sharing by a later reader of the stored value.
export function parseVisibility(value) {
  if (!MEETING_VISIBILITIES.includes(value)) {
    return { ok: false, message: `visibility must be one of ${MEETING_VISIBILITIES.join(", ")}.` };
  }
  return { ok: true, value };
}
