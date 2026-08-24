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

Create the config file (the same `.env` drives `npm run dev` and docker compose):

```bash
cp .env.example .env
```

Set at minimum:

```bash
DEEPGRAM_API_KEY=...
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
RUNNER_TOKEN=$(openssl rand -hex 32)
```

Container-specific values (Chromium path, PulseAudio sink, internal worker URL) are
pinned in `docker-compose.yml`; you never set them in `.env`.

Then run:

```bash
docker compose up --build
```

Open:

```text
http://localhost:5173
```

## Behind A TLS Reverse Proxy

`docker-compose.yml` binds the app to `127.0.0.1:5173`, so anything beyond the host
goes through a proxy you put in front of it (Caddy, nginx). Two settings have to
match that topology:

```bash
OPENNOTETAKER_BASE_URL=https://notes.example.com   # also turns secure cookies on
TRUST_PROXY_HOPS=1                                 # one proxy in front of the app
```

`TRUST_PROXY_HOPS` is what login, signup, and export rate limits key their counters
on. Left at `0` behind a proxy, every request appears to originate from the proxy
itself: the whole team shares a single bucket, so one person retrying a password
locks everyone out, and an attacker's attempts are indistinguishable from anyone
else's. Set higher than the real hop count and a client can prepend its own
`X-Forwarded-For` entry to choose which bucket it lands in — which is no limit at
all. Count the proxies you actually control and set exactly that number.

Your proxy must append the client address to `X-Forwarded-For` (Caddy's
`reverse_proxy` and nginx's `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
both do). Verify after cutover by failing a login from a known address and checking
that repeated attempts from a *different* address are not also blocked.

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

Meeting transcripts and audio are personal data. The app now ships user accounts,
per-owner scoping of every meeting and Google connection, an hourly retention sweep
that purges transcripts past their `retentionDays`, a per-meeting consent mode, and a
per-meeting run log.

Still on you before real customer use:

- **Encrypted storage** for the `data/` volume — it holds transcripts and per-user
  Google OAuth refresh tokens in plaintext files.
- **A real database** instead of the JSON store, which is loaded fully into memory and
  rewritten on every mutation. It also means only one web replica can run: the rate
  limiters are in-process, so a second replica would double every limit.
- **Shared rate-limit counters** (Redis) if you ever do run more than one replica.
- **Telling participants they are being recorded.** The bot joins visibly and consent
  mode is recorded per meeting, but neither is consent.
