FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    DISPLAY=:99 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    AUDIO_CAPTURE_DRIVER=pulse \
    AUDIO_CAPTURE_SOURCE=open_notetaker.monitor \
    PULSE_SINK_NAME=open_notetaker \
    BOT_CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    BOT_CHROME_USER_DATA_DIR=/app/.bot-profile \
    BOT_CHROME_LAUNCH_MODE=rawcdp \
    BOT_CHROME_EXTRA_ARGS="--no-sandbox --disable-dev-shm-usage" \
    BOT_HEADLESS=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    dumb-init \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    pulseaudio \
    pulseaudio-utils \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/open-notetaker-entrypoint

RUN chmod +x /usr/local/bin/open-notetaker-entrypoint \
  && mkdir -p /app/data /app/.bot-profile /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix \
  && chown -R node:node /app

USER node

EXPOSE 5173

ENTRYPOINT ["dumb-init", "--", "open-notetaker-entrypoint"]
CMD ["npm", "start"]
