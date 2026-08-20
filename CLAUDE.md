# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenNotetaker: a self-hosted Google Meet notetaker built for Hinglish (code-switched
Hindi-English) meetings. A visible bot joins a Meet call, captures audio, transcribes
via Deepgram, normalizes Hinglish to clean English via an LLM, and extracts notes,
decisions, and verified action items. Multi-user with owner-scoped data. No database:
storage is JSON files under `data/` with atomic writes. The only npm dependency is
`playwright-core`.

## Commands

```bash
npm run dev            # start the web app (BOT_PROVIDER=demo works with no API keys)
npm test                # unit tests: node --test (no framework), test/*.test.js
npm run check           # node --check syntax validation across every module (no bundler/TS)
npm run hooks           # git config core.hooksPath .githooks (secret-scanning pre-commit)

npm run bot:run         # external mode: one runner child process for a single meeting
npm run bot:worker      # fleet mode: long-lived worker that claims jobs over the API
npm run bot:preflight   # sanity-check bot/browser/audio config before recording
npm run bot:audio-devices  # list ffmpeg-visible audio devices (macOS loopback setup)
```

Run a single test file: `node --test test/pipeline.test.js`. There is no test runner
config beyond Node's built-in `node --test`; test files must match `test/*.test.js`.

`BOT_PROVIDER=demo` (the default) exercises the whole pipeline deterministically with
a canned Hinglish transcript (`src/domain/demo-transcript.js`), so most feature work
does not need Deepgram/LLM/Google API keys. `LLM_PROVIDER=mock` similarly stubs the
LLM provider for pipeline tests.

## Architecture

**Runtime shape**: a single Node process (`src/server.js`, raw `node:http`, no
framework) serves both the static frontend (`public/`, vanilla JS/HTML/CSS — no
build step, no bundler) and the JSON `/api/*` routes. Routes are matched by hand with
`url.pathname === "..."` checks and regexes, read top-to-bottom in `server.js` — there
is no router abstraction, so grep for the path string to find a handler.

**Recording pipeline** (`src/domain/pipeline.js` orchestrates; `src/providers/`
implements each external service behind a small interface):

```
Meet link -> job queue -> worker claims job -> Chrome + PulseAudio capture (bot-runner/)
          -> Deepgram nova-3 streaming (language=multi)   [providers/deepgram.js]
          -> normalize: Hinglish -> clean English          [providers/{gemini,openai,mock}.js]
          -> role/speaker reconstruction from Meet roster
          -> notes + action-item extraction + verification pass
          -> dashboard + optional Gmail delivery           [providers/gmail.js, domain/transcript-email.js]
```

Long transcripts are chunked for the LLM (`GEMINI_NOTES_CHUNK_SIZE` etc.) and merged
back together so one huge request can't time out; action items go through a separate
verification pass to weed out invented tasks before being stored.

**Bot capture has three provider modes** (`src/config.js` -> `bot.provider`,
`BOT_PROVIDER` env var), each with a different process topology:
- `demo` — in-process simulated capture, no external services (`domain/pipeline.js` `runDemoPipeline`).
- `external` — the web server spawns `npm run bot:run` as a child process per meeting, one at a time (`providers/external-bot.js`).
- `fleet` — independent worker processes (`bot-runner/worker.js`) poll `POST /api/runner/jobs/claim`, record one meeting each, and send authenticated callbacks back (`PATCH /api/runner/meetings/:id`, `.../events`, `.../segments`, `.../raw-transcript`). Claims carry a renewable lease (`RUNNER_LEASE_SECONDS`); `src/domain/runner-jobs.js` handles lease expiry, re-queueing unstarted claims, and salvaging partial recordings from already-flushed segments if a worker dies mid-recording. This is what `docker compose up --scale open-notetaker-worker=N` runs.

`RUNNER_TOKEN` authenticates all `/api/runner/*` calls between web app and workers —
required in `external` and `fleet` modes.

**Meet DOM scraping is the fragile part.** Speaker names and the participant roster
come from best-effort scraping of Google Meet's obfuscated UI (captions, People
panel, tiles) in `signalsHelperSnippet()` inside `src/bot-runner/meet-browser.js`.
Google rotates class names without notice; when active-speaker detection breaks, the
roster fallback (tiles + People panel) is more stable than caption selectors. This is
the most likely thing to silently break after a Meet update.

**Chrome launch modes** (`BOT_CHROME_LAUNCH_MODE`, see `docs/bot-runner.md`): `direct`
(Playwright `launchPersistentContext`), `cdp` (Playwright attaches to a normally
launched Chrome), `rawcdp` (minimal hand-rolled CDP client — used when Playwright/CDP
admission was refused in Meet), `applescript` (macOS-only Apple Events fallback, same
reason). Prefer `direct`/`cdp`; `rawcdp`/`applescript` exist for prototyping where
Meet's bot-detection blocked the standard paths. Never automate Google password login
in the runner — use a pre-authenticated persistent Chrome profile
(`BOT_CHROME_USER_DATA_DIR`) instead.

**Storage**: `src/storage/json-store.js` is a generic JSON-file store with atomic
writes (write-then-rename) and a write queue to serialize concurrent writes; a
corrupt file on load is backed up (`.corrupt-<timestamp>`) and the store restarts
empty rather than crash-looping. `src/storage/users-store.js` is the analogous store
for accounts. All meeting data lives under one JSON store scoped by owner; there is
no per-user database or schema migration system.

**Auth**: cookie sessions (`domain/auth.js`) — scrypt-hashed passwords, HttpOnly
`SameSite=Lax` session cookies, only the token hash stored server-side. The first
account to sign up becomes admin. Per-route access control is enforced inline in
`server.js` handlers (owner-scoped meetings return 404, not 403, for non-owners, so
existence doesn't leak).

**Google integration is optional and per-user**: connecting Google
(`providers/gmail.js`, OAuth flow in `server.js`) enables calendar import (read-only,
pulls Meet-linked events and can autostart the bot ~2 min before start) and
transcript email sent from the user's own Gmail (not a shared service account).
Everything works without it.

**Export** (`src/domain/export.js`, `src/domain/zip.js`): Markdown or JSON export of
one or many meetings, field selection (summary/notes/action items/decisions/etc.),
rate-limited and owner-scoped, capped by `MAX_EXPORT_MEETINGS` and by byte size (see
`ExportTooLargeError`) — read this module as the reference pattern for any other
"pick meetings, pick fields, produce a downloadable bundle" feature.

## Conventions

- No TypeScript, no bundler, no framework on either server or client — plain ESM
  JavaScript (`"type": "module"`) throughout. `npm run check` is the only
  build-time correctness gate (`node --check` per file); it's not a linter.
- Tests are plain `node --test` files under `test/`, testing `src/domain/*` and
  `src/providers/*` logic directly (no HTTP server spun up in tests).
- Secrets never go in code or `.env` committed to git; `.githooks/pre-commit` (opt-in
  via `npm run hooks`) blocks staging `.env*` (except `.env.example`), `data/`, and
  `.bot-profile/`, and pattern-scans staged diffs for common secret formats.
