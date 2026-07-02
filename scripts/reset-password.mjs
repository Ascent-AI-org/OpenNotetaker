// Operator password-reset fallback for accounts without a Google connection.
// Issues a one-time reset code through the running server (never writes the store
// directly — the server owns that file). Usage:
//
//   node scripts/reset-password.mjs --email user@example.com
//
// Reads OPENNOTETAKER_BASE_URL and RUNNER_TOKEN from the environment or .env, then
// prints the code for the operator to hand to the user, who enters it in the
// "Forgot password" form.
import { loadDotEnv } from "../src/config.js";

loadDotEnv();

const email = argValue("--email");
if (!email) {
  console.error("Usage: node scripts/reset-password.mjs --email user@example.com");
  process.exit(1);
}

const baseUrl = (process.env.OPENNOTETAKER_BASE_URL || "http://127.0.0.1:5173").replace(/\/$/, "");
const token = process.env.RUNNER_TOKEN;
if (!token) {
  console.error("RUNNER_TOKEN is required (set it in .env or the environment).");
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/runner/admin/password-reset`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ email })
});
const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`Reset failed (${response.status}): ${body.message || body.error || "unknown error"}`);
  process.exit(1);
}

console.log(`Reset code for ${body.email} (valid ${body.expiresInMinutes} minutes, single use):`);
console.log(`\n  ${body.resetToken}\n`);
console.log('Hand this to the user: they enter it under "Forgot password" with a new password.');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}
