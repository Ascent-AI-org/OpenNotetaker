import { RunnerApiClient } from "./api-client.js";
import { FfmpegAudioSource } from "./audio-source.js";
import { MeetBrowserBot } from "./meet-browser.js";
import { DeepgramStreamingClient } from "../providers/deepgram.js";

const SIGNAL_SAMPLE_INTERVAL_MS = 1000;
const FLUSH_BATCH_SIZE = 10;

// Records a single meeting end-to-end: join Meet, capture audio, stream to Deepgram,
// sample speaker-name signals, and submit the raw transcript for finalization.
// Returns true on success; reports failures to the API and returns false.
export async function recordMeeting({ meetingId }) {
  const api = new RunnerApiClient({
    baseUrl: process.env.OPENNOTETAKER_BASE_URL,
    token: process.env.RUNNER_TOKEN,
    meetingId
  });

  const segments = [];
  let flushedCount = 0;
  let flushChain = Promise.resolve();

  // Participant names and active-speaker samples scraped from the Meet UI. The
  // speaking timeline is correlated with segment timestamps to attach speakerHints.
  const roster = new Map();
  const speakingTimeline = [];

  let audioSource;
  let deepgram;
  let bot;
  let signalsTimer;
  let stoppingAudio = false;

  function startSignalSampling() {
    signalsTimer = setInterval(async () => {
      try {
        const signals = await bot.collectSignals();
        const now = Date.now();
        for (const name of signals.participants || []) {
          const entry = roster.get(name) || { name, firstSeenAt: new Date(now).toISOString() };
          entry.lastSeenAt = new Date(now).toISOString();
          roster.set(name, entry);
        }
        const speakers = signals.activeSpeakers || [];
        if (speakers.length) {
          speakingTimeline.push({ atMs: now, names: speakers });
          if (speakingTimeline.length > 20_000) speakingTimeline.splice(0, 5000);
        }
      } catch {
        // Sampling is best-effort; a failed sample must never disturb the recording.
      }
    }, SIGNAL_SAMPLE_INTERVAL_MS);
    signalsTimer.unref?.();
  }

  function stopSignalSampling() {
    if (signalsTimer) clearInterval(signalsTimer);
    signalsTimer = null;
  }

  function rosterSnapshot() {
    return [...roster.values()];
  }

  function scheduleFlush() {
    flushChain = flushChain
      .then(() => flushSegments())
      .catch((error) => {
        console.error(`segment flush failed (will retry on next flush): ${error.message}`);
      });
  }

  async function flushSegments() {
    const pending = segments.slice(flushedCount);
    if (!pending.length) return;
    for (const segment of pending) {
      attachSpeakerHints(segment);
    }
    await api.appendSegments(pending);
    flushedCount += pending.length;
  }

  function attachAllHints() {
    for (const segment of segments) {
      attachSpeakerHints(segment);
    }
    return segments;
  }

  function attachSpeakerHints(segment) {
    if (Array.isArray(segment.speakerHints) && segment.speakerHints.length) return;
    const captureStartMs = deepgram?.captureStartMs;
    if (!captureStartMs || !speakingTimeline.length) return;

    // Segment times are seconds from the first audio chunk; widen the window slightly
    // because UI sampling and caption rendering lag the audio.
    const windowStartMs = captureStartMs + segment.start * 1000 - 750;
    const windowEndMs = captureStartMs + segment.end * 1000 + 750;
    const counts = new Map();
    for (const sample of speakingTimeline) {
      if (sample.atMs < windowStartMs) continue;
      if (sample.atMs > windowEndMs) break;
      for (const name of sample.names) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    const hints = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    if (hints.length) segment.speakerHints = hints;
  }

  async function cleanup() {
    stoppingAudio = true;
    stopSignalSampling();
    audioSource?.stop();
    await deepgram?.close().catch(() => {});
    await bot?.close().catch(() => {});
  }

  try {
    const meeting = await api.getMeeting();
    await api.appendEvent("bot.runner_started", "External bot runner booted.");
    await api.updateMeeting({
      status: "recording",
      statusMessage: "Bot runner is joining Google Meet."
    });

    bot = new MeetBrowserBot({
      meetUrl: meeting.meetUrl,
      displayName: process.env.BOT_DISPLAY_NAME || "OpenNotetaker - Recording",
      chromeChannel: process.env.BOT_CHROME_CHANNEL || "chrome",
      chromeExecutablePath: process.env.BOT_CHROME_EXECUTABLE_PATH || "",
      chromeUserDataDir: process.env.BOT_CHROME_USER_DATA_DIR || ".bot-profile",
      chromeLaunchMode: process.env.BOT_CHROME_LAUNCH_MODE || "rawcdp",
      chromeExtraArgs: splitArgs(process.env.BOT_CHROME_EXTRA_ARGS || ""),
      headless: parseBoolean(process.env.BOT_HEADLESS, false),
      aloneTimeoutMs: parsePositiveInt(process.env.BOT_ALONE_TIMEOUT_SECONDS, 45) * 1000
    });

    await bot.join();
    await api.appendEvent("bot.joined", "Bot joined Google Meet as a visible participant.");

    const nameSignals = await bot.prepareNameSignals();
    await api.appendEvent(
      "bot.name_signals",
      `Speaker-name signals prepared: captions ${nameSignals.captionsClicked ? "on" : "unavailable"}, ` +
        `people panel ${nameSignals.peoplePanelClicked ? "open" : "unavailable"}.`
    );
    startSignalSampling();

    deepgram = new DeepgramStreamingClient({
      apiKey: requiredEnv("DEEPGRAM_API_KEY"),
      model: process.env.DEEPGRAM_MODEL || "nova-3",
      language: process.env.DEEPGRAM_LANGUAGE || "multi",
      keyterms: splitList(process.env.DEEPGRAM_KEYTERMS || ""),
      extraParams: parseQueryParams(process.env.DEEPGRAM_EXTRA_PARAMS || "")
    });

    let sttDead = null;
    const sttFatal = new Promise((_, reject) => {
      sttDead = reject;
    });

    await deepgram.connect({
      onSegment: (segment) => {
        segments.push(segment);
        if (segments.length - flushedCount >= FLUSH_BATCH_SIZE) {
          scheduleFlush();
        }
      },
      onError: (error) => {
        void api.appendEvent("stt.error", error.message || "Deepgram streaming error.");
      },
      onReconnect: ({ attempt, backoffMs }) => {
        void api.appendEvent(
          "stt.reconnecting",
          `Deepgram connection dropped; reconnect attempt ${attempt} in ${backoffMs}ms. ` +
            "Audio is buffered while disconnected, so the transcript gap should be small."
        );
      },
      onFatal: (error) => {
        sttDead?.(error);
      }
    });

    audioSource = new FfmpegAudioSource({
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
      driver: process.env.AUDIO_CAPTURE_DRIVER || "pulse",
      source: process.env.AUDIO_CAPTURE_SOURCE || "default"
    });
    let warnedNoSegments = false;
    let ffmpegStderrEvents = 0;
    const audioExited = new Promise((_, reject) => {
      audioSource.start(
        (chunk) => deepgram.sendAudio(chunk),
        {
          onStderr: (message) => {
            if (ffmpegStderrEvents >= 3) return;
            ffmpegStderrEvents += 1;
            void api.appendEvent("audio.ffmpeg_stderr", message.slice(0, 500));
          },
          onExit: ({ code, signal, bytesCaptured, lastStderr }) => {
            if (stoppingAudio) return;
            const detail = lastStderr ? ` Last ffmpeg stderr: ${lastStderr}` : "";
            reject(new Error(
              `Audio capture exited before the meeting ended ` +
              `(code ${code ?? "none"}, signal ${signal ?? "none"}, ${bytesCaptured} bytes captured).${detail}`
            ));
          }
        }
      );
    });

    await api.updateMeeting({
      status: "recording",
      statusMessage: "Bot is recording and streaming audio to Deepgram."
    });
    await api.appendEvent(
      "audio.capture_started",
      `ffmpeg source ${process.env.AUDIO_CAPTURE_DRIVER || "pulse"}:${process.env.AUDIO_CAPTURE_SOURCE || "default"} started.`
    );

    const maxDurationMinutes = parsePositiveInt(process.env.BOT_MAX_DURATION_MINUTES, 120);
    const reason = await Promise.race([
      bot.waitUntilFinished({
        maxDurationMs: maxDurationMinutes * 60 * 1000,
        onHeartbeat: async () => {
          const audioKb = Math.round((audioSource?.bytesCaptured || 0) / 1024);
          await api.appendEvent("bot.heartbeat", `${segments.length} transcript segments captured; ${audioKb}KB audio sent.`);
          await api
            .updateMeeting({
              status: "recording",
              statusMessage: `${segments.length} transcript segments captured so far.`,
              artifacts: { participants: rosterSnapshot() }
            })
            .catch(() => {});
          scheduleFlush();
          if (!warnedNoSegments && audioKb > 256 && segments.length === 0) {
            warnedNoSegments = true;
            await api.appendEvent(
              "stt.no_segments",
              "Audio bytes are flowing, but Deepgram has not emitted transcript segments yet. Check that the capture source is real meeting audio, not silence or the wrong input."
            );
          }
        }
      }),
      audioExited,
      sttFatal
    ]);

    stoppingAudio = true;
    audioSource.stop();
    // Drain trailing final results before tearing anything down: the last utterances
    // of a meeting are disproportionately where the commitments live.
    await deepgram.close();
    stopSignalSampling();
    await bot.close();

    if (!segments.length) {
      throw new Error(`Bot finished because ${reason}, but no transcript segments were captured.`);
    }

    await api.appendEvent("bot.recording_finished", `Bot stopped recording because ${reason}.`);
    scheduleFlush();
    await flushChain;
    await api
      .updateMeeting({ artifacts: { participants: rosterSnapshot() } })
      .catch(() => {});
    // The full array is sent once as a crash-safety net; the server merges it with the
    // incrementally flushed segments by id.
    await api.submitRawTranscript(attachAllHints());
    console.log(`submitted ${segments.length} transcript segments for meeting ${meetingId}`);
    return true;
  } catch (error) {
    await cleanup();
    if (segments.length) {
      // A failed runner should still salvage what it heard instead of dropping the
      // recording: submit the partial transcript so the pipeline can finish the notes.
      await api
        .appendEvent(
          "bot.partial_transcript",
          `Runner failed after capturing ${segments.length} segments; finalizing the partial transcript. ${error.message}`
        )
        .catch(() => {});
      await api.submitRawTranscript(attachAllHints()).catch(() => {});
    } else {
      await api
        .updateMeeting({
          status: "failed",
          statusMessage: error.message || "External bot runner failed."
        })
        .catch(() => {});
    }
    await api.appendEvent("bot.runner_failed", error.message || "External bot runner failed.").catch(() => {});
    console.error(error.stack || error.message);
    return false;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitArgs(value) {
  return String(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseQueryParams(value) {
  const params = new URLSearchParams(String(value).replace(/^\?/, ""));
  const parsed = {};
  for (const [key, item] of params) {
    if (!key || item === "") continue;
    if (parsed[key]) {
      parsed[key] = Array.isArray(parsed[key]) ? [...parsed[key], item] : [parsed[key], item];
    } else {
      parsed[key] = item;
    }
  }
  return parsed;
}
