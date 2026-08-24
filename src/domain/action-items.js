// Action items are LLM output, so some of them are wrong — an invented task, an owner
// the model guessed, a deadline read out of a throwaway sentence. They are also the part
// of a meeting that gets mailed to other people, which makes "wrong" expensive.
//
// So the list is editable, and the automatic mailing waits a little before it goes. This
// module holds the two pure pieces of that: validating an edited list, and deciding when
// a pending send is due.

export const MAX_ACTION_ITEMS = 200;
const MAX_TASK_LENGTH = 500;
const MAX_FIELD_LENGTH = 200;

/**
 * Validate an edited action-item list from the client.
 *
 * The server owns the shape; the client sends intent. Returns `{ok:false, error}` rather
 * than throwing so the route can answer 400 with a usable message.
 */
export function parseActionItems(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: "Action items must be an array." };
  }
  if (value.length > MAX_ACTION_ITEMS) {
    return { ok: false, error: `Keep at most ${MAX_ACTION_ITEMS} action items.` };
  }

  const items = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `Action item ${index + 1} is not an object.` };
    }
    const task = cleanString(item.task, MAX_TASK_LENGTH);
    // An item with no task is not an item. Dropping it silently is friendlier than a
    // validation error when someone adds a row and changes their mind.
    if (!task) continue;

    items.push({
      task,
      owner: cleanString(item.owner, MAX_FIELD_LENGTH),
      due: cleanString(item.due, MAX_FIELD_LENGTH),
      evidenceTimestamp: cleanString(item.evidenceTimestamp, 40),
      // Preserved when present so an edit does not throw away the transcript links the
      // extraction pass produced, but never trusted for length or type.
      evidenceSegmentIds: Array.isArray(item.evidenceSegmentIds)
        ? item.evidenceSegmentIds.filter((id) => typeof id === "string").slice(0, 20)
        : [],
      editedByUser: Boolean(item.editedByUser)
    });
  }

  return { ok: true, value: items };
}

/** True when the edited list differs from what is stored, so no-op saves write nothing. */
export function actionItemsChanged(before = [], after = []) {
  if (before.length !== after.length) return true;
  return before.some((item, index) => {
    const next = after[index];
    return (
      String(item?.task || "") !== String(next?.task || "") ||
      String(item?.owner || "") !== String(next?.owner || "") ||
      String(item?.due || "") !== String(next?.due || "")
    );
  });
}

/**
 * When the automatic action-item email for a meeting should go out.
 *
 * Not immediately: the whole reason the list is editable is that some items are wrong,
 * and mail already delivered cannot be corrected. The hold gives a window to fix or
 * cancel, and defaults to a value the operator sets. A hold of 0 sends right away, for
 * anyone who would rather have speed.
 *
 * Returns null when nothing should be scheduled — no items to send, or the owner turned
 * automatic delivery off for this meeting.
 */
export function scheduleActionItemsEmail({ meeting, autoSend, holdMinutes, now = Date.now() }) {
  if (!autoSend) return null;
  const items = meeting?.artifacts?.notes?.actionItems || [];
  if (!items.length) return null;

  const delivery = meeting?.delivery?.actionItemsEmail;
  // Already sent, already scheduled, or explicitly held back by the owner.
  if (delivery?.status === "sent" || delivery?.status === "scheduled") return null;
  if (delivery?.autoSend === false) return null;

  const hold = Number.isFinite(holdMinutes) && holdMinutes > 0 ? holdMinutes : 0;
  return new Date(now + hold * 60_000).toISOString();
}

/** Meetings whose held action-item email is now due. */
export function dueActionItemEmails(meetings, now = Date.now()) {
  return meetings.filter((meeting) => {
    const delivery = meeting?.delivery?.actionItemsEmail;
    if (delivery?.status !== "scheduled") return false;
    const sendAt = Date.parse(delivery.scheduledFor || "");
    return Number.isFinite(sendAt) && sendAt <= now;
  });
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}
