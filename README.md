# OpenNotetaker

Hinglish-first meeting notes for Google Meet.

The MVP is intentionally split into provider boundaries:

- a **bot capture adapter** that can stay in the meeting even after the user leaves
- a **speech-to-text adapter** for Deepgram `nova-3` with multilingual/code-switching settings
- an **LLM normalization pass** that converts Hinglish into clean English without losing names, dates, and intent
- a **notes pass** that extracts summary, decisions, open questions, and actionable steps

## Run locally

```bash
npm run dev
```

Open `http://127.0.0.1:5173`.

The default mode uses a deterministic demo pipeline so the product flow works without paid API keys.

## Real providers

Copy `.env.example` to `.env` and set:

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
DEEPGRAM_API_KEY=...
```

The server loads `.env` automatically if present.

## Accounts and tenancy

OpenNotetaker is multi-user. Sign up from the web UI (email + password); every meeting, transcript, and integration is scoped to the signed-in account:

- Passwords are hashed with scrypt; sessions are HttpOnly `SameSite=Lax` cookies (only the token hash is stored server-side).
- Meetings belong to their creator. Other accounts get a 404 — existence does not leak across tenants.
- Login and signup are rate limited per IP and per account (in-process counters; move them to Redis before running web replicas).
- `AUTH_ALLOW_SIGNUPS=false` freezes signups; `AUTH_SECURE_COOKIES=true` is required behind TLS (defaults on when the base URL is https).
- Changing a password (settings card) signs out every other session. "Forgot password" emails a single-use 30-minute reset code via the account's own connected Gmail; for accounts without a Google connection, the operator runs `node scripts/reset-password.mjs --email user@example.com` and hands over the code.
- If two users record the same Meet slot (same URL, start within 10 minutes), only one bot joins; the second meeting `follows` the first and receives a copy of the notes (and its own transcript email) when the recording finishes.

Meetings created before accounts existed have no owner and are hidden from every user (the raw data stays in `data/meetings.json`).

## Gmail transcript delivery

Set the shared OAuth client in `.env`:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:5173/api/gmail/oauth/callback
```

Each user then connects their own Google account from the dashboard (`/api/gmail/oauth/start`). Recipients and the auto-email toggle are per-user settings in the UI; recipients default to the account email. Tokens are stored per user in `data/google-tokens/<userId>.json` — mount `data/` on encrypted storage and move tokens to a proper secret store before production.

## Google Calendar autojoin

The same Google OAuth connection can read upcoming Calendar events and create bot jobs for Google Meet links:

```bash
GOOGLE_CALENDAR_SYNC_ENABLED=true
GOOGLE_CALENDAR_AUTOSTART_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_POLL_SECONDS=60
GOOGLE_CALENDAR_LOOKAHEAD_MINUTES=120
GOOGLE_CALENDAR_AUTOSTART_LEAD_MINUTES=2
GOOGLE_CALENDAR_AUTOSTART_LATE_MINUTES=30
```

These env values are operator-level switches and cadence; each user opts in individually via **My settings** (calendar import + autostart toggles) after connecting Google. The token includes both scopes:

```text
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar.readonly
```

Calendar sync is read-only. It does not edit events or email attendees. It imports upcoming events with Google Meet links per user, dedupes by Google event id within that user's meetings, and starts scheduled bot jobs inside the configured lead/late window. Connecting Google with calendar scope switches the per-user sync toggle on automatically; autostart stays an explicit opt-in in **My settings**. When several users import the same event, only one bot joins — the other meetings follow that recording and receive the notes when it completes.

## Current vertical slice

1. Create a notetaker job for a Google Meet URL.
2. Record consent/retention settings.
3. Run the demo bot pipeline.
4. Generate raw Hinglish transcript, cleaned English transcript, summary, decisions, and action items.
5. View all artifacts in the browser.

## Speaker names from the meeting

The bot samples the Google Meet UI while recording to put real display names on the final transcript:

- it opens the **People panel** after joining and tracks the participant roster
- it turns on **captions** (local-only) and reads the speaker name Meet renders next to each caption line
- every second it records who is speaking; the runner correlates that timeline with Deepgram segment timestamps and attaches `speakerHints` to each segment

The roster and hints flow into the normalization, role-reconstruction, and notes prompts, so role labels and action-item owners use roster names instead of `Speaker 2` or invented labels. All of this is best-effort DOM scraping: Google rotates its obfuscated class names, so if active-speaker detection goes quiet, refresh the selectors in `signalsHelperSnippet()` in `src/bot-runner/meet-browser.js` from a live meeting. The roster fallback (tiles + panel) is more stable than the caption selectors.

## Capture strategy

The extension approach was rejected because recording must continue after the requester leaves. The product is designed for a participant bot instead:

```text
Meet link -> job queue -> worker claims job -> Chrome/PulseAudio capture -> Deepgram -> LLM normalization -> notes/actions
```

The first local slice uses `BOT_PROVIDER=demo`. A production bot runner should run in Linux with Chrome, a virtual display, PulseAudio/PipeWire monitor capture, and `ffmpeg` streaming audio into the Deepgram adapter. Keep that runner isolated from the web app because browser automation and audio devices fail differently from summarization.

See [docs/bot-runner.md](docs/bot-runner.md) for the external runner setup.

## Concurrent meetings (fleet mode)

`BOT_PROVIDER=fleet` supports any number of overlapping meetings. The web app only queues jobs; recording workers claim them over the API:

```bash
# each worker records one meeting at a time; run N workers for N concurrent recordings
npm run bot:worker
```

- Workers claim jobs at `POST /api/runner/jobs/claim` and hold a lease (`RUNNER_LEASE_SECONDS`, default 120) that renews on every API call they make.
- If a worker dies mid-recording, the lease expires and the server salvages the segments it already flushed into finished notes; a claim that never started recording is re-queued for another worker.
- Each worker needs its own Chrome profile and audio sink — one worker per container. The compose file ships an `open-notetaker-worker` service that copies a signed-in seed profile at boot; scale it with `docker compose up -d --scale open-notetaker-worker=3`.
- One bot Google account can join multiple meetings at once, but at higher concurrency prefer a pool of bot accounts (one seed profile per account) to avoid abuse flags.

`BOT_PROVIDER=external` remains for single-host local development: the web app spawns one runner child process per meeting and serializes overlapping recordings behind a queue.

## Security notes

Meeting audio and transcripts are sensitive. Before public deployment, add:

- real authentication and workspace-level authorization
- visible bot display name such as `OpenNotetaker - Recording`
- explicit consent and meeting chat disclosure
- encryption for stored transcripts
- retention deletion jobs
- audit logs for creation, export, and deletion
- processor agreements for STT/LLM vendors

The local MVP records consent intent and retention settings, but it is not production auth or compliance.
