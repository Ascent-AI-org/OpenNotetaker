// Tests for connecting several Google accounts to one OpenNotetaker user, and for the
// two mailings that fall out of it.
//
// The recipient tests carry the most weight: getting them wrong means email reaching
// someone it should not have, which is the one mistake here you cannot take back.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GOOGLE_ACCOUNTS,
  calendarSyncAccounts,
  listGoogleAccounts,
  matchGoogleAccount,
  noteRecipientEmails,
  pickSendingAccount,
  publicGoogleAccount,
  removeGoogleAccount,
  setDefaultGoogleAccount,
  updateGoogleAccount,
  upsertGoogleAccount
} from "../src/domain/google-accounts.js";
import {
  actionItemRecipients,
  attendeeSuggestions,
  parseRecipientList,
  transcriptRecipients
} from "../src/domain/note-delivery.js";
import {
  actionItemsChanged,
  dueActionItemEmails,
  parseActionItems,
  scheduleActionItemsEmail
} from "../src/domain/action-items.js";
import { formatActionItemsEmail, formatActionItemsEmailHtml, subjectFor } from "../src/domain/action-items-email.js";
import { GMAIL_SEND_SCOPE, CALENDAR_READONLY_SCOPE } from "../src/providers/gmail.js";

const ALL_SCOPES = [GMAIL_SEND_SCOPE, CALENDAR_READONLY_SCOPE];

function connect(accounts, email, overrides = {}) {
  return upsertGoogleAccount(accounts, {
    id: `id-${email}`,
    email,
    name: email.split("@")[0],
    googleSub: `sub-${email}`,
    scopes: ALL_SCOPES,
    ...overrides
  });
}

/* ---------- Connecting accounts ---------- */

test("a user can hold several Google accounts at once", () => {
  let accounts = connect([], "sanya@austriaai.com");
  accounts = connect(accounts, "dhruv@austriaai.com");

  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.email), ["sanya@austriaai.com", "dhruv@austriaai.com"]);
  assert.equal(accounts[0].isDefault, true, "the first connection sends by default");
  assert.equal(accounts[1].isDefault, false);
});

test("reconnecting an account updates it instead of adding a duplicate", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const again = upsertGoogleAccount(accounts, {
    id: "a-different-id",
    email: "sanya@austriaai.com",
    googleSub: "sub-sanya@austriaai.com",
    scopes: ALL_SCOPES
  });

  assert.equal(again.length, 1, "no duplicate connection");
  assert.equal(again[0].id, "id-sanya@austriaai.com", "the original id and token file are kept");
});

test("an account renamed at Google is matched by its stable id, not its address", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const renamed = upsertGoogleAccount(accounts, {
    id: "new",
    email: "sanya.jolly@austriaai.com",
    googleSub: "sub-sanya@austriaai.com",
    scopes: ALL_SCOPES
  });

  assert.equal(renamed.length, 1, "still one connection");
  assert.equal(renamed[0].email, "sanya.jolly@austriaai.com", "the new address is picked up");
  assert.equal(renamed[0].id, "id-sanya@austriaai.com");
});

test("reconnecting does not silently re-enable settings the user turned off", () => {
  let accounts = connect([], "personal@gmail.com");
  accounts = updateGoogleAccount(accounts, "id-personal@gmail.com", {
    calendarSyncEnabled: false,
    receivesNotes: false
  });

  const reconnected = connect(accounts, "personal@gmail.com");
  assert.equal(reconnected[0].calendarSyncEnabled, false, "calendar stays off");
  assert.equal(reconnected[0].receivesNotes, false, "the inbox stays opted out");
});

test("the connection limit is enforced", () => {
  let accounts = [];
  for (let index = 0; index < MAX_GOOGLE_ACCOUNTS; index += 1) {
    accounts = connect(accounts, `user${index}@example.com`);
  }
  assert.equal(accounts.length, MAX_GOOGLE_ACCOUNTS);
  assert.throws(() => connect(accounts, "one-too-many@example.com"), /at most/u);
});

test("removing the default connection promotes another one", () => {
  let accounts = connect([], "sanya@austriaai.com");
  accounts = connect(accounts, "dhruv@austriaai.com");

  const remaining = removeGoogleAccount(accounts, "id-sanya@austriaai.com");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].isDefault, true, "mail always has somewhere to send from");
});

test("removing the last connection leaves nothing behind", () => {
  const accounts = connect([], "solo@example.com");
  assert.deepEqual(removeGoogleAccount(accounts, "id-solo@example.com"), []);
});

test("only the per-account switches are patchable from the client", () => {
  let accounts = connect([], "sanya@austriaai.com");
  accounts = updateGoogleAccount(accounts, "id-sanya@austriaai.com", {
    calendarAutoStart: true,
    // A client must not be able to rewrite the identity or widen its own scopes.
    email: "attacker@evil.test",
    scopes: ["https://www.googleapis.com/auth/drive"],
    googleSub: "spoofed"
  });

  assert.equal(accounts[0].calendarAutoStart, true, "the real switch applies");
  assert.equal(accounts[0].email, "sanya@austriaai.com", "identity is derived from the OAuth grant");
  assert.deepEqual(accounts[0].scopes, ALL_SCOPES, "scopes cannot be widened by the client");
  assert.equal(accounts[0].googleSub, "sub-sanya@austriaai.com");
});

test("a connected account record never carries a token", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const serialized = JSON.stringify(publicGoogleAccount(accounts[0]));
  for (const field of ["token", "access_token", "refresh_token", "googleSub"]) {
    assert.ok(!serialized.includes(field), `${field} is not sent to the browser`);
  }
});

/* ---------- Choosing which account acts ---------- */

test("mail sends from the account tied to the meeting, then the default", () => {
  let accounts = connect([], "sanya@austriaai.com");
  accounts = connect(accounts, "dhruv@austriaai.com");

  assert.equal(pickSendingAccount(accounts).email, "sanya@austriaai.com", "the default when nothing is preferred");
  assert.equal(
    pickSendingAccount(accounts, { preferAccountIds: ["id-dhruv@austriaai.com"] }).email,
    "dhruv@austriaai.com",
    "the calendar that imported the meeting wins"
  );
  assert.equal(
    pickSendingAccount(accounts, { preferAccountIds: ["gone"] }).email,
    "sanya@austriaai.com",
    "an unknown preference falls back rather than failing"
  );
});

test("accounts that cannot send mail are skipped, not attempted", () => {
  let accounts = connect([], "calendar-only@example.com", { scopes: [CALENDAR_READONLY_SCOPE] });
  assert.equal(pickSendingAccount(accounts), null, "nothing can send");

  accounts = connect(accounts, "sender@example.com");
  assert.equal(pickSendingAccount(accounts).email, "sender@example.com");
});

test("only accounts with calendar access and sync on are polled", () => {
  let accounts = connect([], "work@austriaai.com");
  accounts = connect(accounts, "personal@gmail.com");
  accounts = connect(accounts, "mail-only@example.com", { scopes: [GMAIL_SEND_SCOPE] });
  accounts = updateGoogleAccount(accounts, "id-personal@gmail.com", { calendarSyncEnabled: false });

  assert.deepEqual(
    calendarSyncAccounts(accounts).map((account) => account.email),
    ["work@austriaai.com"]
  );
});

test("setting a new default moves it off the old one", () => {
  let accounts = connect([], "first@example.com");
  accounts = connect(accounts, "second@example.com");
  accounts = setDefaultGoogleAccount(accounts, "id-second@example.com");

  assert.deepEqual(
    accounts.filter((account) => account.isDefault).map((account) => account.email),
    ["second@example.com"],
    "exactly one default at a time"
  );
});

test("a malformed stored account list does not crash the reader", () => {
  assert.deepEqual(listGoogleAccounts(null), []);
  assert.deepEqual(listGoogleAccounts({ googleAccounts: "nope" }), []);
  assert.deepEqual(listGoogleAccounts({ googleAccounts: [null, { noId: true }] }), []);
  assert.equal(matchGoogleAccount([], { email: "x@y.com" }), null);
});

/* ---------- Who gets the transcript ---------- */

test("the transcript reaches every connected account", () => {
  // The headline case: connect sanya@ and dhruv@, and both get the notes.
  let accounts = connect([], "sanya@austriaai.com");
  accounts = connect(accounts, "dhruv@austriaai.com");
  const owner = { email: "sanya@austriaai.com", settings: {} };

  assert.deepEqual(transcriptRecipients({ owner, accounts }), [
    "sanya@austriaai.com",
    "dhruv@austriaai.com"
  ]);
});

test("an account can opt its own inbox out of notes while still syncing its calendar", () => {
  let accounts = connect([], "sanya@austriaai.com");
  accounts = connect(accounts, "noisy@gmail.com");
  accounts = updateGoogleAccount(accounts, "id-noisy@gmail.com", { receivesNotes: false });
  const owner = { email: "sanya@austriaai.com", settings: {} };

  assert.deepEqual(transcriptRecipients({ owner, accounts }), ["sanya@austriaai.com"]);
  assert.deepEqual(noteRecipientEmails(accounts), ["sanya@austriaai.com"]);
  assert.equal(calendarSyncAccounts(accounts).length, 2, "its calendar still syncs");
});

test("explicit recipients and connected accounts are merged without duplicates", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const owner = {
    email: "sanya@austriaai.com",
    settings: { transcriptRecipients: ["ops@austriaai.com", "SANYA@austriaai.com"] }
  };

  assert.deepEqual(transcriptRecipients({ owner, accounts }), ["ops@austriaai.com", "sanya@austriaai.com"]);
});

test("a user with nothing configured still gets their own notes", () => {
  assert.deepEqual(
    transcriptRecipients({ owner: { email: "solo@example.com", settings: {} }, accounts: [] }),
    ["solo@example.com"]
  );
});

/* ---------- Who gets the action items ---------- */

test("calendar attendees are never mailed action items on their own", () => {
  // The rule that matters: a client on the invite must not receive internal notes
  // because nobody thought about it.
  const accounts = connect([], "sanya@austriaai.com");
  const owner = { email: "sanya@austriaai.com", settings: {} };
  const meeting = {
    source: {
      googleCalendar: {
        attendees: [
          { email: "sanya@austriaai.com" },
          { email: "bigclient@external.test" },
          { email: "candidate@gmail.com" }
        ]
      }
    }
  };

  const recipients = actionItemRecipients({ owner, accounts, meeting });
  assert.deepEqual(recipients, ["sanya@austriaai.com"], "only the connected account, no attendees");
  assert.ok(!recipients.includes("bigclient@external.test"));
  assert.ok(!recipients.includes("candidate@gmail.com"));
});

test("attendees are offered as suggestions, with outsiders marked", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const owner = { email: "sanya@austriaai.com", settings: {} };
  const meeting = {
    source: {
      googleCalendar: {
        attendees: [
          { email: "sanya@austriaai.com" },
          { email: "dhruv@austriaai.com", displayName: "Dhruv" },
          { email: "bigclient@external.test", name: "Client" }
        ]
      }
    }
  };

  const suggestions = attendeeSuggestions({
    meeting,
    owner,
    accounts,
    currentRecipients: ["sanya@austriaai.com"]
  });

  assert.deepEqual(suggestions.map((person) => person.email), [
    "dhruv@austriaai.com",
    "bigclient@external.test"
  ]);
  assert.equal(suggestions[0].external, false, "same domain is internal");
  assert.equal(suggestions[1].external, true, "a different domain is flagged");
});

test("a per-meeting recipient list overrides the defaults, including an empty one", () => {
  const accounts = connect([], "sanya@austriaai.com");
  const owner = { email: "sanya@austriaai.com", settings: { actionItemRecipients: ["team@austriaai.com"] } };

  assert.deepEqual(
    actionItemRecipients({ owner, accounts, meeting: { delivery: { actionItemsEmail: { recipients: ["one@x.com"] } } } }),
    ["one@x.com"]
  );
  // "Send this one to nobody" must mean nobody, not "fall back to the defaults".
  assert.deepEqual(
    actionItemRecipients({ owner, accounts, meeting: { delivery: { actionItemsEmail: { recipients: [] } } } }),
    []
  );
});

test("recipient lists reject anything that is not an email", () => {
  assert.equal(parseRecipientList(["a@b.com", "not-an-email"]).ok, false);
  assert.equal(parseRecipientList("a@b.com").ok, false, "must be an array");
  assert.equal(parseRecipientList(Array.from({ length: 40 }, (_, i) => `u${i}@x.com`)).ok, false, "capped");
  assert.deepEqual(parseRecipientList(["A@b.com", "a@B.com"]).value, ["a@b.com"], "normalized and deduped");
  assert.equal(parseRecipientList([], { allowEmpty: false }).ok, false);
});

/* ---------- Editing action items ---------- */

test("edited action items are cleaned up and capped", () => {
  const parsed = parseActionItems([
    { task: "  Share the   logs  ", owner: "Dhruv", due: "Tomorrow evening", evidenceTimestamp: "00:27" },
    { task: "", owner: "Nobody" },
    { task: "x".repeat(900) }
  ]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.length, 2, "the empty row is dropped");
  assert.equal(parsed.value[0].task, "Share the logs", "whitespace collapsed");
  assert.equal(parsed.value[1].task.length, 500, "long tasks are truncated");
});

test("a malformed action item list is rejected rather than half-saved", () => {
  assert.equal(parseActionItems("nope").ok, false);
  assert.equal(parseActionItems([{ task: "ok" }, "not an object"]).ok, false);
  assert.equal(parseActionItems(Array.from({ length: 300 }, () => ({ task: "x" }))).ok, false);
});

test("saving an unchanged list is recognised as a no-op", () => {
  const items = [{ task: "Ship it", owner: "Sanya", due: "Friday" }];
  assert.equal(actionItemsChanged(items, [{ task: "Ship it", owner: "Sanya", due: "Friday" }]), false);
  assert.equal(actionItemsChanged(items, [{ task: "Ship it", owner: "Dhruv", due: "Friday" }]), true);
  assert.equal(actionItemsChanged(items, []), true);
});

/* ---------- When the action-item email goes ---------- */

test("the automatic send is held so wrong items can be fixed first", () => {
  const meeting = { artifacts: { notes: { actionItems: [{ task: "Ship it" }] } } };
  const now = Date.parse("2026-08-24T10:00:00.000Z");

  const scheduled = scheduleActionItemsEmail({ meeting, autoSend: true, holdMinutes: 10, now });
  assert.equal(scheduled, "2026-08-24T10:10:00.000Z");

  // A hold of 0 is allowed, for anyone who would rather have it immediately.
  assert.equal(
    scheduleActionItemsEmail({ meeting, autoSend: true, holdMinutes: 0, now }),
    "2026-08-24T10:00:00.000Z"
  );
});

test("nothing is scheduled without opt-in, items, or when already handled", () => {
  const withItems = { artifacts: { notes: { actionItems: [{ task: "Ship it" }] } } };
  const options = { holdMinutes: 10, now: Date.now() };

  assert.equal(scheduleActionItemsEmail({ meeting: withItems, autoSend: false, ...options }), null, "opt-in required");
  assert.equal(
    scheduleActionItemsEmail({ meeting: { artifacts: { notes: { actionItems: [] } } }, autoSend: true, ...options }),
    null,
    "no items, no mail"
  );
  assert.equal(
    scheduleActionItemsEmail({
      meeting: { ...withItems, delivery: { actionItemsEmail: { status: "sent" } } },
      autoSend: true,
      ...options
    }),
    null,
    "never sent twice"
  );
  assert.equal(
    scheduleActionItemsEmail({
      meeting: { ...withItems, delivery: { actionItemsEmail: { autoSend: false } } },
      autoSend: true,
      ...options
    }),
    null,
    "a meeting held back by the owner stays held back"
  );
});

test("only meetings whose hold has elapsed come due", () => {
  const now = Date.parse("2026-08-24T10:00:00.000Z");
  const meetings = [
    { id: "due", delivery: { actionItemsEmail: { status: "scheduled", scheduledFor: "2026-08-24T09:59:00.000Z" } } },
    { id: "waiting", delivery: { actionItemsEmail: { status: "scheduled", scheduledFor: "2026-08-24T10:05:00.000Z" } } },
    { id: "cancelled", delivery: { actionItemsEmail: { status: "cancelled", scheduledFor: "2026-08-24T09:00:00.000Z" } } },
    { id: "no-delivery" }
  ];

  assert.deepEqual(dueActionItemEmails(meetings, now).map((meeting) => meeting.id), ["due"]);
});

/* ---------- The action-item email itself ---------- */

test("the action-item email leads with the items", () => {
  const meeting = {
    title: "Weekly sync",
    scheduledAt: "2026-08-24T10:00:00.000Z",
    artifacts: {
      notes: {
        summary: "Discussed the Stripe blocker.",
        actionItems: [{ task: "Share the logs", owner: "Dhruv", due: "Tomorrow evening", evidenceTimestamp: "00:27" }]
      }
    }
  };

  assert.equal(subjectFor(meeting, meeting.artifacts.notes.actionItems), "1 action item: Weekly sync");
  const text = formatActionItemsEmail(meeting);
  assert.match(text, /Share the logs/u);
  assert.match(text, /Owner: Dhruv/u);
  assert.match(text, /Due: Tomorrow evening/u);
  assert.ok(text.indexOf("ACTION ITEMS") < text.indexOf("CONTEXT"), "items come before context");
});

test("the action-item email escapes meeting content", () => {
  const html = formatActionItemsEmailHtml({
    title: '<script>alert("x")</script>',
    artifacts: { notes: { actionItems: [{ task: "<img src=x onerror=alert(1)>", owner: "a&b" }] } }
  });

  assert.ok(!html.includes("<script>alert"), "the title cannot inject markup");
  assert.ok(!html.includes("<img src=x"), "nor can a task");
  assert.match(html, /&amp;/u);
});

test("an edited list says so, so recipients know it was reviewed", () => {
  const meeting = { title: "Sync", artifacts: { notes: { actionItems: [{ task: "Ship it" }] } } };
  assert.match(formatActionItemsEmail(meeting, { editedByUser: false }), /Extracted automatically/u);
  assert.match(formatActionItemsEmail(meeting, { editedByUser: true }), /reviewed and edited/u);
});
