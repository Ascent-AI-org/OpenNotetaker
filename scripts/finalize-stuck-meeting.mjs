import { readFileSync } from "node:fs";
import { readConfig } from "../src/config.js";
import { GeminiProvider } from "../src/providers/gemini.js";

const args = process.argv.slice(2);
const meetingId = args.find((arg) => !arg.startsWith("--"));
const baseUrl = args.find((arg) => /^https?:\/\//u.test(arg)) || "http://127.0.0.1:5173";
const forceReconstruct = args.includes("--force-reconstruct");

if (!meetingId) {
  throw new Error("Usage: node scripts/finalize-stuck-meeting.mjs <meeting-id> [base-url]");
}

const config = readConfig();
if (!config.runner.token) {
  throw new Error("RUNNER_TOKEN is missing.");
}

const data = JSON.parse(readFileSync("data/meetings.json", "utf8"));
const meeting = data.meetings.find((item) => item.id === meetingId);
if (!meeting) {
  throw new Error(`Meeting ${meetingId} was not found.`);
}

let normalizedSegments = meeting.artifacts?.normalizedSegments || [];
if (!normalizedSegments.length) {
  throw new Error(`Meeting ${meetingId} does not have normalized segments yet.`);
}

const provider = new GeminiProvider(config.llm.gemini);
console.log(
  JSON.stringify({
    step: "start",
    meetingId,
    normalizedSegments: normalizedSegments.length
  })
);

const reconstructedTranscript =
  !forceReconstruct && meeting.artifacts?.reconstructedTranscript?.turns?.length
    ? meeting.artifacts.reconstructedTranscript
    : await provider.reconstructTranscript(normalizedSegments);

console.log(
  JSON.stringify({
    step: "reconstructed",
    turns: reconstructedTranscript.turns.length,
    roles: reconstructedTranscript.roles.length
  })
);

await patchMeeting({
  status: "reconstructing",
  statusMessage: "Speaker labels repaired into stable meeting roles.",
  artifacts: { reconstructedTranscript }
});
await appendEvent("transcript.reconstructed", `${reconstructedTranscript.turns.length} role-corrected turns created.`);

let notes;
try {
  notes = meeting.artifacts?.notes || await provider.extractNotes(reconstructedTranscript);
} catch (error) {
  notes = createFallbackNotes(error);
}
console.log(
  JSON.stringify({
    step: "notes",
    actions: notes.actionItems.length,
    fallback: notes.source === "fallback"
  })
);

await patchMeeting({
  status: "completed",
  statusMessage: "Summary and action items are ready.",
  artifacts: { reconstructedTranscript, notes }
});
await appendEvent("notes.ready", `${notes.actionItems.length} action items extracted.`);

const delivery = await api(`/api/meetings/${meetingId}/email-transcript`, { method: "POST" });
console.log(
  JSON.stringify({
    step: "email",
    delivery: delivery.delivery,
    emailStatus: delivery.meeting?.delivery?.transcriptEmail || null
  })
);

async function appendEvent(type, message) {
  return api(`/api/runner/meetings/${meetingId}/events`, {
    method: "POST",
    headers: authorizedJsonHeaders(),
    body: JSON.stringify({ type, message })
  });
}

async function patchMeeting(patch) {
  return api(`/api/runner/meetings/${meetingId}`, {
    method: "PATCH",
    headers: authorizedJsonHeaders(),
    body: JSON.stringify(patch)
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function authorizedJsonHeaders() {
  return {
    Authorization: `Bearer ${config.runner.token}`,
    "Content-Type": "application/json"
  };
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function createFallbackNotes(error) {
  return {
    source: "fallback",
    summary:
      "The meeting transcript was captured and converted to clean English, but automated notes extraction did not complete. Review the role-corrected and clean transcript sections below.",
    actionItems: [],
    decisions: [],
    openQuestions: [
      "Automated notes extraction failed; review the transcript evidence manually."
    ],
    risks: [
      `Notes extraction failed: ${error.message}`
    ]
  };
}
