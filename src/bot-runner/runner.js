import { recordMeeting } from "./record-meeting.js";

// Single-meeting mode: the web app (BOT_PROVIDER=external) spawns this with a meeting
// id, records it once, and exits. Fleet deployments use worker.js instead.
const meetingId = argValue("--meeting-id") || process.env.MEETING_ID;
if (!meetingId) {
  console.error("Pass --meeting-id <id> or set MEETING_ID.");
  process.exit(1);
}

const succeeded = await recordMeeting({ meetingId });
process.exitCode = succeeded ? 0 : 1;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}
