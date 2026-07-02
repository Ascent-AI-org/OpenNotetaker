# OpenNotetaker

**Meeting notes for teams that speak Hinglish.**

[![License: MIT](https://img.shields.io/badge/license-MIT-5e6ad2.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![Dependencies: 1](https://img.shields.io/badge/dependencies-1-blue.svg)](package.json)

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

Connecting Google enables per-user transcript email (sent from the user's own
Gmail), calendar import with automatic bot joining, and "Sign in with Google".
Skip it entirely and OpenNotetaker still records and takes notes.

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

Scopes requested: `gmail.send` and `calendar.readonly`. Calendar sync is
read-only — it imports upcoming events that have Google Meet links from each
user's primary calendar and, when the user enables autostart, queues the bot
about 2 minutes before the meeting begins.

## Accounts and team

OpenNotetaker is multi-user; every meeting, transcript, and Google connection is
scoped to the signed-in account.

- Passwords are hashed with scrypt; sessions are HttpOnly `SameSite=Lax` cookies
  (only the token hash is stored server-side). Login and signup are rate limited
  per IP and per account.
- The first account becomes the admin. Admins invite teammates from the **Team**
  panel (single-use links, 7-day expiry) and can set `AUTH_ALLOW_SIGNUPS=false`
  to make the instance invite-only.
- Other accounts get a 404 for meetings they don't own — existence does not leak
  across users.
- If two users track the same meeting, only one bot joins; the second meeting
  *follows* the first and receives its own copy of the notes when the recording
  finishes.

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

## Security notes

Meeting audio and transcripts are sensitive. The defaults are sane — hashed
passwords, HttpOnly sessions, owner-scoped data, secrets kept out of git — but
before exposing an instance to real teams you should also know:

- Rate-limit counters are in-process; move them to Redis before running more
  than one web replica.
- Per-meeting retention days are recorded but automatic deletion is **not
  implemented yet** — transcripts stay until you delete them.
- Google OAuth tokens are stored per user under `data/google-tokens/`; mount
  `data/` on encrypted storage.
- Transcripts pass through Deepgram and your chosen LLM vendor; make sure that
  fits your data-processing requirements.

## Development

```bash
npm test        # unit tests (node --test, no framework)
npm run check   # syntax-check every module
npm run hooks   # enable the pre-commit secret-scanning hook (uses gitleaks if installed)
```

`BOT_PROVIDER=demo` (the default) exercises the whole pipeline deterministically,
so most changes can be developed and tested without any API keys.

## License

[MIT](LICENSE) © Ascent AI
