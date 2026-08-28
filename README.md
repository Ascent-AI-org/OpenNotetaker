# OpenNotetaker

**Meeting notes for teams that speak Hinglish.**

[![License: MIT](https://img.shields.io/badge/license-MIT-5e6ad2.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Dependencies: 1](https://img.shields.io/badge/dependencies-1-blue.svg)](package.json)

<img width="1905" height="963" alt="image" src="https://github.com/user-attachments/assets/390ccb5a-d780-494d-b484-e87378f92dfd" />

OpenNotetaker sends a visible bot into your Google Meet, transcribes code-switched

Hindi–English the way it is actually spoken, and turns it into clean English notes:
summary, decisions, open questions, and action items with owners, deadlines, and
timestamped evidence.

## Why this exists

Most notetakers assume the meeting happens in one language. Real meetings in India
happen in Hinglish — and English-only transcription mangles exactly the sentences
where the decisions live. OpenNotetaker treats code-switching as the primary case,
not an edge case.

**What was said in the meeting:**

> okay, Stripe ko blocker mark karte hain. Dhruv, please kal sham tak logs share
> kar dena so we can debug before Friday demo

**What lands in your notes:**

> Okay, let's mark Stripe as a blocker. Dhruv, please share the logs by tomorrow
> evening so we can debug before the Friday demo.

| Action item | Owner | Due | Evidence |
|---|---|---|---|
| Share logs for debugging | Dhruv | Tomorrow evening | 00:27 |

Getting this right takes more than translation: `kal` means *yesterday* or
*tomorrow* depending on context, owners are named mid-sentence in Hindi, and
deadlines like "sham tak" have to survive into the extracted action item. The
pipeline is built around those traps:

- **Speech-to-text tuned for code-switching** — Deepgram `nova-3` with
  `language=multi`, word-level speaker splitting, and keyterm hints for your
  team's names and product jargon.
- **Real speaker names, not "Speaker 2"** — the bot reads the Meet People panel
  and caption lines while recording, and correlates that timeline with the
  transcript so notes and action-item owners use actual display names.
- **Normalization that keeps intent** — Hinglish → clean English with names,
  dates, and relative-time ambiguity (`kal`, `parso`) resolved from context.
- **Action items you can audit** — every item carries owner, due date, and links
  back to the exact transcript segments it came from, then goes through a
  separate verification pass to weed out invented tasks.

## Quickstart

### Try it in 60 seconds (no API keys)

```bash
git clone https://github.com/Ascent-AI-org/OpenNotetaker.git
cd OpenNotetaker
npm install
npm run dev
```

Open http://127.0.0.1:5173, sign up (the first account becomes the admin), and
create a meeting. The default demo mode simulates a Hinglish meeting capture and
runs the full pipeline — transcript, normalization, notes, action items — with no
external services.

### Real recordings — one config, one command

```bash
cp .env.example .env    # set DEEPGRAM_API_KEY, GEMINI_API_KEY (+ LLM_PROVIDER=gemini), RUNNER_TOKEN
docker compose up -d
```

That starts the web app (bound to `127.0.0.1:5173`) and one recording worker with
Chromium, a virtual display, and PulseAudio loopback inside the container. Paste a
Google Meet link, and the bot asks to join as `OpenNotetaker - Recording`; someone
in the call admits it, and it keeps listening even after you leave.

The same `.env` drives both `npm run dev` and docker compose — container-specific
values are pinned in `docker-compose.yml`, so you never maintain two configs.

Need more simultaneous meetings? Each worker records one meeting at a time:

```bash
docker compose up -d --scale open-notetaker-worker=3
```

For a real team deployment, put a TLS reverse proxy (Caddy, nginx) in front and set
`OPENNOTETAKER_BASE_URL=https://...` — see [docs/docker-vm.md](docs/docker-vm.md).

## How it works

```text
Meet link → job queue → worker claims job → Chrome + PulseAudio capture
         → Deepgram nova-3 (language=multi, streaming)
         → normalize (Hinglish → English)  → role/speaker reconstruction
         → notes + verified action items   → dashboard + optional Gmail delivery
```

The web app only queues jobs; recording workers claim them over the API
(`BOT_PROVIDER=fleet`) and hold a renewable lease. If a worker dies mid-recording,
the server salvages the segments it already received into finished notes and
re-queues claims that never started. A browser-extension approach was rejected
because recording must continue after the requester leaves the call.

Storage is JSON files under `data/` with atomic writes — no database to run. The
only npm dependency is `playwright-core`.

## Google setup (optional)

Connecting Google enables transcript email (sent from your own Gmail), calendar
import with automatic bot joining, and "Sign in with Google". Skip it entirely and
OpenNotetaker still records and takes notes.

You can connect **several Google accounts to one OpenNotetaker login** — a work
address and a personal one, or two addresses on the same team. Every connected
calendar is imported into the same meeting list, each connection has its own
switches, and notes are delivered to all of them. See "Multiple Google accounts"
below.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project
   and enable the **Gmail API** and **Google Calendar API**.
2. Configure the OAuth consent screen (External). While the app is in **Testing**
   mode, add each teammate as a test user — and note that Google expires refresh
   tokens after 7 days in Testing mode, so users reconnect weekly until you
   publish the app.
3. Create an **OAuth client ID** (type: Web application) and add
   `<your base URL>/api/gmail/oauth/callback` as an authorized redirect URI.
4. Put the client ID and secret in `.env` (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).

Scopes requested: `openid`, `email`, `profile`, `gmail.send`, and
`calendar.readonly`. The identity scopes are what let one login hold several
connections — without them a second grant is indistinguishable from the first, so
it could not be labelled or reconnected independently. Calendar sync is read-only:
it imports upcoming events that have Google Meet links, and when autostart is on
for that connection, queues the bot about 2 minutes before the meeting begins.

## Multiple Google accounts

Press **Connect another** in Settings for each account you want to add (up to 10).
Each connection appears as its own row with three switches:

| Switch | What it does |
|---|---|
| **Import calendar** | Poll this account's calendar and create meetings from events with a Meet link. |
| **Auto-join** | Send the bot automatically, ~2 minutes before those meetings start. |
| **Receives notes** | Deliver finished notes to this account's own inbox. |

One row is marked **sends by default** — that is the mailbox outgoing notes are
sent from. A meeting imported from a specific calendar sends from that calendar's
account instead, so replies land in the right inbox.

Meetings from every connected account appear in one list rather than behind an
account switcher: an event on two connected calendars is imported once and
recorded once, and both accounts receive the notes. **Disconnect** deletes the
stored credential, not just the row.

Upgrading from a single-account install needs nothing — the existing connection is
migrated to the new layout on first boot, keeping its calendar settings. Its
address shows as unconfirmed until Google confirms it, which happens on the next
sync or reconnect.

## Action items

Extracted action items are LLM output, so some of them are wrong — an invented
task, a guessed owner, a deadline read out of a throwaway sentence. Since these
are also the part of a meeting you might send to other people, they are editable
and their delivery is deliberate.

**Editing.** Press **Edit** on a finished meeting to fix wording, reassign an
owner, correct a date, delete an item, or add one the extraction missed. Edits
flow into the export, the email, and the dashboard, and are recorded in the run
log.

**Who receives them.** Only addresses you list. Calendar attendees are *never*
mailed automatically, even though they are on the invite and OpenNotetaker stores
them — a meeting with a client, a candidate, or a vendor on it would otherwise
send them your internal notes because nobody decided to. Instead, attendees appear
under the action items as one-click chips, with anyone outside your connected
domains marked ⚠, and sending to an outside address asks for confirmation. Adding
everyone is still one click each; it is just a click someone makes.

**When they go out.** Off by default. Turn on "Send action items automatically" in
Settings and each finished meeting queues an email held for
`ACTION_ITEMS_HOLD_MINUTES` (default 10) — the window to fix or cancel before it
leaves. **Don't send** cancels this meeting's send; **Send now** skips the wait.
Set the hold to `0` to send as soon as notes are ready. The schedule lives on the
meeting rather than in a timer, so a restart mid-hold still delivers.

## Composing and sending notes

Beyond action items, you can compose and send the full meeting notes, the transcript,
or any combination of sections — one email, edited however you want, without touching
the stored record.

**Presets and per-send edits.** Press **Compose & send** on any finished meeting and
choose a starting template: *Full record* includes every section (summary, decisions,
action items, open questions, risks, transcript, and raw Hinglish evidence), while
*Client-safe* sends only the summary, decisions, and action items. Edit anything after:
wording, section toggles, individual turns, recipients. These edits exist only for this
send and never modify the meeting's stored notes, transcript, or action items — the same
typo must be corrected on each send.

**Transcript turns.** If you include the transcript in the email, each turn is
individually selectable: tick or untick to include or exclude, and edit the text
inline. Select-all, select-none, drop-before-here, and drop-after-here buttons help
you trim the transcript quickly.

**Recipients.** Enter any address in the recipient field. Calendar attendees appear as
suggestion chips below, with anyone outside your connected Google domains marked
⚠ and highlighted in amber. Clicking a chip adds them; they persist until you remove
them. Sending to an outside address asks for confirmation — the server enforces this
before the email is sent, so a recipient outside your connected domains is flagged and
requires that confirmation rather than going out silently. That check is only as
precise as "connected domain": if you signed up with a freemail address, your own
domain (e.g. gmail.com) is treated as internal, and so is every other recipient on it.

**Preview.** Before sending, press **Preview** to see the exact email that will be
delivered — same formatting, same sections, same edited turns. The preview uses the
exact renderer the send uses, so what you see is what recipients get. Previewing does
not count toward rate limits and does not modify the stored meeting.

**Recording the send.** Every completed send creates a `delivery.notesEmail` entry
(recipients, sections sent, turns sent, and provider message ids) plus a
`notes.email_sent` run-log event. Failed sends append `notes.email_failed`. The email
body itself is not stored — only the metadata needed to audit what was sent and to whom.

**Raw evidence and transcript selection.** The UI enforces a rule: raw evidence is
disabled whenever any transcript turn is deselected. This prevents an accidental
combination where a turn is redacted from the transcript but its text would still leak
into the raw evidence section. If you script directly against the API endpoint, you
must enforce this rule yourself — the server does not.

## Accounts and team

OpenNotetaker is multi-user; every meeting, transcript, and Google connection is
scoped to the signed-in account.

- Action items are only ever emailed to addresses someone put on the list;
  calendar attendees are suggestions, never automatic recipients. Addresses
  outside your connected domains are flagged in the UI and confirmed before send.
- Disconnecting a Google account deletes its stored refresh token from disk rather
  than only removing it from the account list.
- Passwords are hashed with scrypt; sessions are HttpOnly `SameSite=Lax` cookies
  (only the token hash is stored server-side). Login and signup are rate limited
  per IP and per account. Only *failed* logins count against the per-account
  budget, so signing in often costs nothing — but eight wrong guesses do lock that
  one account for the rest of a 15-minute window, its owner included. That is
  deliberate: the budget is checked before the password is verified, because
  verifying costs ~100ms of scrypt and doing that for every attempt is its own
  denial of service.
- The first account becomes the admin. Admins invite teammates from the **Team**
  panel (single-use links, 7-day expiry) and can set `AUTH_ALLOW_SIGNUPS=false`
  to make the instance invite-only.
- Other accounts get a 404 for meetings they don't own — existence does not leak
  across users.
- If two users track the same meeting, only one bot joins; the second meeting
  *follows* the first and receives its own copy of the notes when the recording
  finishes.

## Exporting

The **Export** button in the top bar downloads meetings as Markdown or JSON — your
notes are yours, and nothing here is a lock-in.

- Pick **this meeting**, **all meetings**, or check off exactly the ones you want.
- Pick what goes in: summary, detailed notes, action items, decisions, open
  questions, risks, participants, the role-corrected and clean English
  transcripts, the raw Hinglish evidence, and the run log. Raw evidence and the
  run log are off by default.
- One meeting downloads as a single file; several download as a `.zip` with one
  file per meeting. Exports are owner-scoped and rate limited, and the JSON never
  includes internal fields like the recording worker's lease.

## Video recording

Off by default. Set `VIDEO_RECORDING_ENABLED=true` and the bot records what its own
Chrome window sees — the Meet grid, whoever is speaking, and any screen share — as
H.264 at 1280x720 and 15fps, with audio from the same PulseAudio monitor the
transcript comes from. Once the operator turns it on, every new meeting records
unless the person creating it unticks the box.

**Video can never break transcription.** Capture is a second `ffmpeg` process, not
part of the audio one, and its exit is not what ends the meeting. If it dies, stalls,
or was never able to start, the meeting is marked `video: failed`, a line lands in
the run log, and the transcript, notes, and action items finish exactly as they
would have. The transcript is the product; video is additive.

The worker container has no writable volume, so recorded bytes travel to the web app
over the runner API in chunks — the same path transcript segments already take — and
are written under `data/media/`. A worker killed mid-meeting leaves a shorter file,
not a broken one.

**Disk is the real cost.** Roughly 1.5–3 MB per minute depending on motion and screen
sharing, so a 48-minute meeting is about 70–150 MB and a week of team meetings is a
few GB. Three limits keep that bounded:

| Setting | Default | What it does |
|---|---|---|
| `VIDEO_RETENTION_DAYS` | 7 | Ceiling on how long a recording is kept |
| `VIDEO_DISK_BUDGET_GB` | 20 | Size of `data/media/`; oldest recordings evicted first |
| `VIDEO_MIN_FREE_DISK_GB` | 5 | Capture refuses to start below this much free space |

Retention is a ceiling, not an extension: the effective window is
`min(VIDEO_RETENTION_DAYS, the meeting's own retentionDays)`, so **video is always
gone by the time the transcript is** — never after it. The free-space floor exists
because a full disk also means `meetings.json` cannot be rewritten, which would take
transcription down with it.

### Clips and sharing

Recordings are internal. Playback needs a signed-in session and only ever serves your
own meetings; someone else's meeting id returns 404, the same as everywhere else in
the app. From a recording you can cut a clip — up to `VIDEO_MAX_CLIP_SECONDS`
(default 5 minutes), including straight from an action item, so the 40 seconds where
someone actually agreed to it stays attached to the task. Clips are internal too.

A single clip can then be opted into a **public link**. That link is unguessable,
expires (`VIDEO_SHARE_DEFAULT_DAYS`, default 7), counts its views, and can be revoked
on the spot. Only the token's SHA-256 hash is stored, so the URL is shown **exactly
once**, when you create it — there is no "copy again", only "regenerate". Someone who
walks off with a copy of `meetings.json` gets no working video links out of it.
Sharing is per clip and never covers the whole recording, and public responses are
sent `Cache-Control: private, no-store` with `X-Robots-Tag: noindex, nofollow`.

Purging a recording — on retention, on disk eviction, or when you delete it — takes
its clips with it and kills their share links in the same move. An expired or revoked
link returns 404, not a page confirming that the clip exists.

## The fragile part (please read before filing a bug)

Speaker names come from best-effort DOM scraping of the Meet UI, and Google
rotates its obfuscated class names. If active-speaker detection goes quiet after
a Meet update, refresh the selectors in `signalsHelperSnippet()` in
[`src/bot-runner/meet-browser.js`](src/bot-runner/meet-browser.js) from a live
meeting — the roster fallback (tiles + People panel) is more stable than the
caption selectors. PRs that fix broken selectors are the most valuable
contribution this project can receive.

## Responsible use

You are recording people. Laws on call recording vary by jurisdiction (one-party
vs all-party consent) — as the operator, consent is your responsibility. The bot
joins visibly with a clear name, and every meeting records a consent mode, but
none of that substitutes for actually telling participants. Automated
participants also sit in a gray area of Google's terms of service; bot accounts
that join many meetings can get flagged, so use a dedicated account.

Video raises the stakes rather than changing them: a transcript is words, a
recording is faces. That is why `VIDEO_RECORDING_ENABLED` is false out of the box —
upgrading an instance must never start recording people who were only ever told
they were being transcribed.

## Security notes

Meeting audio and transcripts are sensitive. The defaults are sane — hashed
passwords, HttpOnly sessions, owner-scoped data, secrets kept out of git — but
before exposing an instance to real teams you should also know:

- Rate-limit counters are in-process; move them to Redis before running more
  than one web replica.
- Per-meeting retention is enforced: an hourly sweep purges the raw and normalized
  transcripts once they are older than the meeting's `retentionDays`, keeping the
  meeting record and its generated notes. The clock starts when the transcript was
  captured, not when the meeting was created.
- Video, when enabled, is purged by the same sweep under the tighter of its own
  ceiling and the meeting's retention, plus a global disk budget with oldest-first
  eviction. Purging deletes the files and revokes any live share links with them.
  Share tokens are stored hashed, so a leak of `meetings.json` yields no playable
  link. See "Video recording".
- **Behind a reverse proxy, set `TRUST_PROXY_HOPS`** to the number of proxies you
  control (`1` for a single Caddy or nginx in front). Leave it at `0` and every
  request appears to come from the proxy, so all users share one rate-limit bucket
  and per-IP limits stop meaning anything. Set it higher than the real hop count and
  clients can forge the address the limiter keys on — so count the hops, don't guess.
- Google OAuth tokens are stored per user under `data/google-tokens/`; mount
  `data/` on encrypted storage.
- Transcripts pass through Deepgram and your chosen LLM vendor; make sure that
  fits your data-processing requirements.
- Anyone with an account on the instance who creates a meeting with the same Meet
  link and start time as an in-flight recording will *follow* that recording and
  receive a copy of its notes and transcript (see "Accounts and team"). That is the
  intended de-duplication behaviour, not a per-meeting access control — an instance
  is a trust boundary, so give accounts only to people allowed to see every meeting
  recorded on it.

## Development

```bash
npm test        # unit tests (node --test, no framework)
npm run check   # syntax-check every module under src/ and scripts/
npm run hooks   # enable the pre-commit secret-scanning hook (uses gitleaks if installed)
```

CI runs `npm run check` and `npm test` on Node 22 and 24, and builds the Docker
image, for every pull request.

`BOT_PROVIDER=demo` (the default) exercises the whole pipeline deterministically,
so most changes can be developed and tested without any API keys.

## License

[MIT](LICENSE) © Ascent AI
