import { readFileSync } from "node:fs";
import { readConfig } from "../src/config.js";

// Re-finalize a meeting whose recording was captured but whose notes never completed
// (e.g. an old finalization failure). This resubmits the stored raw transcript through
// the same server endpoint a recording worker uses, so the current server-side pipeline
// (resilient reconstruction, chunked notes) runs and the server owns the status
// transitions. Run it from the repo root, or inside the web container:
//   node scripts/finalize-stuck-meeting.mjs <meeting-id> [base-url]

const args = process.argv.slice(2);
const meetingId = args.find((arg) => !arg.startsWith("--"));
const baseUrl = args.find((arg) => /^https?:\/\//u.test(arg)) || "http://127.0.0.1:5173";

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

const rawSegments = meeting.artifacts?.rawSegments || [];
if (!rawSegments.length) {
  throw new Error(`Meeting ${meetingId} has no captured raw transcript to finalize.`);
}

console.log(JSON.stringify({ step: "submit", meetingId, rawSegments: rawSegments.length }));

// The server merges these with anything already stored and re-runs finalization async.
const accepted = await api(`/api/runner/meetings/${meetingId}/raw-transcript`, {
  method: "POST",
  headers: authorizedJsonHeaders(),
  body: JSON.stringify({ rawSegments })
});
console.log(JSON.stringify({ step: "accepted", ...accepted }));

// Poll until the server finishes (or fails) finalizing. Notes generation over a long
// meeting makes many LLM calls, so allow several minutes.
let status = meeting.status;
let statusMessage = "";
for (let attempt = 0; attempt < 120; attempt += 1) {
  await delay(5000);
  const current = await api(`/api/runner/meetings/${meetingId}`, { headers: authorizedJsonHeaders() });
  status = current.meeting?.status || "";
  statusMessage = current.meeting?.statusMessage || "";
  const actionItems = current.meeting?.artifacts?.notes?.actionItems?.length ?? null;
  console.log(JSON.stringify({ step: "poll", status, statusMessage, actionItems }));
  if (status === "completed" || status === "failed") break;
}

console.log(JSON.stringify({ step: "done", status, statusMessage }));
if (status !== "completed") {
  process.exitCode = 1;
}

function authorizedJsonHeaders() {
  return {
    Authorization: `Bearer ${config.runner.token}`,
    "Content-Type": "application/json"
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text}`);
  }
  return body;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
