import { spawn } from "node:child_process";

// The runner drives one shared Chrome profile (the signed-in bot Google account) and
// one PulseAudio sink, so concurrent recordings would either fail to launch or mix
// both meetings' audio. Recordings therefore run single-flight: overlapping jobs wait
// in a FIFO queue and start when the active runner exits.
let activeRunner = null;
const runnerQueue = [];

export async function startExternalBotJob({ meeting, store, config }) {
  if (activeRunner) {
    runnerQueue.push({ meetingId: meeting.id, store, config });
    await store.updateMeeting(meeting.id, {
      status: "queued",
      statusMessage: "Waiting for the recording slot; another meeting is currently being recorded."
    });
    await store.appendEvent(meeting.id, {
      type: "bot.runner_queued",
      message: `Recording queued behind meeting ${activeRunner.meetingId} (position ${runnerQueue.length}).`
    });
    return { queued: true };
  }

  return spawnRunner({ meeting, store, config });
}

function spawnRunner({ meeting, store, config }) {
  const env = {
    ...process.env,
    OPENNOTETAKER_BASE_URL: config.runner.baseUrl,
    RUNNER_TOKEN: config.runner.token,
    MEETING_ID: meeting.id,
    BOT_DISPLAY_NAME: config.runner.displayName,
    BOT_CHROME_CHANNEL: config.runner.chromeChannel,
    BOT_CHROME_EXECUTABLE_PATH: config.runner.chromeExecutablePath,
    BOT_CHROME_USER_DATA_DIR: config.runner.chromeUserDataDir,
    BOT_CHROME_LAUNCH_MODE: config.runner.chromeLaunchMode,
    BOT_CHROME_EXTRA_ARGS: config.runner.chromeExtraArgs.join(" "),
    BOT_HEADLESS: String(config.runner.headless),
    BOT_MAX_DURATION_MINUTES: String(config.runner.maxDurationMinutes),
    BOT_ALONE_TIMEOUT_SECONDS: String(config.runner.aloneTimeoutSeconds),
    FFMPEG_PATH: config.runner.ffmpegPath,
    AUDIO_CAPTURE_DRIVER: config.runner.audioCaptureDriver,
    AUDIO_CAPTURE_SOURCE: config.runner.audioCaptureSource,
    DEEPGRAM_API_KEY: config.stt.deepgram.apiKey,
    DEEPGRAM_MODEL: config.stt.deepgram.model,
    DEEPGRAM_LANGUAGE: config.stt.deepgram.language,
    DEEPGRAM_KEYTERMS: config.stt.deepgram.keyterms.join(","),
    DEEPGRAM_EXTRA_PARAMS: serializeQueryParams(config.stt.deepgram.extraParams)
  };

  const child = spawn(process.execPath, [config.runner.scriptPath, "--meeting-id", meeting.id], {
    cwd: config.rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  activeRunner = { meetingId: meeting.id, child };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    const message = cleanRunnerOutput(chunk);
    if (message) {
      void store.appendEvent(meeting.id, {
        type: "bot.runner_stdout",
        message
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    const message = cleanRunnerOutput(chunk);
    if (message) {
      void store.appendEvent(meeting.id, {
        type: "bot.runner_stderr",
        message
      });
    }
  });

  child.on("exit", async (code, signal) => {
    if (activeRunner?.child === child) activeRunner = null;
    try {
      const latest = store.getMeeting(meeting.id);
      await store.appendEvent(meeting.id, {
        type: "bot.runner_exit",
        message: `External bot runner exited with code ${code ?? "none"} and signal ${signal ?? "none"}.`
      });
      if (code !== 0 && latest && !["completed", "failed"].includes(latest.status)) {
        await store.updateMeeting(meeting.id, {
          status: "failed",
          statusMessage: "External bot runner exited before the notes were completed."
        });
      }
    } finally {
      void drainRunnerQueue();
    }
  });

  return child;
}

async function drainRunnerQueue() {
  while (!activeRunner && runnerQueue.length) {
    const next = runnerQueue.shift();
    const meeting = next.store.getMeeting(next.meetingId);
    if (!meeting) continue;
    // Skip meetings that were failed, completed, or restarted while waiting.
    if (!["queued", "scheduled"].includes(meeting.status)) continue;

    try {
      await next.store.updateMeeting(meeting.id, {
        status: "queued",
        statusMessage: "External bot runner is starting."
      });
      const child = spawnRunner({ meeting, store: next.store, config: next.config });
      await next.store.appendEvent(meeting.id, {
        type: "bot.runner_spawned",
        message: `External bot runner started from the queue with pid ${child.pid}.`
      });
    } catch (error) {
      await next.store
        .updateMeeting(meeting.id, {
          status: "failed",
          statusMessage: `Queued bot runner failed to start: ${error.message}`
        })
        .catch(() => {});
    }
  }
}

function cleanRunnerOutput(chunk) {
  return String(chunk)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ")
    .slice(0, 500);
}

function serializeQueryParams(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else if (value !== undefined && value !== "") {
      search.set(key, value);
    }
  }
  return search.toString();
}
