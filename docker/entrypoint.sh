#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/open-notetaker-runtime}"
export PULSE_SINK_NAME="${PULSE_SINK_NAME:-open_notetaker}"
export AUDIO_CAPTURE_DRIVER="${AUDIO_CAPTURE_DRIVER:-pulse}"
export AUDIO_CAPTURE_SOURCE="${AUDIO_CAPTURE_SOURCE:-${PULSE_SINK_NAME}.monitor}"
export FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin/ffmpeg}"
export BOT_CHROME_EXECUTABLE_PATH="${BOT_CHROME_EXECUTABLE_PATH:-/usr/bin/chromium}"
export BOT_CHROME_USER_DATA_DIR="${BOT_CHROME_USER_DATA_DIR:-/app/.bot-profile}"
export BOT_CHROME_LAUNCH_MODE="${BOT_CHROME_LAUNCH_MODE:-rawcdp}"
export BOT_CHROME_EXTRA_ARGS="${BOT_CHROME_EXTRA_ARGS:---no-sandbox --disable-dev-shm-usage}"
export BOT_HEADLESS="${BOT_HEADLESS:-false}"

mkdir -p "$XDG_RUNTIME_DIR" "$BOT_CHROME_USER_DATA_DIR" /app/data
chmod 700 "$XDG_RUNTIME_DIR"

# Fleet workers copy the signed-in seed profile (mounted read-only) into
# container-local storage so concurrent Chrome instances never share a live profile.
if [ -n "${BOT_PROFILE_SEED_DIR:-}" ] && [ -d "${BOT_PROFILE_SEED_DIR}" ] \
  && [ ! -f "${BOT_CHROME_USER_DATA_DIR}/Default/Preferences" ]; then
  echo "Seeding Chrome profile from ${BOT_PROFILE_SEED_DIR}"
  cp -a "${BOT_PROFILE_SEED_DIR}/." "${BOT_CHROME_USER_DATA_DIR}/" || true
  rm -f "${BOT_CHROME_USER_DATA_DIR}/SingletonLock" \
        "${BOT_CHROME_USER_DATA_DIR}/SingletonCookie" \
        "${BOT_CHROME_USER_DATA_DIR}/SingletonSocket" 2>/dev/null || true
fi

# A restarted container keeps its /tmp, so clear stale X and PulseAudio state or
# Xvfb refuses to start ("Server is already active") and the container crash-loops.
DISPLAY_NUM="${DISPLAY#:}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
rm -rf "${XDG_RUNTIME_DIR}/pulse" 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-1280x720x24}" -nolisten tcp &
XVFB_PID=$!

cleanup() {
  if pactl info >/dev/null 2>&1; then
    pulseaudio --kill >/dev/null 2>&1 || true
  fi
  kill "$XVFB_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit

for _ in $(seq 1 40); do
  if pactl info >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! pactl info >/dev/null 2>&1; then
  echo "PulseAudio did not start." >&2
  exit 1
fi

if ! pactl list short sinks | awk '{print $2}' | grep -qx "$PULSE_SINK_NAME"; then
  pactl load-module module-null-sink \
    "sink_name=$PULSE_SINK_NAME" \
    "sink_properties=device.description=OpenNotetaker" >/dev/null
fi

pactl set-default-sink "$PULSE_SINK_NAME"
pactl set-default-source "${PULSE_SINK_NAME}.monitor"

exec "$@"
