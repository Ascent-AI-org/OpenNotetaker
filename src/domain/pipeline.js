import { createDemoTranscript } from "./demo-transcript.js";
import { findRecordingPeer } from "./runner-jobs.js";
import { GeminiProvider } from "../providers/gemini.js";
import { MockLlmProvider } from "../providers/mock.js";
import { OpenAiProvider } from "../providers/openai.js";
import { startExternalBotJob } from "../providers/external-bot.js";

export function createLlmProvider(config) {
  if (config.llm.provider === "openai") {
    return new OpenAiProvider(config.llm.openai);
  }
  if (config.llm.provider === "gemini") {
    return new GeminiProvider(config.llm.gemini);
  }
  return new MockLlmProvider();
}

export async function runDemoPipeline({ meeting, store, llmProvider }) {
  await store.updateMeeting(meeting.id, {
    status: "recording",
    statusMessage: "Demo bot is simulating a Hinglish meeting capture."
  });
  await store.appendEvent(meeting.id, {
    type: "bot.joined",
    message: "Demo notetaker joined as OpenNotetaker - Recording."
  });

  const rawSegments = createDemoTranscript();
  await delay(350);
  return processRawSegments({ meeting, store, llmProvider, rawSegments, stepDelayMs: 350 });
}

export async function finalizeRawTranscript({ meeting, store, config, rawSegments }) {
  const llmProvider = createLlmProvider(config);
  return processRawSegments({ meeting, store, llmProvider, rawSegments, stepDelayMs: 0 });
}

async function processRawSegments({ meeting, store, llmProvider, rawSegments, stepDelayMs }) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    await store.updateMeeting(meeting.id, {
      status: "failed",
      statusMessage: "No transcript segments were captured."
    });
    await store.appendEvent(meeting.id, {
      type: "transcript.empty",
      message: "The bot finished without any transcript segments."
    });
    return store.getMeeting(meeting.id);
  }

  // The runner may have collected a participant roster from the Meet UI; re-read the
  // stored meeting because the caller's copy can predate that PATCH.
  const storedMeeting = store.getMeeting(meeting.id);
  const participants = (storedMeeting?.artifacts?.participants || [])
    .map((participant) => (typeof participant === "string" ? participant : participant?.name))
    .filter(Boolean);

  await store.updateMeeting(meeting.id, {
    status: "transcribing",
    statusMessage: "Raw Hinglish transcript captured.",
    artifacts: { rawSegments }
  });
  await store.appendEvent(meeting.id, {
    type: "transcript.raw_ready",
    message: `${rawSegments.length} transcript segments captured.`
  });

  await delay(stepDelayMs);
  await store.updateMeeting(meeting.id, {
    status: "normalizing",
    statusMessage: "Converting Hinglish transcript into clean English."
  });
  const normalizedOutput = await llmProvider.normalizeSegments(rawSegments, { participants });
  // The normalization schema does not include speakerHints; re-attach them from the
  // raw segments by id so speaker evidence survives into reconstruction.
  const hintsById = new Map(
    rawSegments
      .filter((segment) => Array.isArray(segment.speakerHints) && segment.speakerHints.length)
      .map((segment) => [segment.id, segment.speakerHints])
  );
  const normalizedSegments = normalizedOutput.map((segment) =>
    hintsById.has(segment.id) ? { ...segment, speakerHints: hintsById.get(segment.id) } : segment
  );
  await store.updateMeeting(meeting.id, {
    status: "normalizing",
    statusMessage: "Hinglish transcript converted into clean English.",
    artifacts: { normalizedSegments }
  });
  await store.appendEvent(meeting.id, {
    type: "transcript.normalized",
    message: "English normalization pass completed."
  });

  await delay(stepDelayMs);
  const reconstructedTranscript = await reconstructTranscript({
    meeting,
    store,
    llmProvider,
    normalizedSegments,
    participants
  });
  const notesSource = reconstructedTranscript || { segments: normalizedSegments };
  const notes = await llmProvider.extractNotes(notesSource, { participants });
  await verifyActionItems({ meeting, store, llmProvider, notesSource, notes, participants });
  const completed = await store.updateMeeting(meeting.id, {
    status: "completed",
    statusMessage: "Summary and action items are ready.",
    artifacts: { notes }
  });
  await store.appendEvent(meeting.id, {
    type: "notes.ready",
    message: `${notes.actionItems.length} action items extracted.`
  });

  return completed;
}

async function verifyActionItems({ meeting, store, llmProvider, notesSource, notes, participants }) {
  if (typeof llmProvider.verifyActionItems !== "function") return;

  await store.updateMeeting(meeting.id, {
    statusMessage: "Double-checking action items against the transcript."
  });

  try {
    const verified = await llmProvider.verifyActionItems(
      { transcript: notesSource, notes },
      { participants }
    );
    if (!Array.isArray(verified?.actionItems)) return;

    const delta = verified.actionItems.length - notes.actionItems.length;
    notes.actionItems = verified.actionItems;
    await store.appendEvent(meeting.id, {
      type: "notes.action_items_verified",
      message:
        delta > 0
          ? `Verification pass recovered ${delta} missed action item${delta === 1 ? "" : "s"}.`
          : "Verification pass confirmed the extracted action items."
    });
  } catch (error) {
    // Verification is an enhancement on top of already-extracted notes; keep the
    // original list rather than failing the whole meeting.
    await store.appendEvent(meeting.id, {
      type: "notes.verify_failed",
      message: `Action item verification failed; keeping the first extraction. ${error.message}`
    });
  }
}

async function reconstructTranscript({ meeting, store, llmProvider, normalizedSegments, participants = [] }) {
  if (typeof llmProvider.reconstructTranscript !== "function") {
    return null;
  }

  await store.updateMeeting(meeting.id, {
    status: "reconstructing",
    statusMessage: "Repairing speaker labels into stable meeting roles."
  });

  const reconstructedTranscript = await llmProvider.reconstructTranscript(normalizedSegments, { participants });
  await store.updateMeeting(meeting.id, {
    status: "reconstructing",
    statusMessage: "Speaker labels repaired into stable meeting roles.",
    artifacts: { reconstructedTranscript }
  });
  await store.appendEvent(meeting.id, {
    type: "transcript.reconstructed",
    message: `${reconstructedTranscript.turns.length} role-corrected turns created.`
  });
  return reconstructedTranscript;
}

export async function runNotetakerJob({ meeting, store, config }) {
  const llmProvider = createLlmProvider(config);

  if (config.bot.provider === "demo") {
    return runDemoPipeline({ meeting, store, llmProvider });
  }

  // Cross-user dedupe: if another user's job is already recording (or has just
  // recorded) this exact Meet slot, don't send a second bot — follow that recording
  // and copy its artifacts when they're ready.
  const peer = findRecordingPeer(store.listMeetings(), meeting);
  if (peer) {
    if (peer.status === "completed") {
      const copied = await copyRecordingArtifacts({ store, from: store.getMeeting(peer.id), toId: meeting.id });
      await store.appendEvent(meeting.id, {
        type: "bot.recording_shared",
        message: "Reused the notes from a recording of this meeting that already finished."
      });
      return copied;
    }

    await store.updateMeeting(meeting.id, {
      status: "following",
      followsMeetingId: peer.id,
      statusMessage: "Another OpenNotetaker bot is already recording this meeting; notes will arrive when it finishes."
    });
    await store.appendEvent(meeting.id, {
      type: "bot.recording_shared",
      message: "A bot is already in this meeting for another user; following that recording instead of joining twice."
    });
    return store.getMeeting(meeting.id);
  }

  if (config.bot.provider === "fleet") {
    // Fleet mode: recording workers poll /api/runner/jobs/claim and record one meeting
    // per container, so any number of meetings can run concurrently. The server only
    // marks the job as claimable here.
    await store.updateMeeting(meeting.id, {
      status: "queued",
      statusMessage: "Waiting for a recording worker to claim this meeting.",
      runner: null
    });
    await store.appendEvent(meeting.id, {
      type: "bot.job_queued",
      message: "Meeting queued for the recording worker fleet."
    });
    return store.getMeeting(meeting.id);
  }

  if (config.bot.provider === "external") {
    await store.updateMeeting(meeting.id, {
      status: "queued",
      statusMessage: "External bot runner is starting."
    });
    const result = await startExternalBotJob({ meeting, store, config });
    if (result?.queued) {
      // startExternalBotJob already recorded the waiting state; the queue drains when
      // the active recording finishes.
      return store.getMeeting(meeting.id);
    }
    await store.updateMeeting(meeting.id, {
      status: "queued",
      statusMessage: "External bot runner has been started."
    });
    await store.appendEvent(meeting.id, {
      type: "bot.runner_spawned",
      message: `External bot runner started with pid ${result.pid}.`
    });
    return store.getMeeting(meeting.id);
  }

  await store.updateMeeting(meeting.id, {
    status: "queued",
    statusMessage: "Bot provider is configured, but no runner is available for it."
  });
  await store.appendEvent(meeting.id, {
    type: "bot.provider_missing",
    message: `Unsupported bot provider: ${config.bot.provider}.`
  });
  return store.getMeeting(meeting.id);
}

export async function copyRecordingArtifacts({ store, from, toId }) {
  return store.updateMeeting(toId, {
    status: "completed",
    statusMessage: "Summary and action items are ready (shared recording).",
    followsMeetingId: from.id,
    artifacts: {
      rawSegments: from.artifacts?.rawSegments || [],
      normalizedSegments: from.artifacts?.normalizedSegments || [],
      reconstructedTranscript: from.artifacts?.reconstructedTranscript || null,
      participants: from.artifacts?.participants || [],
      notes: from.artifacts?.notes || null
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
