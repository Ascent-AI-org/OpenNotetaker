# External Bot Runner

The external runner is the path from demo mode to a real unattended Google Meet participant.

For the Docker/VM deployment path, see [docker-vm.md](docker-vm.md). That path uses Linux PulseAudio loopback inside the container and does not require macOS BlackHole or a Mac restart.

It does four things:

1. Opens Google Meet in Chrome.
2. Joins as a visible participant, ideally named `OpenNotetaker - Recording`.
3. Captures system audio through `ffmpeg`.
4. Streams audio to Deepgram, then submits raw transcript segments back to the web app for English cleanup and notes.

## Two runner modes

- `BOT_PROVIDER=external` — the web app spawns `npm run bot:run -- --meeting-id <id>` as a child process, one meeting at a time (overlapping meetings queue). Best for local development on one machine.
- `BOT_PROVIDER=fleet` — the web app only queues jobs. Independent workers run `npm run bot:worker`, claim jobs at `POST /api/runner/jobs/claim`, and record one meeting each. Run N workers (one per container) for N concurrent recordings. Claims carry a lease (`RUNNER_LEASE_SECONDS`) renewed by every authenticated runner call; when a worker dies, the server re-queues an unstarted claim or salvages a partial recording from the segments already flushed.

The runner sends authenticated callbacks to:

```text
POST  /api/runner/jobs/claim                     (fleet only)
PATCH /api/runner/meetings/:id
POST  /api/runner/meetings/:id/events
POST  /api/runner/meetings/:id/segments          (incremental flush, id-deduped)
POST  /api/runner/meetings/:id/raw-transcript
```

`RUNNER_TOKEN` is required in external and fleet modes. Treat it like a secret.

## Required environment

```bash
BOT_PROVIDER=external
OPENNOTETAKER_BASE_URL=http://127.0.0.1:5173
RUNNER_TOKEN=replace-with-a-long-random-token

DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=multi

BOT_DISPLAY_NAME="OpenNotetaker - Recording"
BOT_CHROME_CHANNEL=chrome
BOT_CHROME_USER_DATA_DIR=.bot-profile
BOT_CHROME_LAUNCH_MODE=rawcdp
BOT_HEADLESS=false
BOT_MAX_DURATION_MINUTES=120

FFMPEG_PATH=ffmpeg
AUDIO_CAPTURE_DRIVER=pulse
AUDIO_CAPTURE_SOURCE=default
```

## Chrome profile

Do not automate Google password login in the runner. It is brittle and risky.

Instead:

1. Create a dedicated Google account for the notetaker.
2. Open Chrome once with `BOT_CHROME_USER_DATA_DIR`.
3. Sign in manually.
4. Confirm that the account can join the target Workspace meetings.
5. Run the bot using that profile.

For production, keep one bot account per concurrent meeting slot or build a scheduler that allocates a free profile.

`BOT_CHROME_LAUNCH_MODE` supports:

- `direct`: Playwright `launchPersistentContext`.
- `cdp`: starts normal Chrome with a local DevTools port, then attaches Playwright.
- `rawcdp`: starts normal Chrome with a local DevTools port and drives the page through a minimal CDP client. This matched manual Meet admission in local testing when Playwright/CDP was refused.
- `applescript`: macOS-only fallback that drives a normal Chrome tab through Chrome Apple Events. This matched manual Meet admission in local testing when Playwright/CDP was refused.

For `applescript`, enable this once in Chrome:

```text
View > Developer > Allow JavaScript from Apple Events
```

Use `direct` or `cdp` when Playwright admission works. Use `rawcdp` or `applescript` only for local prototyping.

## Linux audio setup

The current runner expects `ffmpeg` to read a PulseAudio source:

```bash
ffmpeg -f pulse -i "$AUDIO_CAPTURE_SOURCE" -ac 1 -ar 16000 -f s16le pipe:1
```

In cloud Linux, route Chrome audio to a virtual sink and set `AUDIO_CAPTURE_SOURCE` to that sink monitor. Example source names often look like:

```text
auto_null.monitor
open_notetaker.monitor
```

Use this to inspect sources:

```bash
pactl list short sources
```

## macOS audio setup

AVFoundation can open microphones directly, but a microphone is not reliable meeting audio. For a real notetaker, install a loopback device such as BlackHole or Loopback, route Chrome/meeting audio into it, and capture that virtual input.

List the inputs that ffmpeg can see:

```bash
npm run bot:audio-devices
```

Then set the audio source to the loopback index:

```bash
AUDIO_CAPTURE_DRIVER=avfoundation
AUDIO_CAPTURE_SOURCE=:<loopback-index>
```

If the selected device is `MacBook Pro Microphone` or another physical microphone, preflight will warn because Deepgram may receive silence, room echo, or the wrong speaker mix.

## Running manually

With the web server running and a meeting already created:

```bash
npm run bot:preflight
npm run bot:run -- --meeting-id <meeting-id>
```

In normal external mode, the web app spawns this command for you when you click `Start demo bot` or `Run again`.

## Consent and retention

The bot must be visible in the participant list and should only run when the meeting host has authority to record or all participants have consented. Meeting audio and transcripts are personal data. Before external users rely on this, add account auth, workspace scoping, encrypted storage, deletion jobs, processor records, and audit logs.
