import { RunnerApiClient } from "./api-client.js";
import { FfmpegAudioSource } from "./audio-source.js";
import { FfmpegVideoSource, planUploadBatch, videoCapExceeded } from "./video-source.js";
import { MeetBrowserBot } from "./meet-browser.js";
import { DeepgramStreamingClient } from "../providers/deepgram.js";

const SIGNAL_SAMPLE_INTERVAL_MS = 1000;
const FLUSH_BATCH_SIZE = 10;

// Big enough that a two-hour recording is a few hundred requests instead of tens of
// thousands, small enough that a worker killed between POSTs loses seconds of video.
const VIDEO_UPLOAD_TARGET_BYTES = 4 * 1024 * 1024;
// Headroom under the server's 8MB chunk cap: a batch that crosses it is rejected whole,
// and the same bytes would then be retried until the meeting ended.
const VIDEO_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
const VIDEO_UPLOAD_ATTEMPTS = 3;
// How long a failed batch waits before the next attempt, by consecutive failure. Retries
// need their own clock: a failed batch puts its bytes back at the head of the queue, so
// pendingBytes stays over the target and every 64KB frame ffmpeg emits would otherwise
// queue another attempt — fifteen a second, spending the whole retry budget inside a few
// seconds of an app restart that lasts fifteen.
const VIDEO_RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];
// How long uploads may keep failing before video is given up on. Measured in elapsed time
// rather than in attempts, because the failure this exists to survive is a redeploy of the
// web app: long enough to sit one out, short enough that a genuinely unreachable server is
// not still being retried when the meeting ends.
const VIDEO_UPLOAD_GIVE_UP_MS = 5 * 60_000;
const VIDEO_DRAIN_PASSES = 3;
// The hard ceiling on stopping the encoder, which happens BEFORE the transcript is
// submitted. Bounded because api.appendEvent has no timeout of its own.
const VIDEO_STOP_DEADLINE_MS = 15_000;
// The hard ceiling on draining the upload queue and remuxing, which happen after the
// transcript is submitted. Kept under docker-compose's 60s stop_grace_period so the
// deadline is reachable rather than something SIGKILL always gets to first.
const VIDEO_FINISH_DEADLINE_MS = 45_000;

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

  // Video capture state, kept entirely separate from the audio path above. Nothing in
  // this group is ever allowed to end the meeting or to reject into the recording loop:
  // the transcript is the product and the video is additive, so every failure here ends
  // in an event plus "carry on".
  let videoSource;
  let videoStopping = false;
  let videoUploadStopped = false;
  const videoPending = [];
  let videoPendingBytes = 0;
  let videoOffset = 0;
  let videoChain = Promise.resolve();
  let videoBatchFailures = 0;
  let videoFailingSinceMs = 0;
  let videoRetryTimer = null;
  let videoUploadQueued = false;
  const videoMaxBytes = parsePositiveInt(process.env.VIDEO_MAX_MB, 2048) * 1024 * 1024;

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

  // Two gates, both required. The operator flag is the install-wide opt-in, and the
  // meeting record is this call's consent. An older record that predates the feature
  // says nothing about consent, and "nothing" is not "yes" — pointing a camera at
  // someone is not a default worth guessing at.
  async function startVideoCapture(meeting) {
    if (!parseBoolean(process.env.VIDEO_RECORDING_ENABLED, false)) return;
    if (meeting.video?.enabled !== true) {
      await api
        .appendEvent("video.disabled", "Video recording is off for this meeting; audio and transcript are unaffected.")
        .catch(() => {});
      return;
    }

    const driver = process.env.VIDEO_CAPTURE_DRIVER || "x11grab";
    const source = process.env.VIDEO_CAPTURE_SOURCE || ":99";
    const size = process.env.VIDEO_SIZE || "1280x720";
    const framerate = parsePositiveInt(process.env.VIDEO_FRAMERATE, 15);

    try {
      videoSource = new FfmpegVideoSource({
        ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
        driver,
        source,
        framerate,
        size,
        crf: parsePositiveInt(process.env.VIDEO_CRF, 30),
        preset: process.env.VIDEO_PRESET || "veryfast",
        // The same PulseAudio monitor the transcription capture reads: a monitor source
        // fans out to every reader, so recording it twice costs nothing.
        audioSource: process.env.AUDIO_CAPTURE_SOURCE || "open_notetaker.monitor"
      });

      let videoStderrEvents = 0;
      videoSource.start(queueVideoChunk, {
        onStderr: (message) => {
          if (videoStderrEvents >= 3) return;
          videoStderrEvents += 1;
          void api.appendEvent("video.ffmpeg_stderr", message.slice(0, 500)).catch(() => {});
        },
        onExit: ({ code, signal, bytesCaptured, lastStderr }) => {
          // Deliberately NOT raced into the Promise.race that ends the meeting, the way
          // audioExited is. A dead video encoder is a lost video; a dead audio capture
          // is a lost meeting. Only one of those should stop a recording.
          if (videoStopping) return;
          const detail = lastStderr ? ` Last ffmpeg stderr: ${lastStderr}` : "";
          // An unhandled rejection here would take the whole worker down — and the
          // transcript with it — so even a reporting failure stays swallowed.
          void failVideo(
            `Video capture exited mid-meeting (code ${code ?? "none"}, signal ${signal ?? "none"}, ` +
              `${Math.round(bytesCaptured / 1024)}KB captured).${detail}`
          ).catch(() => {});
        }
      });

      await api.appendEvent(
        "video.capture_started",
        `ffmpeg ${driver}:${source} recording at ${size}@${framerate}fps.`
      );
    } catch (error) {
      await failVideo(`Video capture could not start: ${error.message}`);
    }
  }

  function queueVideoChunk(chunk) {
    if (videoUploadStopped) return;
    videoPending.push(chunk);
    videoPendingBytes += chunk.length;
    videoSource.applyBackpressure(videoPendingBytes);

    if (videoCapExceeded({ capturedBytes: videoSource.bytesCaptured, maxBytes: videoMaxBytes })) {
      // Stop capturing, keep everything already queued: the meeting carries on with
      // audio, and the shortened video still finalizes into something watchable.
      void endVideoCapture(
        "video.size_limit",
        `Video reached the ${Math.round(videoMaxBytes / (1024 * 1024))}MB ceiling and stopped; ` +
          "audio recording and transcription continue."
      ).catch(() => {});
      return;
    }
    if (videoPendingBytes >= VIDEO_UPLOAD_TARGET_BYTES) scheduleVideoUpload();
  }

  function scheduleVideoUpload({ drain = false } = {}) {
    // At most one run queued at a time, and none at all while a retry is armed. ffmpeg
    // emits a chunk fifteen times a second and a run that is already waiting will take
    // whatever has arrived by the time it gets there — queueing one per chunk only stacks
    // up work that finds an empty queue, and after a failure it stacks up retries the
    // backoff is supposed to be spacing out. A drain is the end of the meeting and waits
    // for neither.
    if (!drain && (videoRetryTimer || videoUploadQueued)) return;
    videoUploadQueued = true;
    videoChain = videoChain
      .then(() => uploadVideoBatches({ drain }))
      .catch((error) => {
        console.error(`video upload failed (a retry is armed): ${error.message}`);
      })
      .finally(() => {
        videoUploadQueued = false;
      });
  }

  // The only thing that gets an upload moving again once the queue is at its cap: the
  // encoder's pipe is paused there, so no further chunk arrives to trigger a retry, and
  // without a timer a single refused connection would strand the video for the rest of
  // the meeting. Unref'd, so it can never be the reason a finished worker stays alive.
  function armVideoRetry(delayMs) {
    if (videoRetryTimer || videoUploadStopped) return;
    videoRetryTimer = setTimeout(() => {
      videoRetryTimer = null;
      scheduleVideoUpload();
    }, delayMs);
    videoRetryTimer.unref?.();
  }

  function clearVideoRetry() {
    if (!videoRetryTimer) return;
    clearTimeout(videoRetryTimer);
    videoRetryTimer = null;
  }

  async function uploadVideoBatches({ drain }) {
    const floor = drain ? 1 : VIDEO_UPLOAD_TARGET_BYTES;
    while (!videoUploadStopped && videoPendingBytes >= floor) {
      const { count, bytes } = planUploadBatch(
        videoPending.map((chunk) => chunk.length),
        { targetBytes: VIDEO_UPLOAD_TARGET_BYTES, maxBytes: VIDEO_UPLOAD_MAX_BYTES }
      );
      if (!count) return;

      const payload = Buffer.concat(videoPending.splice(0, count), bytes);
      videoPendingBytes -= bytes;
      videoSource?.applyBackpressure(videoPendingBytes);

      if (await sendVideoChunk(payload)) continue;
      // Video has been given up on; holding these bytes would only keep them alive in
      // the worker's heap for the rest of the meeting.
      if (videoUploadStopped) return;

      // Put the bytes back at the head of the queue. The recording is one append-only
      // byte range, so skipping a failed payload would splice a hole into the middle of
      // it that no player can recover from — a retry is the only correct move.
      videoPending.unshift(payload);
      videoPendingBytes += payload.length;
      videoSource?.applyBackpressure(videoPendingBytes);
      return;
    }
  }

  async function sendVideoChunk(payload) {
    for (let attempt = 1; attempt <= VIDEO_UPLOAD_ATTEMPTS; attempt += 1) {
      try {
        const { bytesReceived } = await api.appendVideoChunk(videoOffset, payload);
        // The server's own file size is the authority on where the next chunk goes.
        // Trusting it (rather than counting locally) is what lets a chunk the server
        // already applied but never acknowledged be retried harmlessly.
        videoOffset = Number.isSafeInteger(bytesReceived) ? bytesReceived : videoOffset + payload.length;
        videoBatchFailures = 0;
        videoFailingSinceMs = 0;
        clearVideoRetry();
        return true;
      } catch (error) {
        if (error.code === "offset_gap" && Number.isSafeInteger(error.expected)) {
          if (error.expected === 0 && videoOffset > 0) {
            // The server no longer holds the partial file this stream started with.
            // Every later fragment is undecodable without that first header, so there is
            // nothing left worth uploading.
            await failVideo("The partial recording was lost on the server; video capture stopped.");
            return false;
          }
          // Resync to what the server actually holds and resend. The bytes in between
          // are gone, so the finished video will jump — worth an event, because
          // "the recording skips" is otherwise unexplainable from the run log.
          void api
            .appendEvent(
              "video.resync",
              `Upload resynced from offset ${videoOffset} to ${error.expected}; the recording will skip.`
            )
            .catch(() => {});
          videoOffset = error.expected;
          continue;
        }
        if (error.status === 413) {
          // The server-side ceiling (VIDEO_MAX_MB or free disk) refused the chunk. More
          // of the same is not going to fit either.
          videoUploadStopped = true;
          await endVideoCapture(
            "video.size_limit",
            `Server refused more video (${error.message}); audio recording and transcription continue.`
          );
          return false;
        }
        console.error(`video chunk upload attempt ${attempt} failed: ${error.message}`);
        if (attempt < VIDEO_UPLOAD_ATTEMPTS) await delay(500 * 2 ** (attempt - 1));
      }
    }

    // Dated from the first failure of the run rather than counted, so the give-up decision
    // is "the server has been unreachable for five minutes" and not "five calls failed" —
    // which, at the rate chunks arrive, is the same six seconds every time.
    if (!videoFailingSinceMs) videoFailingSinceMs = Date.now();
    const failingForMs = Date.now() - videoFailingSinceMs;
    armVideoRetry(VIDEO_RETRY_BACKOFF_MS[Math.min(videoBatchFailures, VIDEO_RETRY_BACKOFF_MS.length - 1)]);
    videoBatchFailures += 1;

    if (failingForMs >= VIDEO_UPLOAD_GIVE_UP_MS) {
      await failVideo(
        `Video upload has been failing for ${Math.round(failingForMs / 1000)}s (${videoBatchFailures} batches); ` +
          "video capture stopped."
      );
    }
    return false;
  }

  // Stops the encoder without ending the meeting. Safe to call twice, and safe to call
  // from an ffmpeg callback: videoStopping is set before the first await, so the exit it
  // provokes is not reported as a failure.
  async function endVideoCapture(type, message) {
    if (!videoSource || videoStopping) return;
    videoStopping = true;
    await api.appendEvent(type, String(message).slice(0, 500)).catch(() => {});
    // Teardown is capped short here because this can run while the meeting is still
    // going: a wedged encoder gets SIGKILL rather than a share of the recording.
    await videoSource.stop({ timeoutMs: 5000 }).catch((error) => {
      console.error(`video capture stop failed: ${error.message}`);
    });
  }

  async function failVideo(message) {
    videoUploadStopped = true;
    videoPending.length = 0;
    videoPendingBytes = 0;
    clearVideoRetry();
    await endVideoCapture("video.failed", message);
  }

  // The encoder half of teardown, split out from finishVideo() so it can run before the
  // transcript is submitted while the expensive half runs after it. Cheap and bounded, and
  // worth doing early: an encoder left running through the submission only appends frames
  // of a browser that has already closed.
  async function stopVideoCapture() {
    if (!videoSource) return;
    await endVideoCapture(
      "video.capture_stopped",
      `Video capture stopped after ${Math.round(videoSource.bytesCaptured / (1024 * 1024))}MB.`
    );
  }

  // Never throws: the caller races this against a deadline, and a rejection escaping here
  // would surface as a runner failure for a meeting whose transcript is already in.
  async function finishVideo() {
    if (!videoSource) return;
    try {
      await stopVideoCapture();
      clearVideoRetry();
      // A batch that exhausted its retries leaves its bytes at the head of the queue and
      // returns, so one drain pass is not enough to empty it. Bounded anyway: the
      // container is on a stop_grace_period clock from the moment the meeting ends, and
      // the last seconds of a video are not worth spending all of it.
      for (let pass = 1; pass <= VIDEO_DRAIN_PASSES && videoPendingBytes > 0 && !videoUploadStopped; pass += 1) {
        scheduleVideoUpload({ drain: true });
        await videoChain;
      }
      // Finalize whatever landed, even after a failure. The server holds a partial file
      // either way, and an orphaned one still counts against the disk budget while
      // belonging to no recording anyone can see or delete from the UI.
      if (videoOffset === 0) return;
      const video = await api.finalizeVideo();
      await api
        .appendEvent(
          "video.ready",
          `Recording finalized: ${Math.round((video?.bytes || videoOffset) / (1024 * 1024))}MB, ` +
            `${Math.round((video?.durationMs || 0) / 1000)}s.`
        )
        .catch(() => {});
    } catch (error) {
      console.error(`video finalize failed: ${error.message}`);
      await api.appendEvent("video.failed", `Video could not be finalized: ${error.message}`).catch(() => {});
    }
  }

  async function cleanup() {
    stoppingAudio = true;
    videoStopping = true;
    clearVideoRetry();
    stopSignalSampling();
    audioSource?.stop();
    await videoSource?.stop({ timeoutMs: 5000 }).catch(() => {});
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
      aloneTimeoutMs: parsePositiveInt(process.env.BOT_ALONE_TIMEOUT_SECONDS, 45) * 1000,
      // Calendar autostart launches the bot a couple of minutes early, so admission and
      // no-show patience are measured from the scheduled start, not from launch.
      scheduledStartAt: meeting.scheduledAt || "",
      admissionGraceMs: parsePositiveInt(process.env.BOT_ADMISSION_GRACE_MINUTES, 10) * 60_000,
      noShowGraceMs: parsePositiveInt(process.env.BOT_NO_SHOW_GRACE_MINUTES, 10) * 60_000
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

    // Started only once audio is already flowing to Deepgram, so a video encoder that
    // fights for the box's CPU can never be the reason transcription failed to start.
    await startVideoCapture(meeting);

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

    // Only the encoder is stopped here. Draining the upload queue and remuxing happen
    // AFTER the transcript submits, further down: this container is given 60s to die on a
    // deploy and deliberately ignores SIGTERM to finish the recording, so anything spent
    // on video before submitRawTranscript is time a slow remux can take the notes with it.
    await withDeadline(stopVideoCapture(), VIDEO_STOP_DEADLINE_MS, "video capture stop").catch(async (error) => {
      await api.appendEvent("video.failed", error.message).catch(() => {});
    });

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

    // Only once the transcript is safe, exactly as the failure path below does it. Under a
    // deadline and never allowed to reject: finishVideo() swallows its own errors, so the
    // only thing this race can throw is the deadline itself.
    await withDeadline(finishVideo(), VIDEO_FINISH_DEADLINE_MS, "video finalize").catch(async (error) => {
      await api.appendEvent("video.failed", error.message).catch(() => {});
    });
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
    // Only once the transcript is safe: a runner that died mid-meeting still uploaded
    // video, and finalizing it turns a partial file the app cannot show or purge into a
    // watchable — and deletable — recording of however far the meeting got.
    await withDeadline(finishVideo(), VIDEO_FINISH_DEADLINE_MS, "video finalize").catch(() => {});
    await api.appendEvent("bot.runner_failed", error.message || "External bot runner failed.").catch(() => {});
    console.error(error.stack || error.message);
    return false;
  }
}

// The losing side of the race keeps running; that is intentional. An upload or a remux
// that comes back late is harmless, whereas waiting for it holds up the notes.
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label} exceeded ${Math.round(ms / 1000)}s and was left to finish in the background.`);
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // The deadline timer must not be the reason a finished worker stays alive.
    timer.unref?.();
  });
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
