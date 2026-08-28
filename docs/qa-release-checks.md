# QA release checks — multi-account Google, editable action items, video recording

Covers two pull requests reviewed together, plus the video branch stacked on top:

| PR | What it is | Size |
|---|---|---|
| [#7](https://github.com/Ascent-AI-org/OpenNotetaker/pull/7) | Multiple Google accounts, notes to every inbox, editable action items | +2559 / −169, 14 files |
| [#6](https://github.com/Ascent-AI-org/OpenNotetaker/pull/6) | Fixes silent transcript loss, premature retention purges, weak login rate limiting | +1114 / −46, 17 files |
| video | Optional meeting video: playback, clips, expiring share links, retention and disk budget | new branch |

**#7 is stacked on #6**, so checking out `feature/multi-google-accounts` gives you both in
one branch. The video work is a separate branch; its checks are **VID** below. Video is
inert unless an operator sets `VIDEO_RECORDING_ENABLED=true` — VID-01 is the check that it
stays inert.

Test IDs are stable — file bugs as "AD-03 fails" and everyone knows what you mean.
Checks marked **[needs Google]** require real OAuth credentials; everything else runs
in demo mode with no API keys.

---

## SET — Getting set up

Demo mode runs the whole pipeline (transcript → normalisation → notes → action items)
with no API keys and no real meeting. Almost everything below is testable this way.

```bash
# PR #7 includes PR #6, so this one branch covers both.
git clone https://github.com/Ascent-AI-org/OpenNotetaker.git
cd OpenNotetaker
git checkout feature/multi-google-accounts
npm install

# Automated suites — read the failure count, not the total.
npm test
npm run check

# Run it. DATA_DIR keeps each test run isolated.
DATA_DIR=/tmp/ont-qa BOT_PROVIDER=demo LLM_PROVIDER=mock \
  ACTION_ITEMS_HOLD_MINUTES=2 npm run dev
```

Open `http://127.0.0.1:5173` and sign up — the first account becomes admin. Press
**New meeting**, paste any valid Meet link (`https://meet.google.com/abc-defg-hij`),
then **Record**. The demo pipeline finishes in about 10 seconds and produces three
action items.

> **Why `ACTION_ITEMS_HOLD_MINUTES=2`** — the automatic action-item email is
> deliberately held before sending, so you can fix wrong items first. Production
> default is 10 minutes. Set it to 2 while testing so you are not waiting around, and
> to `0` to check the send-immediately path.

- [ ] **SET-01 — Test suite passes on a clean checkout**
  - **Do:** `npm test` and `npm run check`.
  - **Expect:** All tests passing, 0 failing; every module parsed cleanly. The counts
    move as branches land — 132 tests over 35 modules before video, more after it — so
    read the failure count, not the total.
- [ ] **SET-02 — Demo meeting completes and produces action items**
  - **Do:** Create a meeting, press Record, wait.
  - **Expect:** Status reaches "Notes ready"; the Action items table shows rows with
    owners and due dates; summary, decisions, open questions and risks are populated.

---

## GA — Connecting several Google accounts

The headline change. One OpenNotetaker login previously held exactly one Google
connection; it can now hold up to ten, each with its own calendar, its own mailbox,
and its own switches. Find these in **Settings → Google accounts**.

| Switch | What it should do |
|---|---|
| Import calendar | Poll this account's calendar for events that have a Meet link |
| Auto-join | Send the bot roughly 2 minutes before those meetings start |
| Receives notes | Deliver finished notes to this account's own inbox |
| Send from this | Make this the mailbox outgoing notes are sent from |

- [ ] **GA-01 — A second Google account can be connected** *[needs Google]*
  - **Do:** Connect one account, then press **Connect another** and complete OAuth
    with a different Google account.
  - **Expect:** Two rows, each showing its real email address. Exactly one carries the
    "sends by default" badge.
- [ ] **GA-02 — Reconnecting updates rather than duplicating** *[needs Google]*
  - **Do:** Press **Reconnect** on a connected row and complete OAuth with that same
    Google account.
  - **Expect:** Still the same number of rows — no duplicate. Any switches you had
    turned off stay off.
- [ ] **GA-03 — Per-account switches persist across a reload**
  - **Do:** Turn off "Import calendar" on one account, close Settings, reload the page,
    reopen Settings.
  - **Expect:** The switch is still off, and only that account's calendar stops syncing.
- [ ] **GA-04 — Changing the default sender moves the badge**
  - **Do:** Press **Send from this** on the non-default account.
  - **Expect:** The badge moves; exactly one account is ever marked default.
- [ ] **GA-05 — Disconnecting deletes the stored credential** 🔴 *security*
  - **Do:** Note the files in `$DATA_DIR/google-tokens/<userId>/`, press **Disconnect**,
    confirm, then look again.
  - **Expect:** A confirmation prompt first. The row disappears *and* that account's
    `.json` token file is gone from disk — not just hidden in the UI. If the default was
    removed, another row takes over as default.
- [ ] **GA-06 — Two calendars containing the same event import it once** *[needs Google]*
  - **Do:** Invite both connected accounts to one calendar event with a Meet link, then
    **Sync now**.
  - **Expect:** One meeting in the list, not two. Both accounts still receive the notes.
- [ ] **GA-07 — One broken connection does not stop the others syncing**
  - **Do:** Corrupt one account's token file (edit the JSON to an invalid refresh
    token), then **Sync now**.
  - **Expect:** The healthy calendar still imports. The status line names *which*
    account needs reconnecting — not a generic "Google access expired".
- [ ] **GA-08 — Connection limit is enforced**
  - **Do:** Attempt to connect an eleventh account.
  - **Expect:** A clear "connect at most 10 Google accounts" message, not a crash or a
    silent no-op.

---

## TD — Transcript delivery

The full record — summary, notes, transcript — goes to inboxes the account owner
controls. Configured in **Settings → Transcript delivery**.

- [ ] **TD-01 — Both connected accounts appear as recipients**
  - **Do:** With two accounts connected and "Send to every connected Google account"
    on, open Settings.
  - **Expect:** The status line reads "2 accounts connected. Notes go to *both
    addresses*."
- [ ] **TD-02 — An account can opt its inbox out but keep syncing its calendar**
  - **Do:** Turn off "Receives notes" on one account only.
  - **Expect:** That address drops out of the recipient line, while its calendar keeps
    importing meetings.
- [ ] **TD-03 — Typed addresses and connected accounts merge without duplicates**
  - **Do:** Add one of the connected addresses into "Also email transcripts to", in a
    different case (e.g. `SANYA@…`). Save.
  - **Expect:** The address appears once, lowercased — not twice.
- [ ] **TD-04 — The transcript email arrives, from the right mailbox** *[needs Google]*
  - **Do:** On a finished meeting press **Email notes**.
  - **Expect:** Both inboxes receive it. The *From* address is the default sender — or,
    for a calendar-imported meeting, the account whose calendar imported it.
- [ ] **TD-05 — Nothing configured still reaches the account owner**
  - **Do:** With no Google account connected and no addresses typed, check the recipient
    line.
  - **Expect:** Falls back to the login email — a user never silently gets no notes.

---

## AE — Editing action items

Action items are AI-extracted, so some are wrong — an invented task, a guessed owner, a
date read out of a throwaway sentence. They are also what gets mailed to other people.
Press **Edit** on the Action items heading of any finished meeting.

- [ ] **AE-01 — Editor opens with the extracted items**
  - **Do:** Press **Edit**.
  - **Expect:** One editable row per item — task, owner, due — plus Cancel, Add item,
    Save.
- [ ] **AE-02 — Wording, owner and due date can all be changed**
  - **Do:** Edit all three fields on one row, press **Save**.
  - **Expect:** The table shows the edited values, and they survive a page reload.
- [ ] **AE-03 — Items can be removed and added**
  - **Do:** **Remove** a nonsense item, **Add item**, type a task, Save.
  - **Expect:** Count updates in the heading and the sidebar card. Added items behave
    like extracted ones.
- [ ] **AE-04 — Typing survives the background refresh** 🟠 *timing*
  - **Do:** Open the editor, type into a task field, and *wait 5 seconds without
    clicking anything*.
  - **Expect:** Your text stays put and the caret does not jump. The list polls every
    1.8 seconds, so this is the regression to watch.
- [ ] **AE-05 — Cancel discards, and empty rows are dropped**
  - **Do:** Make changes then press **Cancel**. Separately, add a row, leave the task
    blank, and Save.
  - **Expect:** Cancel restores the original list. A blank row is dropped silently
    rather than saved or throwing an error.
- [ ] **AE-06 — Edits reach the export**
  - **Do:** After editing, press **Export** and download this meeting as Markdown and as
    JSON.
  - **Expect:** The edited items appear in both. The Participants section shows names —
    never `[object Object]`.
- [ ] **AE-07 — Edits are recorded in the run log**
  - **Do:** Expand the run log at the bottom of the meeting.
  - **Expect:** An entry naming who edited and the before/after count.
- [ ] **AE-08 — Very long input is handled, not rejected**
  - **Do:** Paste 1,000+ characters into a task field and Save.
  - **Expect:** Truncated to a sensible length and saved. No error, no broken layout.

---

## AD — Sending action items

The short "here's what you committed to" email, and the one that can reach people
outside the company. The strip under the action items on any finished meeting is where
this lives.

> **The rule this section exists to protect**
>
> Attendees on a calendar invite are **never** emailed automatically — even though their
> addresses are on the invite and are stored. They appear as clickable chips instead.
> Anyone outside your connected domains is marked ⚠ and takes a confirmation before
> sending. If QA finds *any* path where an attendee receives mail without someone adding
> them, that is a release blocker.

- [ ] **AD-01 — Attendees are never recipients by default** 🔴 *blocker if it fails*
  - **Do:** Import a calendar meeting that has an external attendee, let it finish, and
    read the "Send action items to" field without touching anything.
  - **Expect:** The field contains only your own configured addresses. The external
    attendee is in the suggestion chips below, *not* in the field.
- [ ] **AD-02 — Outside addresses are visually flagged**
  - **Do:** Compare the chip for a colleague on your domain against one for an external
    guest.
  - **Expect:** The external chip is amber with a ⚠, and the legend below explains it. A
    same-domain chip is plain.
- [ ] **AD-03 — Sending to an outside address asks first** 🔴 *blocker if it fails*
  - **Do:** Click the external chip to add them, then press **Send now**.
  - **Expect:** A confirmation naming that address before anything is sent. Cancelling
    sends nothing.
- [ ] **AD-04 — Clicking a chip adds the address and it sticks**
  - **Do:** Click a suggestion chip, then reload the page.
  - **Expect:** The address is in the recipient field, and it survives the reload. The
    chip disappears from suggestions.
- [ ] **AD-05 — The automatic send is held, and the countdown is visible**
  - **Do:** Turn on "Send action items automatically" in Settings, add a recipient, run
    a fresh meeting.
  - **Expect:** The strip reads "Sending to … at *time*", roughly
    `ACTION_ITEMS_HOLD_MINUTES` ahead. Nothing has been sent yet.
- [ ] **AD-06 — Editing during the hold changes what is sent** *[needs Google]*
  - **Do:** While a send is scheduled, edit an item and Save. Wait for the hold to
    elapse.
  - **Expect:** The delivered email contains the *edited* item, and its footer says the
    items were reviewed and edited.
- [ ] **AD-07 — "Don't send" actually cancels**
  - **Do:** Press **Don't send** on a scheduled meeting, then wait past the scheduled
    time.
  - **Expect:** Status changes to cancelled and no email is ever sent — not merely a
    hidden countdown.
- [ ] **AD-08 — A restart mid-hold still delivers**
  - **Do:** With a send scheduled, stop the server and start it again before the time
    elapses.
  - **Expect:** The schedule survives the restart and the email still goes out at its
    time.
- [ ] **AD-09 — An empty recipient list means nobody**
  - **Do:** Clear the recipient field on one meeting while account-level recipients are
    configured. Reload.
  - **Expect:** That meeting sends to nobody. It must *not* quietly fall back to the
    account defaults.
- [ ] **AD-10 — Invalid addresses are rejected with a usable message**
  - **Do:** Type `not-an-email` into the recipient field and let it save.
  - **Expect:** A clear message naming the bad value. Nothing is saved or sent.
- [ ] **AD-11 — The email itself reads correctly** *[needs Google]*
  - **Do:** Send action items and open the email on a phone and on desktop.
  - **Expect:** Subject is "*N* action items: *meeting title*". The items table is
    first, context below it. Readable on a narrow screen.
- [ ] **AD-12 — A meeting with no action items does not send an empty email**
  - **Do:** Edit a meeting down to zero items, then try **Send now**.
  - **Expect:** A message saying there is nothing to send. No email goes out.

---

## NC — Composing and sending meeting notes

The full meeting notes editor—not just action items. Press **Compose & send** on any
finished meeting, pick a template (Full record or Client-safe), edit anything, compose
for specific recipients, preview the exact email, then send. Edits exist only for this
send and never touch the stored meeting record.

> **The rules this section exists to protect**
>
> Edits to the notes, transcript, or sections are per-send only — they never modify
> what is stored. A deselected transcript turn is genuinely absent from the delivered
> email. Raw evidence and transcript are subject to a specific redaction rule: if any
> transcript turn is deselected, raw evidence is disabled (the UI enforces this; the
> API does not). An external recipient must be confirmed before sending — the server
> enforces this, not just the UI. If QA finds any path where the stored record is
> modified, or where a deselected turn appears in the email, or where an unconfirmed
> external send succeeds, that is a release blocker.

- [ ] **NC-01 — Preview output matches the delivered email** 🔴 *blocker if it fails*
  - **Do:** Open Compose & send, choose a template, make edits to sections and turns,
    then press **Preview**. Note the exact output. Then press **Send** to a real
    address and open the inbox.
  - **Expect:** Same sections, same edited turn text, and same section order in the
    inbox as in the preview — the preview and send use the same renderer so content and
    order cannot drift. Do not expect the two to be pixel-for-pixel identical: the
    preview renders inside an iframe under this app's stylesheet, and a real inbox
    applies its own CSS on top, so markup and appearance will legitimately differ.
- [ ] **NC-02 — A deselected transcript turn is absent from the sent email** 🔴 *blocker if it fails*
  - **Do:** In Compose & send, open the transcript, deselect at least one turn, then
    send to yourself and open the inbox.
  - **Expect:** The deselected turn does not appear in the email. Every unchecked turn
    is genuinely absent, not hidden by CSS or truncated by a preview.
- [ ] **NC-03 — Edits to turns arrive but the stored transcript is unchanged** 🔴 *data loss if it fails*
  - **Do:** In Compose & send, edit the text of a transcript turn (change a word or
    two), send, verify the email shows the edit. Then reload the meeting.
  - **Expect:** The email contains your edited text. The meeting's stored transcript is
    exactly unchanged — when you reload, the turn text is back to the original. No
    permanent change has been made.
- [ ] **NC-04 — An external recipient is refused until confirmed** 🔴 *blocker if it fails*
  - **Do:** In Compose & send, type an address on a different domain (e.g. if your
    connected domains are @company.com, type anything@external.org), then press **Send**
    without confirming the warning.
  - **Expect:** There is no confirmation dialog. The send is attempted, the server
    answers 409, and an inline error naming that address appears next to a **Confirm &
    continue** button. Nothing has been sent at this point. Pressing **Confirm &
    continue** resubmits the same send and it goes through.
- [ ] **NC-05 — Section toggles control what is sent**
  - **Do:** Compose & send, toggle off summary, decisions, and risks. Leave on action
    items and transcript only. Send and open the inbox.
  - **Expect:** The email contains only action items and transcript, in that order. No
    summary, decisions, or risks appear.
- [ ] **NC-06 — notes.email_sent appears in the run log with recipients**
  - **Do:** Compose & send a meeting to two recipients, then expand the run log at the
    bottom.
  - **Expect:** A `notes.email_sent` entry records the send with both recipients named
    and the sections sent listed in parentheses.
- [ ] **NC-07 — Raw evidence is disabled when any turn is deselected** 🔴 *redaction trap*
  - **Do:** In Compose & send with raw evidence enabled, deselect one transcript turn.
  - **Expect:** The raw evidence checkbox is disabled and grayed out. Toggling a turn
    back on re-enables it. The UI prevents the redaction trap where a deselected turn's
    text would leak into raw evidence.
- [ ] **NC-08 — Client-safe preset omits internal sections**
  - **Do:** Compose & send, pick the **Client-safe** template.
  - **Expect:** Summary, decisions, and action items are on. Open questions, risks,
    transcript, and raw evidence are off by default. The preset matches the documented
    "summary, decisions, action items only" list.
- [ ] **NC-09 — A non-owner gets 404 on the notes endpoint** 🔴 *access control if it fails*
  - **Do:** As user B, call `POST /api/meetings/<user A meeting id>/notes-email` with a
    valid body.
  - **Expect:** `404` — never `403`, never "forbidden". The meeting's existence does not
    leak.

---

## MG — Upgrade path for existing installs

Anyone already running OpenNotetaker has a single Google connection stored the old way.
It must survive the upgrade without them noticing. This is the highest-risk area for
existing users.

- [ ] **MG-01 — An existing connection survives the upgrade** 🔴 *blocker if it fails*
  - **Do:** Run `main`, connect a Google account, stop the server, switch to the feature
    branch, start it again.
  - **Expect:** The account still appears in Settings and still works. Calendar sync and
    auto-join keep the settings they had. No re-authentication needed.
- [ ] **MG-02 — The old token file is removed, not left behind**
  - **Do:** After upgrading, inspect `$DATA_DIR/google-tokens/`.
  - **Expect:** The old `<userId>.json` is gone; a `<userId>/<accountId>.json` exists in
    its place. A live credential must not be left orphaned on disk.
- [ ] **MG-03 — Restarting repeatedly does not multiply accounts**
  - **Do:** Restart the upgraded server three or four times.
  - **Expect:** Still exactly one connected account each time.
- [ ] **MG-04 — The migrated address confirms itself** *[needs Google]*
  - **Do:** Look at the migrated row, then press **Sync now** or reconnect.
  - **Expect:** It may initially show "address unconfirmed", then resolve to the real
    Google address. It must never show someone else's address.
- [ ] **MG-05 — Existing meetings and notes are untouched**
  - **Do:** Compare the meeting list and one meeting's notes before and after upgrading.
  - **Expect:** Identical. Nothing is lost, renamed, or re-ordered.

---

## SEC — Access and isolation

Everything here is about one account not being able to touch another's data. Create a
second OpenNotetaker user (**Team → invite**, or a second signup) and try to reach the
first user's meeting.

- [ ] **SEC-01 — Another user cannot read, edit, or send someone else's meeting** 🔴
  - **Do:** As user B, call each of these with user A's meeting id:
    ```
    GET    /api/meetings/<id>
    PUT    /api/meetings/<id>/action-items
    PATCH  /api/meetings/<id>/action-items/delivery
    POST   /api/meetings/<id>/send-action-items
    ```
  - **Expect:** `404` on every one — never `403`, which would confirm the meeting
    exists.
- [ ] **SEC-02 — Another user cannot see or change your Google accounts** 🔴
  - **Do:** As user B: `GET /api/google/accounts`, then
    `PATCH /api/google/accounts/<A's accountId>`.
  - **Expect:** An empty list, and `404` on the patch.
- [ ] **SEC-03 — The browser cannot rewrite whose Google account it is** 🔴
  - **Do:** `PATCH /api/google/accounts/<id>` with
    `{"email":"attacker@evil.test","scopes":["…/drive"]}`.
  - **Expect:** Ignored. The address and permissions still come from Google, not the
    request body.
- [ ] **SEC-04 — No access token ever reaches the browser**
  - **Do:** Open DevTools → Network, and search every response for `refresh_token` and
    `access_token`.
  - **Expect:** No matches anywhere.
- [ ] **SEC-05 — Meeting content cannot inject markup**
  - **Do:** Edit an action item's task to `<img src=x onerror=alert(1)>`, save, and view
    the meeting, the export, and the email.
  - **Expect:** It renders as literal text everywhere. No alert, and no console errors.

---

## REG — Bug fixes from PR #6

These fix defects already in production. Worth confirming independently, because each
one failed silently before — nothing in the UI told you it had gone wrong.

- [ ] **REG-01 — Transcript batches are no longer dropped** 🔴 *data loss*
  - **Do:** Covered by an automated test — `npm test`, look for "concurrent segment
    flushes all land".
  - **Expect:** Passes. Previously 40 of 60 transcript lines were discarded while the
    server replied "accepted".
- [ ] **REG-02 — Retention counts from recording, not from creation** 🔴 *data loss*
  - **Do:** Create a meeting, hand-edit its `createdAt` in `meetings.json` to 40 days
    ago, restart, record it, and wait for the hourly sweep.
  - **Expect:** The transcript is kept. Before the fix, a 30-day retention setting could
    delete a recording within the hour.
- [ ] **REG-03 — Password guessing is limited per account**
  - **Do:** Fail a login 8 times for one account, varying the `X-Forwarded-For` header
    each time.
  - **Expect:** The 9th attempt returns `429` regardless of the header. A different
    account is unaffected. *Note:* the real owner is also locked out for 15 minutes —
    that is the intended trade-off, documented in the README.
- [ ] **REG-04 — Successful logins do not consume the budget**
  - **Do:** Log in correctly 12 times in a row, then fail once.
  - **Expect:** The failure returns `401`, not `429`.
- [ ] **REG-05 — Rate limits work behind a reverse proxy**
  - **Do:** Put nginx or Caddy in front, set `TRUST_PROXY_HOPS=1`, and fail logins from
    two different machines.
  - **Expect:** Each machine gets its own budget. With `TRUST_PROXY_HOPS=0` a spoofed
    `X-Forwarded-For` must be ignored entirely.
- [ ] **REG-06 — Bad requests return 4xx, not 500**
  - **Do:** POST `{not json` to `/api/auth/login`; POST a 2 MB body; POST `[1,2,3]`.
  - **Expect:** `400`, `413`, `400`. The server keeps serving afterwards and logs no
    stack traces.
- [ ] **REG-07 — Security headers are present and the page is not framable**
  - **Do:** `curl -I http://127.0.0.1:5173/`. Then try loading the dashboard inside an
    `<iframe>`.
  - **Expect:** `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`,
    `X-Content-Type-Options`. The iframe stays blank.
- [ ] **REG-08 — Export still works under the new policy**
  - **Do:** Export one meeting and several meetings, in both Markdown and JSON, in
    Chrome, Safari and Firefox.
  - **Expect:** Files download in every browser. Several meetings arrive as a `.zip`. No
    console errors mentioning Content Security Policy.
- [ ] **REG-09 — Meet links must be http or https**
  - **Do:** Create a meeting with `ftp://meet.google.com/abc-defg-hij`.
  - **Expect:** Rejected as invalid.

---

## VID — Video recording

Optional, off by default, and additive: the transcript is the product and video must never
be able to cost you one. Everything in this section is written from that rule — a video
that fails, fills the disk, or is purged has to leave the transcript, the notes, and the
action items exactly as they would have been.

Turn it on for testing with a small budget, so eviction is reachable in one session rather
than next month:

```bash
DATA_DIR=/tmp/ont-qa BOT_PROVIDER=demo LLM_PROVIDER=mock \
  VIDEO_RECORDING_ENABLED=true VIDEO_RETENTION_DAYS=1 \
  VIDEO_DISK_BUDGET_GB=1 VIDEO_SHARE_DEFAULT_DAYS=1 npm run dev
```

> **Real recordings need docker.** Demo mode produces meetings and video records, but the
> actual x11grab capture only happens inside the worker container. VID-05, VID-06 and
> VID-12 are worth doing against `docker compose up -d` with a real Meet call; the rest
> can be done in demo mode.

- [ ] **VID-01 — Upgrading does not silently start recording** 🔴 *blocker if it fails*
  - **Do:** Start the branch against an existing `$DATA_DIR` with no `VIDEO_*` variables
    set at all. Record a meeting.
  - **Expect:** No player, no video controls, nothing written under `$DATA_DIR/media/`.
    An existing deployment that upgrades must not start recording faces because someone
    merged a branch.
- [ ] **VID-02 — Once enabled, meetings record unless unticked**
  - **Do:** With `VIDEO_RECORDING_ENABLED=true`, create one meeting leaving the recording
    box alone, and a second with it unticked. Run both.
  - **Expect:** The first finishes with video. The second finishes with transcript, notes
    and action items and *no* video — status `skipped`, not `failed`. The choice survives
    a page reload made before recording starts.
- [ ] **VID-03 — The recording appears and plays**
  - **Do:** Open a finished meeting with video and press play.
  - **Expect:** Picture and audio, and a duration within a few seconds of the meeting's.
    The file exists under `$DATA_DIR/media/`, and the response is `video/mp4` with
    `Accept-Ranges: bytes`.
- [ ] **VID-04 — Seeking works** 🟠 *looks fine until you drag the scrubber*
  - **Do:** Drag to the middle of a recording longer than a few minutes, then near the
    end, then back to the start. Then from the command line, with your session cookie:
    ```
    curl -i -H 'Range: bytes=1000-2000'  <video url>
    curl -i -H 'Range: bytes=-500'       <video url>
    curl -i -H 'Range: bytes=99999999-'  <video url>
    ```
  - **Expect:** Playback jumps at each drag instead of restarting or freezing. The first
    two return `206 Partial Content` with a correct `Content-Range` and exactly 1001 and
    500 bytes. The third returns `416`. A `200` with the whole body is the bug — a short
    demo clip plays fine that way, so this only ever shows up as an un-draggable
    scrubber on a real hour-long meeting.
- [ ] **VID-05 — A killed worker still leaves a playable recording** 🔴 *data loss*
  - **Do:** Start a real recording, let it run a couple of minutes, then
    `docker compose kill open-notetaker-worker`.
  - **Expect:** The meeting still finishes with notes salvaged from the segments already
    flushed, *and* the partial video plays up to roughly where the worker died. A
    zero-byte file, or one the browser refuses to open, is a failure — the chunks that
    arrived were already on the app's disk.
- [ ] **VID-06 — A video failure never touches the transcript** 🔴 *blocker if it fails*
  - **Do:** Break capture on purpose — point `VIDEO_CAPTURE_SOURCE` at a display that
    does not exist (`:77`) — and record a real meeting.
  - **Expect:** The meeting runs its normal length and finishes with transcript, notes and
    action items. Video is marked `failed` with a reason in the run log. The meeting must
    not end early, lose segments, or fail. If the recording is shortened by the video
    process dying, that is the one bug this whole feature is not allowed to have.
- [ ] **VID-07 — Clips cut where you asked**
  - **Do:** Cut a clip from 02:00 to 02:30. Cut another straight from an action item.
    Then try `endMs` before `startMs`, a range past the end of the recording, and one
    longer than `VIDEO_MAX_CLIP_SECONDS`.
  - **Expect:** 30 seconds, starting on the frame you picked rather than the nearest
    keyframe a second earlier. The clip is listed with its label, plays, and seeks. The
    three bad ranges are each rejected with a message naming the problem — not saved, and
    not silently clamped.
- [ ] **VID-08 — A share link is shown once and is never recoverable** 🔴 *security*
  - **Do:** Create a share link on a clip, copy it, close the dialog, reopen it. Then
    grep the store for the token you copied — `grep -c '<token>' $DATA_DIR/meetings.json`
    — and in DevTools search every API response for `tokenHash`.
  - **Expect:** The URL is displayed exactly once; afterwards the UI offers **Regenerate**,
    never "copy again". The raw token appears nowhere in `meetings.json` — only a hash —
    and `tokenHash` appears in no API response at all. Someone who steals the store must
    not walk away with working video links.
- [ ] **VID-09 — A public link behaves like a public link**
  - **Do:** Open the link in a private window with no session, and `curl -I` it.
  - **Expect:** The clip plays for someone with no account, with Range working. Headers
    carry `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
    `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. The link
    reaches that one clip and nothing else — no route from it to the full recording, the
    transcript, or the meeting page. Requesting it in a tight loop from one IP starts
    being rate limited.
- [ ] **VID-10 — Expiry and revoke actually close the door** 🔴 *security*
  - **Do:** Create a link, view it a couple of times, then hand-edit its `expiresAt` in
    `meetings.json` to the past and restart. Separately, create a second link and press
    **Revoke**. Open both.
  - **Expect:** `404` on each — never `403`, and never an "expired" page, both of which
    confirm the clip exists. The view count reflected the real views taken before expiry.
- [ ] **VID-11 — Retention purge removes the bytes and kills live links** 🔴 *security*
  - **Do:** With `VIDEO_RETENTION_DAYS=1`, take a finished meeting that has a clip with a
    live share link, hand-edit the video's `capturedAt` to three days ago, restart, and
    let the hourly sweep run.
  - **Expect:** `du -sh $DATA_DIR/media/` shows the files actually gone, not just hidden;
    video status reads `purged`; the share link that worked a minute ago now `404`s. The
    meeting, its notes and its transcript are untouched.
  - **Then check the other direction:** set a meeting's own `retentionDays` *below*
    `VIDEO_RETENTION_DAYS` and age it. The video must go no later than the transcript.
    Video outliving the transcript it belongs to is a release blocker.
- [ ] **VID-12 — The disk budget evicts oldest first**
  - **Do:** Set `VIDEO_DISK_BUDGET_GB` just above current usage of `$DATA_DIR/media/` and
    record until it is exceeded. Separately, fill the volume so less than
    `VIDEO_MIN_FREE_DISK_GB` is free, then record.
  - **Expect:** The *oldest* recording is evicted first and the newest is kept, usage
    drops back under budget, and an event says what went and why. Under the free-space
    floor a meeting records audio and transcript and skips video with a reason — it must
    never keep writing until the disk is full, because at that point `meetings.json`
    cannot be rewritten either and transcription goes down with it.
- [ ] **VID-13 — Another user cannot reach your video** 🔴 *security*
  - **Do:** As user B, with user A's ids:
    ```
    GET    /api/meetings/<A id>/video
    POST   /api/meetings/<A id>/clips
    GET    /api/meetings/<A id>/clips/<A clip id>
    DELETE /api/meetings/<A id>/clips/<A clip id>
    POST   /api/meetings/<A id>/clips/<A clip id>/share
    ```
    Then try a crafted id: `../../users.json` and its encoded form `%2e%2e%2f`.
  - **Expect:** `404` on every one and not a byte of video — never `403`, same rule as
    SEC-01. The crafted ids are rejected outright; no request may resolve to a path
    outside the media directory.

---

## What has not been verified

Stated plainly so QA knows where to spend its time. Everything below is untested by the
author and needs a human with real credentials.

- **Real Gmail delivery.** No Google credentials were available during development, so
  no email was actually sent. Message construction is unit-tested, but that a message
  *arrives*, renders correctly in Gmail and Outlook, and is not marked spam is entirely
  unverified.
- **The live OAuth round trip.** Connecting a second account, the consent screen, and
  reconnect were exercised against seeded token files, not against Google. **GA-01 and
  GA-02 are the highest-value manual checks in this document.**
- **Real calendar sync.** Attendee extraction, recurring events, and events spanning two
  connected calendars were tested with hand-built data, not a live calendar.
- **Google's 7-day refresh-token expiry in Testing mode.** If the OAuth app is not
  published, connections expire weekly. Worth confirming the per-account "reconnect
  needed" message appears for the right account.
- **Any real recording.** All pipeline testing used demo mode. Nothing here exercises
  Chrome, PulseAudio, Deepgram, or an actual Meet call.
- **Browsers other than Chrome.** UI verification ran in Chrome only — and video is the
  part where that matters most, since Safari is strict about Range responses and will
  refuse to play a file Chrome tolerates. VID-03 and VID-04 in Safari are the highest-value
  browser checks in this document.
- **Real screen capture.** x11grab was exercised against a virtual display, never against
  a live Meet call with several participants and a screen share. File sizes, CPU cost
  alongside audio capture, and whether 15fps at CRF 30 is actually readable when someone
  shares code are all unmeasured.
- **Disk pressure.** Eviction and the free-space floor were tested with hand-set budgets
  on a mostly empty disk, not by genuinely filling a volume.

---

## Conflict with PR #5 — needs a decision before merge

[PR #5](https://github.com/Ascent-AI-org/OpenNotetaker/pull/5) ("Add guest email
option") touches the same files and the same calendar attendee field as PR #7, so they
will conflict in git. More importantly, they disagree about what should happen.

| | PR #5 | PR #7 |
|---|---|---|
| Guests receive | The full transcript | Action items only |
| Default | Checkbox is **on** — guests included unless unticked | Off — attendees are suggestions, never automatic |
| Outside the company | No distinction | Flagged ⚠ and confirmed before sending |

The practical difference: under PR #5, emailing notes for a meeting that had a client on
it sends that client your full internal transcript unless someone remembers to untick a
box. That is the opposite of the "only people I list" decision PR #7 was built to.
Someone needs to pick one before either lands — it is a product call, not a technical
one.
