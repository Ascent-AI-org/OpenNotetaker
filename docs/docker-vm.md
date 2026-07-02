# Docker VM Deployment

This is the production-shaped path. It does not use macOS BlackHole.

The container runs:

- Node web app
- Chromium for the Meet participant
- Xvfb for a virtual display
- PulseAudio with a null sink named `open_notetaker`
- ffmpeg reading `open_notetaker.monitor`

Chrome plays meeting audio into the PulseAudio sink, and ffmpeg captures the sink monitor. Because browser and audio stack live in the same Linux container, no host audio loopback driver is needed.

## Build And Run

Create a docker env file:

```bash
cp .env.docker.example .env.docker
```

Set at minimum:

```bash
DEEPGRAM_API_KEY=...
RUNNER_TOKEN=<long-random-token>
OPENNOTETAKER_BASE_URL=http://127.0.0.1:5173
```

Then run:

```bash
docker compose up --build
```

Open:

```text
http://localhost:5173
```

## Audio Settings

The default Docker audio settings are:

```bash
AUDIO_CAPTURE_DRIVER=pulse
AUDIO_CAPTURE_SOURCE=open_notetaker.monitor
```

Do not use `avfoundation` in the VM. That is only for local macOS testing.

Inside the container, inspect audio sources with:

```bash
docker compose exec open-notetaker pactl list short sources
```

You should see:

```text
open_notetaker.monitor
```

## Bot Identity

For an MVP, the bot can join as a named guest and the host can admit `OpenNotetaker - Recording`.

For restricted Workspace meetings, use a dedicated bot account and persist its Chrome profile with the `open-notetaker-bot-profile` Docker volume. The current MVP does not include a VNC/noVNC profile setup flow; add that before depending on signed-in bot accounts in production.

## Security Notes

`docker compose` env files are acceptable for local VM prototypes, but container env vars can be inspected by users with Docker access. For production, move `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, and `RUNNER_TOKEN` into your VM or orchestrator secret manager.

Meeting transcripts and audio are personal data. Before real customer use, add user auth, workspace scoping, encrypted storage, retention deletion jobs, consent/audit records, and a real database instead of the local JSON store.
