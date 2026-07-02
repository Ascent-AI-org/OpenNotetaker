import { hostname } from "node:os";
import { RunnerApiClient } from "./api-client.js";
import { recordMeeting } from "./record-meeting.js";

// Fleet worker: claims one queued meeting at a time from the web app and records it.
// Run one worker per container (each container owns one Chrome profile and one
// PulseAudio sink); scale concurrent recordings by scaling worker replicas.
const workerId = process.env.WORKER_ID || `${hostname()}-${process.pid}`;
const pollMs = parsePositiveInt(process.env.RUNNER_POLL_SECONDS, 5) * 1000;

const api = new RunnerApiClient({
  baseUrl: process.env.OPENNOTETAKER_BASE_URL,
  token: process.env.RUNNER_TOKEN
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Finish the recording in progress; stop claiming new work. A second signal (or
    // the container runtime's kill timeout) force-stops.
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal} received: finishing the current recording, no new claims.`);
  });
}

console.log(`worker ${workerId} polling ${api.baseUrl} every ${pollMs / 1000}s`);

while (!stopping) {
  let claim = null;
  try {
    claim = await api.claimJob(workerId);
  } catch (error) {
    console.error(`claim failed: ${error.message}`);
  }

  if (!claim?.meeting) {
    await delay(pollMs);
    continue;
  }

  console.log(`worker ${workerId} claimed meeting ${claim.meeting.id} (${claim.meeting.title})`);
  try {
    const succeeded = await recordMeeting({ meetingId: claim.meeting.id });
    console.log(`meeting ${claim.meeting.id} finished ${succeeded ? "successfully" : "with errors"}`);
  } catch (error) {
    console.error(`recording crashed for meeting ${claim.meeting.id}: ${error.message}`);
  }
  // Brief pause between recordings so Chrome/PulseAudio teardown fully settles.
  await delay(2000);
}

console.log(`worker ${workerId} stopped.`);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
