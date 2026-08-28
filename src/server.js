import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProviderSecrets, readConfig } from "./config.js";
import {
  DUMMY_PASSWORD_HASH_PROMISE,
  SESSION_COOKIE_NAME,
  buildClearSessionCookie,
  buildSessionCookie,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  parseCookies,
  validateEmail,
  validateName,
  validatePassword,
  verifyPassword
} from "./domain/auth.js";
import { resolveClientIp } from "./domain/client-ip.js";
import {
  MAX_GOOGLE_ACCOUNTS,
  calendarSyncAccounts,
  findGoogleAccount,
  listGoogleAccounts,
  matchGoogleAccount,
  pickSendingAccount,
  publicGoogleAccount,
  removeGoogleAccount,
  setDefaultGoogleAccount,
  updateGoogleAccount,
  upsertGoogleAccount
} from "./domain/google-accounts.js";
import {
  actionItemRecipients,
  attendeeSuggestions,
  parseRecipientList,
  transcriptRecipients
} from "./domain/note-delivery.js";
import {
  actionItemsChanged,
  dueActionItemEmails,
  parseActionItems,
  scheduleActionItemsEmail
} from "./domain/action-items.js";
import { buildActionItemsEmail } from "./domain/action-items-email.js";
import { SlidingWindowRateLimiter } from "./domain/rate-limit.js";
import { JsonStore } from "./storage/json-store.js";
import { UsersStore, publicUser } from "./storage/users-store.js";
import { copyRecordingArtifacts, finalizeRawTranscript, runNotetakerJob } from "./domain/pipeline.js";
import {
  buildLease,
  pickClaimableMeeting,
  renewLease,
  shouldReleaseClaim,
  shouldSalvageRecording
} from "./domain/runner-jobs.js";
import { isGoogleMeetUrl, sanitizeRawSegments, validateMeetingInput, sanitizeCaptureStart } from "./domain/validation.js";
import { MediaStore } from "./domain/media-store.js";
import { effectiveVideoRetentionDays, planDiskEviction, planVideoPurge } from "./domain/video-retention.js";
import { readRawBody, serveFileWithRange } from "./domain/video-http.js";
import { buildClipRecord, cutClip, validateClipRange } from "./domain/clips.js";
import {
  buildShareRecord,
  countShareView,
  findClipByTokenHash,
  hashShareToken,
  mintShareToken,
  publicShareUrl,
  shareActive
} from "./domain/share-links.js";
import {
  ExportTooLargeError,
  MAX_EXPORT_MEETINGS,
  buildExportBundle,
  parseExportRequest,
  selectExportMeetings
} from "./domain/export.js";
import { buildTranscriptEmail } from "./domain/transcript-email.js";
import { parseNotesEmailSelection } from "./domain/notes-email-selection.js";
import { renderNotesEmail } from "./domain/notes-email-render.js";
import {
  CALENDAR_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_WORKSPACE_SCOPES,
  createGmailOAuthUrl,
  createMimeMessage,
  exchangeGmailCode,
  extractGoogleMeetUrl,
  deleteGmailToken,
  fetchGoogleUserinfo,
  getGoogleAccessToken,
  getGoogleTokenStatus,
  loadGmailToken,
  hasUsableGmailToken,
  listCalendarEvents,
  saveGmailToken,
  sendGmailMessage,
  tokenHasScope
} from "./providers/gmail.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicDir = join(rootDir, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Sent on every response. The dashboard shows meeting transcripts and drives account
// and Google-connection actions, so it must not be framable (clickjacking) and its
// URLs — which carry meeting ids and invite codes — must not leak to third parties.
//
// The CSP is the backstop for the escaping in public/app.js: script-src 'self' means a
// stored transcript that slipped through as markup still cannot execute. 'unsafe-inline'
// is present for styles only, because the calendar grid positions events with inline
// style attributes; it does not weaken the script protection.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join("; ")
};

const config = readConfig();
assertProviderSecrets(config);

const store = new JsonStore(config.storage.meetingsPath);
await store.load();

// Video never enters meetings.json. The store is loaded into memory and rewritten in full
// on every write, so the bytes live on disk under mediaDir and the meeting record carries
// only their sizes and status.
const mediaStore = new MediaStore({
  mediaDir: config.video.mediaDir,
  ffmpegPath: config.runner.ffmpegPath
});

const users = new UsersStore(config.storage.usersPath);
await users.load();
await users.pruneExpiredSessions();
await migrateLegacyGoogleTokens().catch((error) => {
  // A failed migration must not stop the server from booting; the legacy token file is
  // left untouched, so the next boot retries.
  console.error(`Google token migration failed: ${error.message}`);
});

const sessionTtlMs = config.auth.sessionTtlDays * 24 * 60 * 60 * 1000;
// Session renewals persist at most this often to avoid a store write per request.
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// In-memory limiters: single-process only; move to Redis before running replicas.
const loginIpLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
// Keyed by email alone, not by (ip, email): an attacker spraying one account from many
// addresses would otherwise get the full per-account budget from every address, which
// is no per-account limit at all.
//
// Only failed attempts are charged, so ordinary use — signing in from several devices,
// re-authenticating often — never spends the budget. The budget is still checked before
// the password is verified, because verifying costs a deliberate ~100ms of scrypt and
// answering that for every attempt is its own denial of service.
//
// The accepted trade-off: eight wrong guesses lock that one account out for the rest of
// the window, for its real owner too. It self-heals in 15 minutes, and the alternative —
// verifying first so the owner always gets in — hands an attacker unbounded scrypt work.
const loginAccountLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const signupIpLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const passwordResetLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
// An "all meetings" export serializes every stored artifact for one account into memory,
// so it is capped per account rather than left as a free amplification lever.
const exportLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
// Cutting a clip is an ffmpeg re-encode on the same box that runs transcription, and it
// writes a new file to the same disk. Both are bounded per account before the work starts.
const clipLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
// A composed send is an outbound email under the owner's own Google account. Bounded per
// account for the same reason exports are: the expensive, irreversible thing here is the
// mail, not the render.
const notesEmailLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
// A recording cannot have started longer ago than the longest meeting the bot will sit
// through, plus slack for the upload drain.
const MAX_CAPTURE_START_AGE_MS = (config.runner.maxDurationMinutes + 60) * 60 * 1000;
// Sized for playback rather than for API calls: one viewing of a clip is a burst of Range
// requests — a probe, the trailing moov read, then one per scrub — so a login-shaped limit
// here would break the video for a legitimate viewer while barely inconveniencing someone
// guessing tokens. It is charged before the token is looked at, so a miss costs a prober
// exactly what a hit costs a viewer.
const shareLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 1000, max: 240 });

// Declared up here, not with the video helpers below: the boot-time sweep runs before
// this module finishes evaluating, and a const declared further down is still in its
// temporal dead zone when it does.
let videoSweepRunning = false;
// Two callers can be inside a finalize at once — the worker retries one whose response it
// abandoned — and two remuxes of the same file would race to rename over each other. The
// second caller waits on the first one's answer instead of starting its own ffmpeg.
const videoFinalizations = new Map();

// The count limit above is not a concurrency limit: thirty accepted requests would start
// thirty libx264 re-encodes on the box that is also feeding Deepgram and renewing runner
// leases, which is the one thing this feature is not allowed to do — starve transcription.
// Anything past this is refused rather than queued; a request waiting behind four encodes
// has already lost, and holding it open costs a connection for nothing.
const MAX_CONCURRENT_CLIP_CUTS = 2;
let clipCutsInFlight = 0;

const GIB = 1024 * 1024 * 1024;
// Matches the worker's own batch ceiling. A larger body is a client that has stopped
// following the protocol, and buffering it would be megabytes of heap per connection.
const VIDEO_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CLIPS_PER_MEETING = 50;
// Neither header set may be the dashboard's SECURITY_HEADERS: that CSP is written for an
// HTML page, and a media response needs different things said about it.
const PRIVATE_MEDIA_HEADERS = { "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
// A public clip link is the only unauthenticated route that serves stored bytes: keep it
// out of search indexes, keep the token out of the next site's referrer log, and keep the
// video out of every shared cache between here and the viewer.
const PUBLIC_MEDIA_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store"
};

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessionSweeper = setInterval(() => {
  users.pruneExpiredSessions().catch((error) => console.error(error));
}, 60 * 60 * 1000);
sessionSweeper.unref?.();

// The store keeps every meeting in memory and rewrites the whole file on every
// mutation, so raw transcripts left in place forever eventually OOM the process.
// Heartbeats were never pruned by anything until the cap in appendEvent, so a store
// written before it still carries every beat ever emitted. Done here rather than in a
// script because the running server holds this file in memory and would write its
// uncapped copy back over any external edit.
const prunedHeartbeats = await store.pruneStoredHeartbeats().catch((error) => {
  console.error(error);
  return 0;
});
if (prunedHeartbeats > 0) console.log(`pruned ${prunedHeartbeats} stored heartbeat events`);

// Run once at boot (in case retention lapsed while the server was down) and then
// hourly, mirroring sessionSweeper above.
await store.pruneExpiredArtifacts(Date.now(), { isActiveStatus: isActiveJobStatus }).catch((error) => {
  console.error(error);
});
// Video is swept on the same schedule but through its own pass: it lives on disk rather
// than in the store, and it has a second reason to be deleted (the disk budget) that the
// transcript sweep knows nothing about.
await sweepVideoRetention(Date.now()).catch((error) => console.error(error));
const retentionSweeper = setInterval(() => {
  store.pruneExpiredArtifacts(Date.now(), { isActiveStatus: isActiveJobStatus }).catch((error) => console.error(error));
  sweepVideoRetention(Date.now()).catch((error) => console.error(error));
}, 60 * 60 * 1000);
retentionSweeper.unref?.();

const runningJobs = new Set();
// OAuth state -> { userId, expiresAt }: binds each Google callback to the signed-in
// user who started it, with a 10-minute validity window.
const gmailOAuthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const calendarRuntime = {
  syncing: false,
  lastSync: null,
  lastError: null,
  lastResult: null,
  timer: null
};

// A fault the client caused and can fix, carrying the status and code to answer with.
class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    // Nothing can be said once the status line is out; writing again throws a second,
    // more confusing error on top of the first.
    if (response.headersSent) {
      console.error(error);
      response.destroy();
      return;
    }
    // Answering before the request body has been fully read — which is the whole point
    // of the 413 — leaves unread bytes on the socket. Keeping it alive would feed those
    // bytes to the next request on the same connection, so the client sees the reset on
    // an unrelated later call. Close it instead: the response still arrives intact.
    if (!request.readableEnded) {
      response.setHeader("Connection", "close");
    }
    if (error instanceof HttpError) {
      // Client errors are expected traffic; they don't belong in the error log.
      return sendJson(response, error.statusCode, { error: error.code, message: error.message });
    }
    console.error(error);
    sendJson(response, 500, {
      error: "internal_error",
      message: "Something went wrong while handling the request."
    });
  }
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`OpenNotetaker running at http://${config.server.host}:${config.server.port}`);
});

if (config.google.calendar.enabled) {
  startCalendarScheduler();
}

if (config.bot.provider === "fleet") {
  startLeaseSweeper();
}

startActionItemsSweeper();

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return sendJson(response, 200, {
      ok: true,
      botProvider: config.bot.provider,
      llmProvider: config.llm.provider,
      sttProvider: config.stt.provider
    });
  }

  // Cross-site requests cannot read responses, and SameSite=Lax keeps the session
  // cookie off cross-site POSTs — this Origin check is defense in depth on top.
  if (!["GET", "HEAD"].includes(request.method) && !url.pathname.startsWith("/api/runner/") && !isSameOrigin(request)) {
    return sendJson(response, 403, { error: "cross_origin_rejected" });
  }

  if (url.pathname === "/api/auth/signup" && request.method === "POST") {
    if (!config.auth.allowSignups) {
      return sendJson(response, 403, { error: "signups_disabled", message: "Signups are disabled on this server." });
    }
    if (!signupIpLimiter.consume(clientIp(request)).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many signups from this address. Try later." });
    }

    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    if (!email) return sendJson(response, 400, { error: "invalid_email", message: "Use a valid email address." });
    const passwordCheck = validatePassword(body.password);
    if (!passwordCheck.ok) return sendJson(response, 400, { error: "invalid_password", message: passwordCheck.error });
    if (users.findUserByEmail(email)) {
      return sendJson(response, 409, { error: "email_taken", message: "An account with this email already exists." });
    }

    const user = await users.createUser({
      id: randomUUID(),
      email,
      name: validateName(body.name),
      passwordHash: await hashPassword(body.password)
    });
    await startSession(request, response, user);
    return sendJson(response, 201, { user: publicUser(user), features: featuresPayload() });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const ip = clientIp(request);
    if (!loginIpLimiter.consume(ip).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many login attempts. Try later." });
    }

    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    if (email && !loginAccountLimiter.check(email).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many login attempts for this account. Try later." });
    }

    const user = email ? users.findUserByEmail(email) : null;
    // Unknown emails still burn a full scrypt verification so response timing does
    // not reveal which addresses have accounts.
    const passwordHash = user?.passwordHash || (await DUMMY_PASSWORD_HASH_PROMISE);
    const valid = await verifyPassword(body.password || "", passwordHash);
    if (!user || !valid) {
      // Charged on failure only. Unknown emails are charged too, so probing for valid
      // addresses costs the same as guessing a password for a known one.
      if (email) loginAccountLimiter.consume(email);
      return sendJson(response, 401, { error: "invalid_credentials", message: "Invalid email or password." });
    }

    await users.updateUser(user.id, { lastLoginAt: new Date().toISOString(), lastLoginIp: ip });
    await startSession(request, response, user);
    return sendJson(response, 200, { user: publicUser(users.getUser(user.id)), features: featuresPayload() });
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) await users.deleteSessionByTokenHash(hashSessionToken(token));
    response.setHeader("Set-Cookie", buildClearSessionCookie({ secure: config.auth.secureCookies }));
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    // The flags ride along with every response that establishes a session. The dashboard
    // needs them before it can draw the create dialog, and a client that has to ask for
    // them afterwards spends its first paint drawing a dialog with no opt-out checkbox on
    // it — while the server records by default. Consent nobody was offered.
    return sendJson(response, 200, { user: publicUser(user), features: featuresPayload() });
  }

  // Operator-level switches the dashboard has to know before it can draw: without this the
  // client fails closed to "video is off", which hides the per-meeting opt-out checkbox
  // while the server happily records by default — consent the user was never offered.
  // Behind a session because it describes this install, not because any of it is secret.
  if (url.pathname === "/api/features" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, { features: featuresPayload() });
  }

  if (url.pathname === "/api/auth/settings" && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;

    const body = await readJsonBody(request);
    const settings = {};
    for (const key of ["transcriptRecipients", "actionItemRecipients"]) {
      if (!Array.isArray(body[key])) continue;
      const parsed = parseRecipientList(body[key]);
      if (!parsed.ok) return sendJson(response, 400, { error: "validation_error", message: parsed.error });
      settings[key] = parsed.value;
    }
    for (const key of [
      "autoEmailTranscript",
      "autoEmailActionItems",
      "emailConnectedAccounts",
      "actionItemsToConnectedAccounts",
      "calendarSyncEnabled",
      "calendarAutoStart"
    ]) {
      if (typeof body[key] === "boolean") settings[key] = body[key];
    }
    if (typeof body.name === "string") {
      await users.updateUser(user.id, { name: validateName(body.name) });
    }
    const updated = await users.updateUser(user.id, { settings });
    return sendJson(response, 200, { user: publicUser(updated) });
  }

  if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;

    const body = await readJsonBody(request);
    if (!(await verifyPassword(body.currentPassword || "", user.passwordHash))) {
      return sendJson(response, 401, { error: "invalid_credentials", message: "Current password is incorrect." });
    }
    const passwordCheck = validatePassword(body.newPassword);
    if (!passwordCheck.ok) return sendJson(response, 400, { error: "invalid_password", message: passwordCheck.error });

    await users.updateUser(user.id, { passwordHash: await hashPassword(body.newPassword), passwordReset: null });
    // A password change invalidates every session (a stolen one included), then
    // re-establishes only the session that made the change.
    await users.deleteUserSessions(user.id);
    await startSession(request, response, user);
    return sendJson(response, 200, { ok: true });
  }

  if (url.pathname === "/api/auth/forgot-password" && request.method === "POST") {
    if (!passwordResetLimiter.consume(clientIp(request)).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many reset requests. Try later." });
    }

    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    const user = email ? users.findUserByEmail(email) : null;
    // The response is identical whether or not the account exists.
    const genericReply = {
      ok: true,
      message:
        "If this account exists, a reset code was emailed via its connected Google account. " +
        "Without a Google connection, ask the operator to run scripts/reset-password.mjs."
    };
    if (!user) return sendJson(response, 200, genericReply);

    const resetToken = await issuePasswordReset(user);
    const delivered = await sendPasswordResetEmail(users.getUser(user.id), resetToken).catch((error) => {
      console.error(`password reset email failed for ${user.email}: ${error.message}`);
      return false;
    });
    if (!delivered) {
      // Never log the code itself; the operator path re-issues a fresh one.
      console.error(
        `password reset requested for ${user.email} but no Gmail connection could deliver it; ` +
          "run: node scripts/reset-password.mjs --email " + user.email
      );
    }
    return sendJson(response, 200, genericReply);
  }

  if (url.pathname === "/api/auth/reset-password" && request.method === "POST") {
    if (!passwordResetLimiter.consume(`reset:${clientIp(request)}`).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many reset attempts. Try later." });
    }

    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    const user = email ? users.findUserByEmail(email) : null;
    const failure = { error: "invalid_reset", message: "The reset code is invalid or has expired." };
    if (!user || !consumablePasswordReset(user, body.token)) {
      return sendJson(response, 400, failure);
    }
    const passwordCheck = validatePassword(body.newPassword);
    if (!passwordCheck.ok) return sendJson(response, 400, { error: "invalid_password", message: passwordCheck.error });

    await users.updateUser(user.id, {
      passwordHash: await hashPassword(body.newPassword),
      passwordReset: null
    });
    // Fail closed: whoever held the old password loses every session.
    await users.deleteUserSessions(user.id);
    return sendJson(response, 200, { ok: true, message: "Password updated. Sign in with the new password." });
  }

  // Operator fallback for accounts without a Google connection: issues a reset code
  // over the runner-token channel (used by scripts/reset-password.mjs, not the UI).
  if (url.pathname === "/api/runner/admin/password-reset" && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const body = await readJsonBody(request);
    const user = users.findUserByEmail(validateEmail(body.email));
    if (!user) return sendJson(response, 404, { error: "not_found" });
    const resetToken = await issuePasswordReset(user);
    return sendJson(response, 200, {
      email: user.email,
      resetToken,
      expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000
    });
  }

  if (url.pathname === "/api/admin/users" && request.method === "GET") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const rows = [];
    for (const member of users.listUsers()) {
      const memberAccounts = isGmailConfigured() ? listGoogleAccounts(member) : [];
      rows.push({
        ...publicUser(member),
        lastLoginAt: member.lastLoginAt,
        googleConnected: memberAccounts.length > 0,
        googleAccountCount: memberAccounts.length,
        meetingCount: store.listMeetings().filter((meeting) => meeting.ownerId === member.id).length,
        pendingInvite: Boolean(
          member.passwordReset?.tokenHash && Date.parse(member.passwordReset.expiresAt || "") > Date.now()
        )
      });
    }
    return sendJson(response, 200, { users: rows });
  }

  if (url.pathname === "/api/admin/users" && request.method === "POST") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    if (!email) return sendJson(response, 400, { error: "invalid_email", message: "Use a valid email address." });
    if (users.findUserByEmail(email)) {
      return sendJson(response, 409, { error: "email_taken", message: "An account with this email already exists." });
    }

    // Invited accounts start with an unusable random password; the invite code (the
    // same single-use reset mechanism, longer TTL) lets the teammate set their own.
    const invited = await users.createUser({
      id: randomUUID(),
      email,
      name: validateName(body.name),
      role: "member",
      passwordHash: await hashPassword(generateSessionToken())
    });
    const inviteCode = await issuePasswordReset(invited, INVITE_TTL_MS);
    return sendJson(response, 201, {
      user: publicUser(users.getUser(invited.id)),
      inviteCode,
      inviteUrl: buildInviteUrl(email, inviteCode),
      expiresInDays: INVITE_TTL_MS / 86_400_000
    });
  }

  const adminInviteMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/invite$/);
  if (adminInviteMatch && request.method === "POST") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const target = users.getUser(adminInviteMatch[1]);
    if (!target) return sendJson(response, 404, { error: "not_found" });
    const inviteCode = await issuePasswordReset(target, INVITE_TTL_MS);
    return sendJson(response, 200, {
      inviteCode,
      inviteUrl: buildInviteUrl(target.email, inviteCode),
      expiresInDays: INVITE_TTL_MS / 86_400_000
    });
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && request.method === "PATCH") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const target = users.getUser(adminUserMatch[1]);
    if (!target) return sendJson(response, 404, { error: "not_found" });
    if (target.id === admin.id) {
      return sendJson(response, 400, { error: "self_change", message: "You cannot change your own role." });
    }
    const body = await readJsonBody(request);
    if (!["admin", "member"].includes(body.role)) {
      return sendJson(response, 400, { error: "invalid_role", message: "Role must be admin or member." });
    }
    const updated = await users.updateUser(target.id, { role: body.role });
    return sendJson(response, 200, { user: publicUser(updated) });
  }

  if (adminUserMatch && request.method === "DELETE") {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const target = users.getUser(adminUserMatch[1]);
    if (!target) return sendJson(response, 404, { error: "not_found" });
    if (target.id === admin.id) {
      return sendJson(response, 400, { error: "self_delete", message: "You cannot remove your own account." });
    }
    await users.deleteUserSessions(target.id);
    // Their meetings stay, and so does every public clip link they minted. GET /s/:token
    // resolves through the clip alone and never asks whether the owner still exists, while
    // the revoke route is owner-scoped — so after this delete nobody, admin included,
    // could turn those links off short of hand-editing meetings.json.
    await revokeSharesOwnedBy(target.id);
    await users.removeUser(target.id);
    return sendJson(response, 200, { ok: true });
  }

  // ---- Connected Google accounts -------------------------------------------------
  if (url.pathname === "/api/google/accounts" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, await googleAccountsPayload(user));
  }

  const googleAccountMatch = url.pathname.match(/^\/api\/google\/accounts\/([^/]+)$/);
  if (googleAccountMatch && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;
    const account = findGoogleAccount(user, googleAccountMatch[1]);
    if (!account) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request);
    let accounts = updateGoogleAccount(listGoogleAccounts(user), account.id, body);
    if (body.isDefault === true) accounts = setDefaultGoogleAccount(accounts, account.id);
    const updated = await users.updateUser(user.id, { googleAccounts: accounts });
    return sendJson(response, 200, await googleAccountsPayload(updated));
  }

  if (googleAccountMatch && request.method === "DELETE") {
    const user = await requireUser(request, response);
    if (!user) return;
    const account = findGoogleAccount(user, googleAccountMatch[1]);
    if (!account) return sendJson(response, 404, { error: "not_found" });

    // Remove the credential first: if the record were cleared first and this failed, a
    // live refresh token would be left on disk with nothing pointing at it.
    await deleteGmailToken(userGoogleTokenPath(user.id, account.id));
    const updated = await users.updateUser(user.id, {
      googleAccounts: removeGoogleAccount(listGoogleAccounts(user), account.id)
    });
    return sendJson(response, 200, await googleAccountsPayload(updated));
  }

  if (url.pathname === "/api/gmail/status" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, await getGmailStatus(user));
  }

  if (url.pathname === "/api/calendar/status" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, await getCalendarStatus(user));
  }

  if (url.pathname === "/api/calendar/sync" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    try {
      const result = await runCalendarSync("manual", { onlyUserId: user.id });
      return sendJson(response, 200, result);
    } catch (error) {
      return sendJson(response, 400, {
        error: "calendar_sync_failed",
        message: error.message
      });
    }
  }

  if (url.pathname === "/api/gmail/oauth/start" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!isGmailConfigured()) {
      return sendJson(response, 400, {
        error: "gmail_not_configured",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting Gmail."
      });
    }

    const state = crypto.randomUUID();
    pruneOAuthStates();
    gmailOAuthStates.set(state, { kind: "connect", userId: user.id, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    response.writeHead(302, {
      Location: createGmailOAuthUrl({
        clientId: config.google.clientId,
        redirectUri: config.google.redirectUri,
        state
      })
    });
    response.end();
    return;
  }

  // Google sign-in: light identity scopes, reuses the registered redirect URI. Only
  // emails that already have an account may log in — invites stay the only door.
  if (url.pathname === "/api/auth/google/start" && request.method === "GET") {
    if (!isGmailConfigured()) {
      return sendJson(response, 400, { error: "google_not_configured", message: "Google OAuth is not configured." });
    }
    if (!loginIpLimiter.consume(clientIp(request)).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many attempts. Try later." });
    }
    const state = crypto.randomUUID();
    pruneOAuthStates();
    gmailOAuthStates.set(state, { kind: "login", expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    response.writeHead(302, {
      Location: createGmailOAuthUrl({
        clientId: config.google.clientId,
        redirectUri: config.google.redirectUri,
        state,
        scopes: ["openid", "email", "profile"]
      })
    });
    response.end();
    return;
  }

  if (url.pathname === "/api/gmail/oauth/callback" && request.method === "GET") {
    if (!isGmailConfigured()) {
      return sendJson(response, 400, { error: "gmail_not_configured" });
    }

    const state = url.searchParams.get("state") || "";
    const pending = gmailOAuthStates.get(state);
    gmailOAuthStates.delete(state);
    if (!pending || pending.expiresAt < Date.now() || (pending.kind === "connect" && !users.getUser(pending.userId))) {
      return sendJson(response, 400, {
        error: "invalid_oauth_state",
        message: "Google connection state did not match. Start the connection again."
      });
    }

    const code = url.searchParams.get("code") || "";
    if (!code) {
      return sendJson(response, 400, {
        error: "missing_oauth_code",
        message: "Google did not return an OAuth code."
      });
    }

    const token = await exchangeGmailCode({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: config.google.redirectUri,
      code
    });

    if (pending.kind === "login") {
      const info = await fetchGoogleUserinfo(token.access_token).catch(() => null);
      const email = validateEmail(info?.email);
      const account = email && info?.email_verified !== false ? users.findUserByEmail(email) : null;
      if (!account) {
        response.writeHead(302, { Location: "/?auth_error=no_account" });
        response.end();
        return;
      }
      await users.updateUser(account.id, { lastLoginAt: new Date().toISOString(), lastLoginIp: clientIp(request) });
      await startSession(request, response, account);
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }

    // Identify the account before storing anything. Without this a second connection is
    // indistinguishable from the first: we could not label it, could not tell a reconnect
    // from a new account, and would overwrite one grant with another.
    const info = await fetchGoogleUserinfo(token.access_token).catch(() => null);
    const connectedEmail = validateEmail(info?.email);
    if (!connectedEmail) {
      return sendHtml(
        response,
        400,
        "Google did not return which account was connected. Grant the email permission and try again."
      );
    }

    const owner = users.getUser(pending.userId);
    const existingAccounts = listGoogleAccounts(owner);
    const scopes = String(token.scope || "").split(/\s+/u).filter(Boolean);
    const known = matchGoogleAccount(existingAccounts, { googleSub: info?.sub, email: connectedEmail });
    const accountId = known?.id || randomUUID();

    let accounts;
    try {
      accounts = upsertGoogleAccount(existingAccounts, {
        id: accountId,
        email: connectedEmail,
        name: info?.name || "",
        googleSub: info?.sub || "",
        scopes
      });
    } catch (error) {
      return sendHtml(response, 400, error.message);
    }

    await saveGmailToken(userGoogleTokenPath(pending.userId, accountId), token);
    await users.updateUser(pending.userId, {
      googleAccounts: accounts.map((account) =>
        account.id === accountId
          ? {
              ...account,
              emailVerified: true,
              // Granting calendar scope is a clear intent to import this account's
              // meetings. Autostart — a bot joining unattended — stays opt-in.
              calendarSyncEnabled: known
                ? account.calendarSyncEnabled
                : scopes.includes(CALENDAR_READONLY_SCOPE)
            }
          : account
      )
    });

    return sendHtml(
      response,
      200,
      `${connectedEmail} is connected. You can close this tab and return to OpenNotetaker.`
    );
  }

  if (url.pathname === "/api/meetings" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      // Summaries only: the full transcript (rawSegments/normalizedSegments) is
      // what balloons this response once a meeting history builds up, and only
      // one meeting's transcript is ever shown at a time. The client fetches the
      // full meeting (GET /api/meetings/:id) when a card is opened.
      meetings: store
        .listMeetings()
        .filter((meeting) => meeting.ownerId === user.id)
        .map(summarizeMeeting)
    });
  }

  if (url.pathname === "/api/meetings" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const body = await readJsonBody(request);
    const validation = validateMeetingInput(body);
    if (!validation.ok) {
      return sendJson(response, 400, {
        error: "validation_error",
        fields: validation.errors
      });
    }

    const meeting = await store.createMeeting({ ...validation.value, ownerId: user.id });
    // validateMeetingInput drops unknown fields, so the opt-out is read off the raw body.
    return sendJson(response, 201, { meeting: publicMeeting(await applyVideoDefaults(meeting, body.recordVideo)) });
  }

  // POST rather than a GET download link: the selection payload is unbounded, and every
  // non-GET request already passes the same-origin check above, so this adds no CSRF surface.
  if (url.pathname === "/api/meetings/export" && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    if (!exportLimiter.consume(`export:${user.id}`).allowed) {
      return sendJson(response, 429, {
        error: "rate_limited",
        message: "Too many exports in a short window. Try again in a few minutes."
      });
    }

    const body = await readJsonBody(request);
    const parsed = parseExportRequest(body);
    if (!parsed.ok) {
      return sendJson(response, 400, { error: "validation_error", fields: parsed.errors });
    }

    // Ownership is applied inside selectExportMeetings before the requested ids are honoured,
    // so another tenant's id yields nothing instead of confirming that meeting exists.
    const meetings = selectExportMeetings(store.listMeetings(), user.id, parsed.value.meetingIds);
    if (!meetings.length) {
      return sendJson(response, 404, {
        error: "no_meetings",
        message: "No meetings matched this export."
      });
    }
    // The id-list cap lives in parseExportRequest; "all" has to be capped here too, or a
    // long-lived account turns one request into an unbounded in-memory serialization.
    if (meetings.length > MAX_EXPORT_MEETINGS) {
      return sendJson(response, 413, {
        error: "export_too_large",
        message: `Export at most ${MAX_EXPORT_MEETINGS} meetings at a time.`
      });
    }

    let bundle;
    try {
      bundle = buildExportBundle({
        meetings,
        sections: parsed.value.sections,
        format: parsed.value.format
      });
    } catch (error) {
      if (!(error instanceof ExportTooLargeError)) throw error;
      return sendJson(response, 413, { error: "export_too_large", message: error.message });
    }
    return sendDownload(response, bundle);
  }

  const meetingMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
  if (meetingMatch && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(meetingMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 200, { meeting: publicMeeting(meeting) });
  }

  // The opt-out for a meeting that never passed through the create dialog. A calendar
  // import records by default and had no checkbox to offer, so without this route the
  // owner of most meetings on an install with sync on has no way to answer the consent
  // question at all — and the artifact is video of participants' faces and shared screens.
  if (meetingMatch && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(meetingMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request);
    if (typeof body.recordVideo !== "boolean") {
      return sendJson(response, 400, {
        error: "validation_error",
        message: "recordVideo must be true or false."
      });
    }
    if (!config.video.enabled || !meeting.video) {
      return sendJson(response, 409, {
        error: "video_disabled",
        message: "Video recording is off on this install."
      });
    }
    // Only while nothing has happened yet. Once a bot is on its way the decision has
    // already been acted on, and turning it on mid-meeting would promise a recording of
    // the part nobody captured.
    if (meeting.status !== "scheduled") {
      return sendJson(response, 409, {
        error: "not_scheduled",
        message: "Recording can only be changed before the meeting starts."
      });
    }

    const updated = await patchVideo(meeting.id, {
      enabled: body.recordVideo,
      status: body.recordVideo ? "pending" : "skipped",
      error: null
    });
    await store.appendEvent(meeting.id, {
      type: body.recordVideo ? "video.enabled" : "video.disabled",
      message: `Video recording turned ${body.recordVideo ? "on" : "off"} by ${user.email}.`
    });
    return sendJson(response, 200, { meeting: publicMeeting(updated) });
  }

  const startMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/start$/);
  if (startMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(startMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    if (runningJobs.has(meeting.id) || isActiveJobStatus(meeting.status)) {
      return sendJson(response, 409, {
        error: "job_running",
        message: "This notetaker job is already running."
      });
    }

    // A meeting that failed *after* capturing a transcript (a finalization/notes error)
    // is recovered by re-running finalization on the stored segments. Re-recording would
    // only send a bot to an already-ended call and throw away the captured audio.
    const capturedSegments = meeting.artifacts?.rawSegments || [];
    if (meeting.status === "failed" && capturedSegments.length > 0) {
      refinalizeMeeting(meeting, capturedSegments);
      return sendJson(response, 202, {
        meeting: publicMeeting(store.getMeeting(meeting.id)),
        message: "Re-running notes from the captured transcript."
      });
    }

    startMeetingJob(meeting);

    return sendJson(response, 202, {
      meeting: publicMeeting(store.getMeeting(meeting.id)),
      message: "Notetaker job started."
    });
  }

  // Edit the extracted action items. They are LLM output, and the ones that are wrong
  // are exactly the ones you do not want mailed to other people.
  const actionItemsMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/action-items$/);
  if (actionItemsMatch && request.method === "PUT") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(actionItemsMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    if (!meeting.artifacts?.notes) {
      return sendJson(response, 409, {
        error: "notes_not_ready",
        message: "Action items can be edited once the notes are generated."
      });
    }

    const body = await readJsonBody(request);
    const parsed = parseActionItems(body.actionItems);
    if (!parsed.ok) return sendJson(response, 400, { error: "validation_error", message: parsed.error });

    const before = meeting.artifacts.notes.actionItems || [];
    if (!actionItemsChanged(before, parsed.value)) {
      return sendJson(response, 200, { meeting: publicMeeting(meeting), changed: false });
    }

    const updated = await store.updateMeeting(meeting.id, {
      artifacts: {
        notes: { ...meeting.artifacts.notes, actionItems: parsed.value, actionItemsEditedAt: new Date().toISOString() }
      }
    });
    await store.appendEvent(meeting.id, {
      type: "notes.action_items_edited",
      message: `Action items edited by ${user.email}: ${before.length} → ${parsed.value.length}.`
    });
    return sendJson(response, 200, { meeting: publicMeeting(store.getMeeting(meeting.id)), changed: true });
  }

  // Recipients and the hold/cancel switch for this meeting's action-item email.
  const actionItemsDeliveryMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/action-items\/delivery$/);
  if (actionItemsDeliveryMatch && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(actionItemsDeliveryMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request);
    const patch = {};
    if (body.recipients !== undefined) {
      const parsed = parseRecipientList(body.recipients);
      if (!parsed.ok) return sendJson(response, 400, { error: "validation_error", message: parsed.error });
      patch.recipients = parsed.value;
    }
    if (typeof body.autoSend === "boolean") {
      patch.autoSend = body.autoSend;
      // Turning auto-send off must actually cancel a pending send, not just record a
      // preference the sweeper then ignores.
      if (!body.autoSend && meeting.delivery?.actionItemsEmail?.status === "scheduled") {
        patch.status = "cancelled";
        patch.scheduledFor = null;
      }
    }
    if (!Object.keys(patch).length) {
      return sendJson(response, 400, { error: "validation_error", message: "Nothing to update." });
    }

    const updated = await updateActionItemsDelivery(meeting.id, patch);
    return sendJson(response, 200, { meeting: publicMeeting(updated) });
  }

  // Send now, ignoring any hold.
  const sendActionItemsMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/send-action-items$/);
  if (sendActionItemsMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(sendActionItemsMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request);
    let overrideRecipients;
    if (body.recipients !== undefined) {
      const parsed = parseRecipientList(body.recipients, { allowEmpty: false });
      if (!parsed.ok) return sendJson(response, 400, { error: "validation_error", message: parsed.error });
      overrideRecipients = parsed.value;
    }

    try {
      const delivery = await emailActionItems(meeting, { manual: true, overrideRecipients });
      return sendJson(response, 200, { meeting: publicMeeting(store.getMeeting(meeting.id)), delivery });
    } catch (error) {
      return sendJson(response, 400, { error: "email_failed", message: error.message });
    }
  }

  const emailTranscriptMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/email-transcript$/);
  if (emailTranscriptMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(emailTranscriptMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    if (meeting.status !== "completed") {
      return sendJson(response, 409, {
        error: "meeting_not_completed",
        message: "Transcript email can be sent after the meeting notes are completed."
      });
    }

    try {
      const delivery = await emailMeetingTranscript(meeting, { manual: true, force: true });
      return sendJson(response, 200, {
        meeting: publicMeeting(store.getMeeting(meeting.id)),
        delivery
      });
    } catch (error) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: error.message
      });
    }
  }

  const notesEmailMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/notes-email$/);
  if (notesEmailMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(notesEmailMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    if (meeting.status !== "completed") {
      return sendJson(response, 409, {
        error: "meeting_not_completed",
        message: "Notes can be sent once the meeting is finalized."
      });
    }

    const preview = url.searchParams.get("preview") === "1";
    const body = await readJsonBody(request);
    const accounts = listGoogleAccounts(user);
    const parsed = parseNotesEmailSelection(body, meeting, { ownerDomains: ownerDomainsFor(accounts, user) });
    if (!parsed.ok) {
      const status = parsed.code === "external_not_confirmed" ? 409 : 400;
      return sendJson(response, status, { error: parsed.code, message: parsed.error });
    }

    let rendered;
    try {
      rendered = renderNotesEmail({ meeting, selection: parsed.value });
    } catch (error) {
      // Over the ceiling is the caller asking for too much, not a server fault.
      if (error.code === "body_too_large") {
        return sendJson(response, 413, { error: "body_too_large", message: error.message });
      }
      throw error;
    }
    // Rendering is cheap and changes nothing; only the send is charged and limited.
    if (preview) return sendJson(response, 200, rendered);

    if (!notesEmailLimiter.consume(`notes-email:${user.id}`).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many sends in a short window." });
    }

    if (!isGmailConfigured()) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before sending notes email."
      });
    }
    const sender = pickSendingAccount(accounts, { preferAccountIds: meetingAccountIds(meeting) });
    if (!sender) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: "Connect a Google account with Gmail access before sending notes email."
      });
    }
    const tokenPath = userGoogleTokenPath(user.id, sender.id);
    if (!(await hasUsableGmailToken(tokenPath))) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: `Reconnect ${sender.email || "your Google account"} before sending notes email.`
      });
    }

    const providerMessageIds = [];
    const failedRecipients = [];
    for (const recipient of parsed.value.recipients) {
      const message = createMimeMessage({
        to: recipient,
        // Empty From: Gmail stamps the authenticated account, which is always correct.
        from: "",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html
      });
      try {
        const sent = await sendGmailMessage({ auth: getGoogleAuth(), tokenPath, message });
        providerMessageIds.push({ recipient, providerMessageId: sent?.id || "" });
      } catch (error) {
        failedRecipients.push({ recipient, error: error.message });
      }
    }

    // Nothing delivered: there is nothing to audit as "sent", so this is reported as a
    // failure rather than recorded on the meeting. The events log (below, on the success
    // path) is where a delivery attempt's outcome belongs; a wholly failed attempt has no
    // delivery to describe.
    if (!providerMessageIds.length) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: `Notes email failed for ${failedRecipients.map((entry) => entry.recipient).join(", ")}.`,
        failedRecipients
      });
    }

    // Partial success is still a send: the delivered copies cannot be unsent, and
    // failedRecipients records exactly who still needs one — the same call the
    // action-items sender already makes.
    const updated = await store.updateMeeting(meeting.id, {
      delivery: {
        ...(meeting.delivery || {}),
        notesEmail: {
          sentAt: new Date().toISOString(),
          recipients: parsed.value.recipients,
          subject: rendered.subject,
          sections: parsed.value.sections,
          turnsSent: parsed.value.transcript.includeIds.length,
          turnsEdited: Object.keys(parsed.value.transcript.edits).length,
          providerMessageIds,
          failedRecipients
        }
      }
    });
    await store.appendEvent(meeting.id, {
      type: "notes.email_sent",
      message:
        `Notes sent to ${parsed.value.recipients.join(", ")} ` +
        `(${Object.entries(parsed.value.sections).filter(([, on]) => on).map(([key]) => key).join(", ") || "no sections"}).`
    });
    return sendJson(response, 200, {
      meeting: publicMeeting(updated),
      delivery: updated.delivery.notesEmail
    });
  }

  // Video playback, clips and share links. Ownership is the same getOwnedMeeting check the
  // rest of the meeting routes use, so someone else's meeting id answers 404 here exactly
  // as it does there — a 403 would confirm the recording exists.
  const meetingVideoMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/video$/);
  if (meetingVideoMatch && ["GET", "HEAD"].includes(request.method)) {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(meetingVideoMatch[1], user);
    if (!meeting || meeting.video?.status !== "ready") return sendJson(response, 404, { error: "not_found" });
    return serveMediaFile(request, response, {
      resolvePath: () => mediaStore.recordingPath(meeting.id),
      extraHeaders: PRIVATE_MEDIA_HEADERS
    });
  }

  const clipsMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/clips$/);
  if (clipsMatch && request.method === "POST") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(clipsMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    if (meeting.video?.status !== "ready") {
      return sendJson(response, 409, {
        error: "video_not_ready",
        message: "Clips can be cut once the recording is ready."
      });
    }
    if (!clipLimiter.consume(`clips:${user.id}`).allowed) {
      return sendJson(response, 429, {
        error: "rate_limited",
        message: "Too many clips in a short window. Try again in a few minutes."
      });
    }
    const tooManyClips = {
      error: "too_many_clips",
      message: `A meeting holds at most ${MAX_CLIPS_PER_MEETING} clips. Delete one first.`
    };
    if ((meeting.clips || []).length >= MAX_CLIPS_PER_MEETING) {
      return sendJson(response, 409, tooManyClips);
    }

    const body = await readJsonBody(request);
    const range = validateClipRange({
      startMs: body.startMs,
      endMs: body.endMs,
      durationMs: meeting.video.durationMs,
      maxClipMs: config.video.maxClipSeconds * 1000
    });
    if (!range.ok) return sendJson(response, 400, { error: "validation_error", message: range.error });
    if ((await freeDiskBytes()) < config.video.minFreeDiskGb * GIB) {
      return sendJson(response, 503, {
        error: "low_disk",
        message: "Not enough free disk to cut a clip right now."
      });
    }

    // Checked immediately before the counter is taken, with nothing awaited in between:
    // that gap is the whole guard on a single-threaded server.
    if (clipCutsInFlight >= MAX_CONCURRENT_CLIP_CUTS) {
      return sendJson(response, 503, {
        error: "busy",
        message: "The server is already cutting clips. Try again in a moment."
      });
    }

    // Server-generated: MediaStore's path builders only accept a UUID, and a clip id from
    // a request body is a path segment somebody else chose.
    const clipId = randomUUID();
    let cut;
    clipCutsInFlight += 1;
    try {
      cut = await cutClip({
        ffmpegPath: config.runner.ffmpegPath,
        sourcePath: mediaStore.recordingPath(meeting.id),
        targetPath: mediaStore.clipPath(meeting.id, clipId),
        startMs: range.startMs,
        endMs: range.endMs
      });
    } catch (error) {
      // A clip that will not cut says nothing about the recording it was cut from, so
      // video.status is left exactly as it is.
      await mediaStore.deleteClip(meeting.id, clipId).catch(() => {});
      if (error.code === "clip_empty") {
        return sendJson(response, 400, { error: "clip_empty", message: error.message });
      }
      console.error(error.stderr ? `${error.message}\n${error.stderr}` : error);
      return sendJson(response, error.code === "clip_timeout" ? 504 : 500, {
        error: "clip_failed",
        message: "The clip could not be cut. Check the server logs."
      });
    } finally {
      clipCutsInFlight -= 1;
    }

    const clip = buildClipRecord({
      id: clipId,
      label: body.label,
      startMs: cut.startMs,
      endMs: cut.endMs,
      bytes: cut.bytes,
      createdBy: user.id,
      sourceActionItemId: body.sourceActionItemId
    });

    // Re-read: the cut took seconds of wall clock, and another clip or a retention purge
    // may have written this meeting while ffmpeg ran. Appending to the copy captured
    // before the cut would drop whatever landed in between.
    const current = store.getMeeting(meeting.id);
    if (!current || current.ownerId !== user.id || current.video?.status !== "ready") {
      await mediaStore.deleteClip(meeting.id, clipId).catch(() => {});
      return sendJson(response, 404, { error: "not_found" });
    }
    // The cap is re-checked here as well as before the cut, for the same reason the record
    // is re-read: the length the guard above saw is seconds old, and concurrent cuts all
    // pass a guard that none of them has written to yet.
    if ((current.clips || []).length >= MAX_CLIPS_PER_MEETING) {
      await mediaStore.deleteClip(meeting.id, clipId).catch(() => {});
      return sendJson(response, 409, tooManyClips);
    }
    await store.updateMeeting(meeting.id, { clips: [...(current.clips || []), clip] });
    await store.appendEvent(meeting.id, {
      type: "video.clip_created",
      message: `Clip cut by ${user.email}: ${formatClipRange(clip)} (${formatMb(clip.bytes)}).`
    });
    return sendJson(response, 201, {
      clip: publicClip(clip),
      meeting: publicMeeting(store.getMeeting(meeting.id))
    });
  }

  if (clipsMatch && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(clipsMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 200, { clips: (meeting.clips || []).map(publicClip) });
  }

  const clipMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/clips\/([^/]+)$/);
  if (clipMatch && ["GET", "HEAD"].includes(request.method)) {
    const owned = await requireOwnedClip(request, response, clipMatch);
    if (!owned) return;
    const { meeting, clip } = owned;
    return serveMediaFile(request, response, {
      resolvePath: () => mediaStore.clipPath(meeting.id, clip.id),
      extraHeaders: PRIVATE_MEDIA_HEADERS
    });
  }

  if (clipMatch && request.method === "DELETE") {
    const owned = await requireOwnedClip(request, response, clipMatch);
    if (!owned) return;
    const { user, meeting, clip } = owned;

    // File first, record second: a record with no file is a dead row the owner can delete
    // again, while a file with no record is bytes nobody can see, delete, or account for.
    const { bytesFreed } = await mediaStore.deleteClip(meeting.id, clip.id);
    const current = store.getMeeting(meeting.id);
    await store.updateMeeting(meeting.id, {
      clips: (current?.clips || []).filter((entry) => entry.id !== clip.id)
    });
    await store.appendEvent(meeting.id, {
      type: "video.clip_deleted",
      message: `Clip deleted by ${user.email} (${formatMb(bytesFreed)} freed).`
    });
    return sendJson(response, 200, { meeting: publicMeeting(store.getMeeting(meeting.id)), bytesFreed });
  }

  const clipShareMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)\/clips\/([^/]+)\/share$/);
  if (clipShareMatch && request.method === "POST") {
    const owned = await requireOwnedClip(request, response, clipShareMatch);
    if (!owned) return;
    const { user, meeting, clip } = owned;

    const body = await readJsonBody(request);
    const nowMs = Date.now();
    // The raw token exists here and nowhere else. It goes into this one response body and
    // is never written down — not in the record, not in the run-log event below, not in a
    // log line. A lost link is regenerated, not recovered.
    // Refused, not clamped, when the recording is inside its last day: shareExpiryDays
    // reads a maxDays of 0 as "no ceiling given" and would hand back the 90-day default,
    // so this check is what actually keeps a link from outliving its file.
    const maxDays = remainingVideoDays(meeting, nowMs);
    if (maxDays <= 0) {
      return sendJson(response, 409, {
        error: "video_expiring",
        message: "This recording is in its last day of retention; a link for it would stop working almost at once."
      });
    }

    const { token, tokenHash } = mintShareToken();
    const share = buildShareRecord({
      tokenHash,
      days: body.expiresInDays,
      defaultDays: config.video.shareDefaultDays,
      maxDays,
      nowMs
    });

    const current = store.getMeeting(meeting.id);
    if (!current) return sendJson(response, 404, { error: "not_found" });
    const replaced = shareActive(clip.share, nowMs);
    await store.updateMeeting(meeting.id, {
      clips: (current.clips || []).map((entry) => (entry.id === clip.id ? { ...entry, share } : entry))
    });
    await store.appendEvent(meeting.id, {
      type: "video.clip_shared",
      message:
        `${replaced ? "Replaced" : "Created"} the public link for a clip (${user.email}); ` +
        `it expires ${share.expiresAt}.`
    });
    return sendJson(response, 201, {
      url: publicShareUrl(config.runner.baseUrl, token),
      expiresAt: share.expiresAt,
      clip: publicClip({ ...clip, share })
    });
  }

  if (clipShareMatch && request.method === "DELETE") {
    const owned = await requireOwnedClip(request, response, clipShareMatch);
    if (!owned) return;
    const { user, meeting, clip } = owned;
    if (!clip.share || clip.share.revokedAt) return sendJson(response, 404, { error: "not_found" });

    const revokedAt = new Date().toISOString();
    const current = store.getMeeting(meeting.id);
    // The hash stays: the token it belongs to must keep resolving to a dead share so the
    // public route can answer its usual 404 instead of falling through to something else.
    await store.updateMeeting(meeting.id, {
      clips: (current?.clips || []).map((entry) =>
        entry.id === clip.id ? { ...entry, share: { ...entry.share, revokedAt } } : entry
      )
    });
    await store.appendEvent(meeting.id, {
      type: "video.clip_share_revoked",
      message: `Public link for a clip revoked by ${user.email}.`
    });
    return sendJson(response, 200, { meeting: publicMeeting(store.getMeeting(meeting.id)) });
  }

  if (url.pathname === "/api/runner/jobs/claim" && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const body = await readJsonBody(request);
    const claimable = pickClaimableMeeting(store.listMeetings(), Date.now());
    if (!claimable) return sendJson(response, 200, { meeting: null });

    const lease = buildLease(body.workerId, Date.now(), config.runner.leaseSeconds);
    const claimed = await store.updateMeeting(claimable.id, { runner: lease });
    await store.appendEvent(claimable.id, {
      type: "bot.job_claimed",
      message: `Recording worker ${lease.workerId} claimed this meeting.`
    });
    return sendJson(response, 200, {
      meeting: publicMeeting(await guardVideoDisk(claimed)),
      leaseSeconds: config.runner.leaseSeconds
    });
  }

  const runnerMeetingMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)$/);
  if (runnerMeetingMatch && request.method === "GET") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerMeetingMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 200, { meeting: publicMeeting(meeting) });
  }

  if (runnerMeetingMatch && request.method === "PATCH") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerMeetingMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request);
    const patch = {};
    // Runners may only move a meeting between capture states; pipeline states
    // (transcribing/normalizing/…/completed) are owned by the server.
    if (typeof body.status === "string") {
      if (!["queued", "recording", "failed"].includes(body.status)) {
        return sendJson(response, 400, {
          error: "invalid_status",
          message: "Runners may only set status to queued, recording, or failed."
        });
      }
      patch.status = body.status;
    }
    if (typeof body.statusMessage === "string") patch.statusMessage = body.statusMessage.slice(0, 500);
    if (body.artifacts && typeof body.artifacts === "object") patch.artifacts = body.artifacts;

    await renewRunnerLease(meeting);
    const updated = await store.updateMeeting(meeting.id, patch);
    return sendJson(response, 200, { meeting: publicMeeting(updated) });
  }

  const runnerEventsMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)\/events$/);
  if (runnerEventsMatch && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerEventsMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    await renewRunnerLease(meeting);
    const body = await readJsonBody(request);
    const updated = await store.appendEvent(meeting.id, {
      type: typeof body.type === "string" ? body.type.slice(0, 80) : "runner.event",
      message: typeof body.message === "string" ? body.message.slice(0, 500) : "Runner event."
    });
    return sendJson(response, 201, { meeting: publicMeeting(updated) });
  }

  const runnerSegmentsMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)\/segments$/);
  if (runnerSegmentsMatch && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerSegmentsMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    await renewRunnerLease(meeting);
    const body = await readJsonBody(request, { maxBytes: 10 * 1024 * 1024 });
    const sanitized = sanitizeRawSegments(body.segments);
    if (!sanitized.ok) {
      return sendJson(response, 400, {
        error: "validation_error",
        message: sanitized.error
      });
    }

    // Runners flush deltas during the meeting so a crash loses at most one batch;
    // merging by id keeps retries idempotent. Re-read the meeting instead of reusing the
    // copy captured above: several awaits have happened since, and two flushes racing on
    // a stale base would each write only their own batch, dropping the other's segments.
    const current = store.getMeeting(meeting.id);
    if (!current) return sendJson(response, 404, { error: "not_found" });
    const merged = mergeSegmentsById(current.artifacts?.rawSegments || [], sanitized.value);
    await store.updateMeeting(meeting.id, { artifacts: { rawSegments: merged.segments } });
    return sendJson(response, 202, {
      accepted: merged.added,
      total: merged.segments.length
    });
  }

  const rawTranscriptMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)\/raw-transcript$/);
  if (rawTranscriptMatch && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(rawTranscriptMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });

    const body = await readJsonBody(request, { maxBytes: 10 * 1024 * 1024 });
    const sanitized = sanitizeRawSegments(Array.isArray(body.rawSegments) ? body.rawSegments : []);
    if (!sanitized.ok) {
      return sendJson(response, 400, {
        error: "validation_error",
        message: sanitized.error
      });
    }

    // The final submission is merged with the segments flushed during the meeting, so
    // finalization works from whichever copy survived (incremental or final). Re-read for
    // the same reason as the segments endpoint: a flush may have landed while this body
    // was still being read.
    const latest = store.getMeeting(meeting.id);
    if (!latest) return sendJson(response, 404, { error: "not_found" });
    const merged = mergeSegmentsById(latest.artifacts?.rawSegments || [], sanitized.value);

    finalizeRawTranscript({ meeting, store, config, rawSegments: merged.segments })
      .then(async (completed) => {
        try {
          await emailMeetingTranscript(completed, { manual: false });
        } catch (error) {
          console.error(error);
        }
        await scheduleActionItemsFor(store.getMeeting(completed.id)).catch((error) => console.error(error));
        await propagateToFollowers(completed).catch((error) => console.error(error));
      })
      .catch(async (error) => {
        console.error(error);
        await store.updateMeeting(meeting.id, {
          status: "failed",
          statusMessage: "Transcript finalization failed. Check server logs."
        });
        await store.appendEvent(meeting.id, {
          type: "notes.failed",
          message: error.message
        });
        await propagateFailureToFollowers(meeting.id).catch(() => {});
      });

    return sendJson(response, 202, {
      message: "Raw transcript accepted for finalization.",
      segmentCount: merged.segments.length
    });
  }

  // Video bytes travel worker -> app over this route because the worker container has no
  // writable volume, exactly as transcript segments already do. Nothing here is allowed to
  // affect the meeting: every refusal is a status the worker reacts to by dropping video
  // and carrying on recording audio.
  const runnerVideoMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)\/video$/);
  if (runnerVideoMatch && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return rejectUnreadBody(request, response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerVideoMatch[1]);
    if (!meeting) return rejectUnreadBody(request, response, 404, { error: "not_found" });
    // The worker gates on meeting.video.enabled too; this is the server side of the same
    // decision, so a worker on an older image cannot record a meeting that opted out.
    if (!config.video.enabled || meeting.video?.enabled !== true) {
      return rejectUnreadBody(request, response, 409, {
        error: "video_disabled",
        message: "Video recording is off for this meeting."
      });
    }

    const rawOffset = url.searchParams.get("offset");
    // Number("") and Number(null) are both 0, so a missing offset would quietly read as
    // "append at the start of the file" instead of being refused.
    if (!/^\d+$/u.test(String(rawOffset ?? "")) || !Number.isSafeInteger(Number(rawOffset))) {
      return rejectUnreadBody(request, response, 400, {
        error: "invalid_offset",
        message: "offset must be a byte count."
      });
    }
    const offset = Number(rawOffset);

    // The ceiling is checked twice on purpose: once here, so a meeting that is already
    // over it does not spend a transfer it was always going to refuse, and once after the
    // body is read, which is the only point where this chunk's own length is known.
    const maxBytes = config.video.maxMb * 1024 * 1024;
    const overCapEvent = `Video stopped at the ${config.video.maxMb}MB per-meeting ceiling; audio and transcription are unaffected.`;
    const overCapBody = { error: "video_too_large", message: `This meeting's video is capped at ${config.video.maxMb}MB.` };
    const held = await mediaStore.currentPartSize(meeting.id);
    if (held >= maxBytes) {
      await noteVideoLimit(meeting, "size_limit", overCapEvent);
      return rejectUnreadBody(request, response, 413, overCapBody);
    }
    // Checked per chunk rather than once per meeting: chunks arrive minutes apart, and the
    // thing this guards against — a full disk stopping meetings.json from being written,
    // which takes transcription down with it — moves underneath us the whole time.
    const freeBytes = await freeDiskBytes();
    if (freeBytes < config.video.minFreeDiskGb * GIB) {
      await noteVideoLimit(
        meeting,
        "low_disk",
        `Video stopped with ${Math.round(freeBytes / GIB)}GB of disk left; the transcript still needs room to write.`
      );
      return rejectUnreadBody(request, response, 413, {
        error: "low_disk",
        message: "Not enough free disk to keep recording video."
      });
    }

    let chunk;
    try {
      chunk = await readRawBody(request, { maxBytes: VIDEO_CHUNK_MAX_BYTES });
    } catch (error) {
      if (error.code === "too_large") {
        return rejectUnreadBody(request, response, 413, { error: "chunk_too_large", message: error.message });
      }
      // The worker hung up mid-upload. Appending a truncated chunk would write bytes at an
      // offset they do not cover; it still holds them and will send them again.
      if (error.code === "client_aborted") {
        return rejectUnreadBody(request, response, 400, { error: "client_aborted", message: error.message });
      }
      throw error;
    }

    if (held + chunk.length > maxBytes) {
      await noteVideoLimit(meeting, "size_limit", overCapEvent);
      return sendJson(response, 413, overCapBody);
    }

    await renewRunnerLeaseIfStale(meeting);

    let result;
    try {
      result = await mediaStore.appendRecordingChunk(meeting.id, offset, chunk);
    } catch (error) {
      // A hole in the stream cannot be filled, so the worker is told where the file
      // actually ends and re-syncs there rather than writing a corrupt recording.
      if (error.code === "offset_gap") {
        return sendJson(response, 409, { error: "offset_gap", expected: error.expected });
      }
      if (error.code === "invalid_offset" || error.code === "invalid_id") {
        return sendJson(response, 400, { error: "invalid_offset", message: error.message });
      }
      // The append was undone, so this is retryable rather than fatal: the worker still
      // holds the bytes and the file is back where it was. The free-disk guard above stops
      // the capture for good if the volume really is out of room.
      if (error.code === "short_write") {
        console.error(error);
        return sendJson(response, 507, { error: "short_write", message: "The recording could not be written to disk." });
      }
      throw error;
    }

    // The record moves to "recording" once, on the first bytes that land. Everything else
    // about this upload — the running size, the resume cursor — stays out of a store that
    // is rewritten in full on every write.
    if (meeting.video.status !== "recording") {
      await patchVideo(meeting.id, {
        status: "recording",
        // The worker's capture-start time, not the moment its first bytes arrived here.
        // A short recording never fills an upload batch, so nothing is sent until the
        // drain at the end — stamping receipt time made a 42s recording claim it started
        // 45 seconds after it did. Validated rather than trusted: a runner is
        // authenticated, but a clock-skewed or malformed value would silently corrupt the
        // retention anchor, so anything not a sane past timestamp falls back to now.
        startedAt:
          meeting.video.startedAt ||
          sanitizeCaptureStart(url.searchParams.get("startedAt"), { maxAgeMs: MAX_CAPTURE_START_AGE_MS }),
        // Fresh bytes mean a fresh retention window, and patchVideo merges: a purgedAt
        // from a previous recording of this meeting would outlive it and exempt the new
        // one from every sweep.
        purgedAt: null,
        error: null
      });
    }
    // The total held, not the length of this chunk: that number IS the resume protocol.
    // The worker takes it as its next offset, which is what lets an upload survive a
    // restart on either end without any server-side sequence state.
    return sendJson(response, 200, { bytesReceived: result.bytes });
  }

  const runnerVideoFinalizeMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)\/video\/finalize$/);
  if (runnerVideoFinalizeMatch && request.method === "POST") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerVideoFinalizeMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    await renewRunnerLeaseIfStale(meeting);

    // Deliberately not gated on video.enabled: the worker calls this whenever it uploaded
    // any bytes at all, including after giving up mid-meeting, precisely so a .part is
    // never orphaned on the disk budget with no record pointing at it.
    const result = await finalizeMeetingVideo(meeting.id);
    if (!result.ok) return sendJson(response, result.statusCode, { error: result.code, message: result.message });
    return sendJson(response, 200, { video: result.video });
  }

  // Public clip playback: the only unauthenticated route that serves stored bytes, and
  // deliberately incurious. An unknown token, an expired share, a revoked one and a clip
  // whose file has been purged all get the same 404 — anything else tells whoever is
  // guessing which guess landed, which is the one thing a 32-byte token exists to deny.
  const shareMatch = url.pathname.match(/^\/s\/([^/]+)$/);
  if (shareMatch && ["GET", "HEAD"].includes(request.method)) {
    // Charged before the token is looked at, and keyed by the resolved client address
    // (TRUST_PROXY_HOPS) rather than by a header the caller writes.
    if (!shareLimiter.consume(`share:${clientIp(request)}`).allowed) {
      return sendJson(response, 429, {
        error: "rate_limited",
        message: "Too many requests for shared clips. Try again shortly."
      });
    }

    const found = findClipByTokenHash(store.listMeetings(), hashShareToken(shareMatch[1]));
    if (!found || !shareActive(found.clip.share, Date.now())) {
      return sendJson(response, 404, { error: "not_found" });
    }

    // Mutated in memory and left for the next store write to flush. A single viewing is a
    // burst of Range requests and every persist() rewrites the whole of meetings.json, so
    // counting each request would turn one shared clip into dozens of full-store rewrites.
    // The count is an engagement hint, not an audit log, and losing the last one to a
    // restart costs nothing.
    const counted = countShareView(found.clip.share, Date.now());
    if (counted) found.clip.share = counted;

    return serveMediaFile(request, response, {
      resolvePath: () => mediaStore.clipPath(found.meeting.id, found.clip.id),
      extraHeaders: PUBLIC_MEDIA_HEADERS
    });
  }

  if (request.method === "GET") {
    return serveStatic(url.pathname, response);
  }

  sendJson(response, 404, { error: "not_found" });
}

function startMeetingJob(meeting) {
  runningJobs.add(meeting.id);
  runNotetakerJob({ meeting, store, config })
    .then(async (updated) => {
      try {
        await emailMeetingTranscript(updated, { manual: false });
      } catch (error) {
        console.error(error);
      }
      await scheduleActionItemsFor(store.getMeeting(updated.id)).catch((error) => console.error(error));
      await propagateToFollowers(updated).catch((error) => console.error(error));
    })
    .catch(async (error) => {
      console.error(error);
      await store.updateMeeting(meeting.id, {
        status: "failed",
        statusMessage: "The notetaker job failed. Check server logs."
      });
      await store.appendEvent(meeting.id, {
        type: "job.failed",
        message: error.message
      });
      await propagateFailureToFollowers(meeting.id).catch(() => {});
    })
    .finally(() => runningJobs.delete(meeting.id));
}

// Re-run notes generation from an already-captured transcript (used when a meeting
// failed at finalization). The runningJobs guard prevents a double-click from starting
// two finalizations of the same segments.
function refinalizeMeeting(meeting, rawSegments) {
  runningJobs.add(meeting.id);
  finalizeRawTranscript({ meeting, store, config, rawSegments })
    .then(async (completed) => {
      try {
        await emailMeetingTranscript(completed, { manual: false });
      } catch (error) {
        console.error(error);
      }
      await scheduleActionItemsFor(store.getMeeting(completed.id)).catch((error) => console.error(error));
      await propagateToFollowers(completed).catch((error) => console.error(error));
    })
    .catch(async (error) => {
      console.error(error);
      await store.updateMeeting(meeting.id, {
        status: "failed",
        statusMessage: "Transcript finalization failed. Check server logs."
      });
      await store.appendEvent(meeting.id, {
        type: "notes.failed",
        message: error.message
      });
      await propagateFailureToFollowers(meeting.id).catch(() => {});
    })
    .finally(() => runningJobs.delete(meeting.id));
}

async function emailMeetingTranscript(meeting, { manual, force = false } = {}) {
  if (!meeting || meeting.status !== "completed") return { status: "skipped", reason: "meeting_not_completed" };
  // Delivery is owner-scoped: the owner's recipients, the owner's Google connection.
  const owner = meeting.ownerId ? users.getUser(meeting.ownerId) : null;
  if (!owner) return { status: "skipped", reason: "no_owner" };
  if (!manual && !owner.settings?.autoEmailTranscript) return { status: "skipped", reason: "disabled" };

  const accounts = listGoogleAccounts(owner);
  const recipients = transcriptRecipients({ owner, accounts });
  const existing = meeting.delivery?.transcriptEmail;
  if (deliverySentToAll(existing, recipients) && !force) {
    return { status: "skipped", reason: "already_sent", sentAt: existing.sentAt };
  }

  if (!recipients.length) {
    throw new Error("Add a transcript recipient in settings before sending.");
  }
  if (!isGmailConfigured()) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before sending transcript email.");
  }
  const sender = pickSendingAccount(accounts, { preferAccountIds: meetingAccountIds(meeting) });
  if (!sender) {
    throw new Error("Connect a Google account with Gmail access before sending transcript email.");
  }
  const tokenPath = userGoogleTokenPath(owner.id, sender.id);
  if (!(await hasUsableGmailToken(tokenPath))) {
    throw new Error(`Reconnect ${sender.email || "your Google account"} before sending transcript email.`);
  }

  const sentMessages = [];
  const failedMessages = [];
  try {
    for (const recipient of recipients) {
      const email = buildTranscriptEmail({
        meeting,
        recipient,
        // Empty From: Gmail stamps the authenticated account, which is always correct.
        from: ""
      });
      const message = createMimeMessage(email);
      try {
        const sent = await sendGmailMessage({
          auth: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret
          },
          tokenPath,
          message
        });
        sentMessages.push({
          recipient,
          providerMessageId: sent?.id || ""
        });
      } catch (error) {
        failedMessages.push({
          recipient,
          error: error.message
        });
      }
    }

    if (failedMessages.length) {
      throw new Error(`Transcript email failed for ${failedMessages.map((item) => item.recipient).join(", ")}.`);
    }

    await updateTranscriptEmailDelivery(meeting.id, {
      status: "sent",
      recipient: recipients.join(", "),
      recipients,
      sentFrom: sender.email,
      sentAt: new Date().toISOString(),
      providerMessageId: sentMessages[0]?.providerMessageId || "",
      providerMessageIds: sentMessages
    });
    await store.appendEvent(meeting.id, {
      type: "transcript.email_sent",
      message: `Transcript email sent to ${recipients.join(", ")}.`
    });
    return { status: "sent", providerMessageIds: sentMessages };
  } catch (error) {
    await updateTranscriptEmailDelivery(meeting.id, {
      status: "failed",
      recipient: recipients.join(", "),
      recipients,
      sentFrom: sender.email,
      failedAt: new Date().toISOString(),
      error: error.message,
      providerMessageIds: sentMessages,
      failedRecipients: failedMessages
    });
    await store.appendEvent(meeting.id, {
      type: "transcript.email_failed",
      message: error.message
    });
    throw error;
  }
}

/**
 * Mail the action items for a meeting.
 *
 * Recipients come from the curated list only — never from the calendar attendee list on
 * its own. Attendees are offered as suggestions in the UI; putting one on the list is a
 * decision a person makes, so that a meeting with a client on it cannot mail them
 * internal notes because nobody thought about it.
 */
async function emailActionItems(meeting, { manual = false, overrideRecipients } = {}) {
  if (!meeting || meeting.status !== "completed") {
    throw new Error("Action items can be sent once the meeting notes are completed.");
  }
  const owner = meeting.ownerId ? users.getUser(meeting.ownerId) : null;
  if (!owner) return { status: "skipped", reason: "no_owner" };

  const notes = meeting.artifacts?.notes;
  const items = notes?.actionItems || [];
  if (!items.length) {
    if (manual) throw new Error("This meeting has no action items to send.");
    return { status: "skipped", reason: "no_action_items" };
  }

  const accounts = listGoogleAccounts(owner);
  const recipients = overrideRecipients || actionItemRecipients({ owner, accounts, meeting });
  if (!recipients.length) {
    if (manual) throw new Error("Add at least one recipient before sending action items.");
    return { status: "skipped", reason: "no_recipients" };
  }
  if (!isGmailConfigured()) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before sending action items.");
  }

  const sender = pickSendingAccount(accounts, { preferAccountIds: meetingAccountIds(meeting) });
  if (!sender) throw new Error("Connect a Google account with Gmail access before sending action items.");
  const tokenPath = userGoogleTokenPath(owner.id, sender.id);

  const sent = [];
  const failed = [];
  for (const recipient of recipients) {
    const message = createMimeMessage(
      buildActionItemsEmail({
        meeting,
        recipient,
        // Empty From: Gmail stamps the authenticated account, which is always correct.
        from: "",
        editedByUser: Boolean(notes?.actionItemsEditedAt)
      })
    );
    try {
      const result = await sendGmailMessage({ auth: getGoogleAuth(), tokenPath, message });
      sent.push({ recipient, providerMessageId: result?.id || "" });
    } catch (error) {
      failed.push({ recipient, error: error.message });
    }
  }

  const deliveredAt = new Date().toISOString();
  if (!sent.length) {
    await updateActionItemsDelivery(meeting.id, {
      status: "failed",
      scheduledFor: null,
      failedAt: deliveredAt,
      error: failed[0]?.error || "Action item email failed.",
      failedRecipients: failed
    });
    await store.appendEvent(meeting.id, {
      type: "action_items.email_failed",
      message: failed[0]?.error || "Action item email failed."
    });
    throw new Error(failed[0]?.error || "Action item email failed.");
  }

  await updateActionItemsDelivery(meeting.id, {
    // Partial success is still "sent" — the delivered copies cannot be unsent, and the
    // failed list records exactly who still needs one.
    status: "sent",
    scheduledFor: null,
    sentAt: deliveredAt,
    sentFrom: sender.email,
    recipients,
    itemCount: items.length,
    providerMessageIds: sent,
    failedRecipients: failed
  });
  await store.appendEvent(meeting.id, {
    type: "action_items.email_sent",
    message: `${items.length} action item${items.length === 1 ? "" : "s"} sent to ${sent
      .map((entry) => entry.recipient)
      .join(", ")}${failed.length ? ` (failed for ${failed.map((entry) => entry.recipient).join(", ")})` : ""}.`
  });
  return { status: "sent", recipients: sent, failed };
}

async function updateActionItemsDelivery(meetingId, patch) {
  const current = store.getMeeting(meetingId);
  if (!current) return null;
  return store.updateMeeting(meetingId, {
    delivery: {
      ...(current.delivery || {}),
      actionItemsEmail: { ...(current.delivery?.actionItemsEmail || {}), ...patch }
    }
  });
}

/**
 * Queue the automatic action-item email once notes are ready.
 *
 * Held for a configurable window rather than sent instantly: the list is editable
 * precisely because some extracted items are wrong, and mail already delivered cannot be
 * corrected. A hold of 0 sends on the next sweep for anyone who prefers speed.
 */
async function scheduleActionItemsFor(meeting) {
  const owner = meeting?.ownerId ? users.getUser(meeting.ownerId) : null;
  if (!owner) return;
  const autoSend = owner.settings?.autoEmailActionItems === true;
  const scheduledFor = scheduleActionItemsEmail({
    meeting,
    autoSend,
    holdMinutes: config.email.actionItems.holdMinutes
  });
  if (!scheduledFor) return;

  const recipients = actionItemRecipients({ owner, accounts: listGoogleAccounts(owner), meeting });
  if (!recipients.length) return;

  await updateActionItemsDelivery(meeting.id, { status: "scheduled", scheduledFor, recipients });
  await store.appendEvent(meeting.id, {
    type: "action_items.scheduled",
    message: `Action items will be emailed to ${recipients.join(", ")} at ${scheduledFor}. Edit or cancel before then.`
  });
}

// Sends action-item emails whose hold has elapsed. Persisted on the meeting rather than
// held in a timer so a restart mid-hold still delivers.
function startActionItemsSweeper() {
  const timer = setInterval(async () => {
    for (const meeting of dueActionItemEmails(store.listMeetings())) {
      try {
        await emailActionItems(meeting);
      } catch (error) {
        console.error(`action item email failed for ${meeting.id}: ${error.message}`);
      }
    }
  }, 30_000);
  timer.unref?.();
}

async function updateTranscriptEmailDelivery(meetingId, patch) {
  const current = store.getMeeting(meetingId);
  if (!current) return null;
  return store.updateMeeting(meetingId, {
    delivery: {
      ...(current.delivery || {}),
      transcriptEmail: {
        ...(current.delivery?.transcriptEmail || {}),
        ...patch
      }
    }
  });
}

// Google account ids associated with a meeting, most specific first: the calendar
// connection that imported it knows which inbox the thread belongs in.
function meetingAccountIds(meeting) {
  const accounts = meeting?.source?.googleCalendar?.accounts;
  return Array.isArray(accounts) ? accounts.map((entry) => entry?.accountId).filter(Boolean) : [];
}

function deliverySentToAll(delivery, recipients) {
  if (delivery?.status !== "sent") return false;
  const sentRecipients = Array.isArray(delivery.recipients)
    ? delivery.recipients
    : [delivery.recipient].filter(Boolean);
  const normalizedSent = new Set(sentRecipients.map((recipient) => recipient.toLowerCase()));
  return recipients.every((recipient) => normalizedSent.has(recipient.toLowerCase()));
}

// Domains the owner is actually connected with. Anything else is external, which is what
// gates the confirmation — the same notion attendeeSuggestions already uses to mark an
// address as "not from your company".
function ownerDomainsFor(accounts, user) {
  const domains = accounts.map((account) => String(account.email || "").split("@")[1]).filter(Boolean);
  const own = String(user.email || "").split("@")[1];
  if (own) domains.push(own);
  return [...new Set(domains.map((d) => d.toLowerCase()))];
}

async function googleAccountsPayload(user) {
  const accounts = await resolveGoogleAccounts(user);
  return {
    configured: isGmailConfigured(),
    maxAccounts: MAX_GOOGLE_ACCOUNTS,
    schedulerEnabled: config.google.calendar.enabled,
    actionItemsHoldMinutes: config.email.actionItems.holdMinutes,
    accounts: accounts.map((account) => ({
      ...publicGoogleAccount(account),
      emailVerified: account.emailVerified !== false,
      // Surfaced per account rather than globally: with several connections, "Google
      // access expired" is only actionable if it says which one.
      needsReconnect: CALENDAR_NEEDS_RECONNECT_CODES.has(
        calendarRuntime.lastResult?.userErrors?.find(
          (entry) => entry.userId === user.id && entry.accountId === account.id
        )?.code
      )
    }))
  };
}

// Aggregate across every connected account. "Connected" now means at least one account
// can do the thing, and the per-account detail lives on /api/google/accounts.
async function getGmailStatus(user) {
  const configured = isGmailConfigured();
  const accounts = configured ? await resolveGoogleAccounts(user) : [];
  const recipients = transcriptRecipients({ owner: user, accounts });
  const senders = accounts.filter((account) => account.scopes.includes(GMAIL_SEND_SCOPE));
  return {
    configured,
    connected: senders.length > 0,
    googleConnected: accounts.length > 0,
    accountCount: accounts.length,
    sendingAccounts: senders.map((account) => account.email).filter(Boolean),
    automaticTranscriptEmail: Boolean(user.settings?.autoEmailTranscript),
    recipient: recipients.join(", "),
    recipients,
    redirectUri: config.google.redirectUri
  };
}

// Error codes from a calendar sync attempt that only a fresh OAuth grant can fix — as
// opposed to a transient network/API error, which shouldn't tell the user to reconnect.
const CALENDAR_NEEDS_RECONNECT_CODES = new Set(["invalid_grant", "no_refresh_token", "calendar_scope_missing"]);

async function getCalendarStatus(user) {
  const configured = isGmailConfigured();
  const accounts = configured ? await resolveGoogleAccounts(user) : [];
  // Recorded scope only reflects what was granted, not whether the refresh token Google
  // holds is still alive — that is only knowable once a real API call fails. The
  // scheduler makes that call every pollSeconds whether or not anyone has the dashboard
  // open, so its last result is what actually answers "is this still connected."
  const myErrors = (calendarRuntime.lastResult?.userErrors || []).filter((entry) => entry.userId === user.id);
  const reconnectErrors = myErrors.filter((entry) => CALENDAR_NEEDS_RECONNECT_CODES.has(entry.code));
  const syncing = calendarSyncAccounts(accounts);
  const broken = new Set(reconnectErrors.map((entry) => entry.accountId));
  const healthy = syncing.filter((account) => !broken.has(account.id));
  return {
    configured,
    connected: healthy.length > 0,
    googleConnected: accounts.length > 0,
    needsReconnect: reconnectErrors.length > 0,
    // Named, because with several accounts connected "reconnect Google" is not actionable.
    reconnectAccounts: reconnectErrors
      .map((entry) => accounts.find((account) => account.id === entry.accountId)?.email)
      .filter(Boolean),
    syncingAccounts: syncing.map((account) => account.email).filter(Boolean),
    lastSyncError: reconnectErrors[0]?.message || myErrors[0]?.message || null,
    enabled: syncing.length > 0 && config.google.calendar.enabled,
    schedulerEnabled: config.google.calendar.enabled,
    autoStart: Boolean(user.settings?.calendarAutoStart) && config.google.calendar.autoStart,
    calendarId: config.google.calendar.calendarId,
    pollSeconds: config.google.calendar.pollSeconds,
    lookaheadMinutes: config.google.calendar.lookaheadMinutes,
    autoStartLeadMinutes: config.google.calendar.autoStartLeadMinutes,
    autoStartLateMinutes: config.google.calendar.autoStartLateMinutes,
    lastSync: calendarRuntime.lastSync,
    lastError: calendarRuntime.lastError,
    lastResult: calendarRuntime.lastResult,
    redirectUri: config.google.redirectUri
  };
}

async function requireUser(request, response) {
  const auth = await getSessionUser(request);
  if (!auth) {
    sendJson(response, 401, { error: "unauthorized", message: "Sign in to continue." });
    return null;
  }
  return auth.user;
}

async function getSessionUser(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const session = users.getSessionByTokenHash(tokenHash);
  if (!session) return null;
  const user = users.getUser(session.userId);
  if (!user) return null;
  // Sliding expiry, persisted at most hourly to keep store writes off the hot path.
  const lastSeen = Date.parse(session.lastSeenAt || session.createdAt) || 0;
  if (Date.now() - lastSeen > SESSION_TOUCH_INTERVAL_MS) {
    await users.touchSession(tokenHash, sessionTtlMs);
  }
  return { user, session };
}

async function startSession(request, response, user) {
  const token = generateSessionToken();
  await users.createSession({
    tokenHash: hashSessionToken(token),
    userId: user.id,
    ttlMs: sessionTtlMs,
    ip: clientIp(request),
    userAgent: request.headers["user-agent"]
  });
  response.setHeader(
    "Set-Cookie",
    buildSessionCookie(token, {
      maxAgeSeconds: sessionTtlMs / 1000,
      secure: config.auth.secureCookies
    })
  );
}

async function issuePasswordReset(user, ttlMs = PASSWORD_RESET_TTL_MS) {
  const resetToken = generateSessionToken();
  await users.updateUser(user.id, {
    passwordReset: {
      tokenHash: hashSessionToken(resetToken),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    }
  });
  return resetToken;
}

async function requireAdmin(request, response) {
  const user = await requireUser(request, response);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(response, 403, { error: "forbidden", message: "Admin access required." });
    return null;
  }
  return user;
}

function buildInviteUrl(email, inviteCode) {
  const url = new URL(config.runner.baseUrl);
  url.searchParams.set("invite", inviteCode);
  url.searchParams.set("email", email);
  return url.toString();
}

function consumablePasswordReset(user, token) {
  const reset = user.passwordReset;
  if (!reset?.tokenHash || !token) return false;
  if (Date.parse(reset.expiresAt || "") <= Date.now()) return false;
  const expected = Buffer.from(reset.tokenHash, "hex");
  const received = Buffer.from(hashSessionToken(String(token)), "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

// There is no system mailer: reset codes travel through the account's own connected
// Gmail (send-to-self). Returns false when no usable connection exists.
async function sendPasswordResetEmail(user, resetToken) {
  if (!isGmailConfigured()) return false;
  const sender = pickSendingAccount(listGoogleAccounts(user));
  if (!sender) return false;
  const tokenPath = userGoogleTokenPath(user.id, sender.id);
  const tokenStatus = await getGoogleTokenStatus(tokenPath);
  if (!tokenStatus.gmailSend) return false;

  const message = createMimeMessage({
    to: user.email,
    from: "",
    subject: "OpenNotetaker password reset code",
    text: [
      "A password reset was requested for your OpenNotetaker account.",
      "",
      `Reset code: ${resetToken}`,
      "",
      `The code expires in ${PASSWORD_RESET_TTL_MS / 60_000} minutes and works once.`,
      "If you did not request this, you can ignore this email; your password is unchanged."
    ].join("\n")
  });
  await sendGmailMessage({ auth: getGoogleAuth(), tokenPath, message });
  return true;
}

function clientIp(request) {
  return resolveClientIp(request, config.server.trustProxyHops);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  // Non-browser clients (curl, runners, tests) send no Origin header.
  if (!origin) return true;
  try {
    return new URL(origin).host === String(request.headers.host || "");
  } catch {
    return false;
  }
}

function getOwnedMeeting(id, user) {
  const meeting = store.getMeeting(id);
  // 404 for both "missing" and "not yours": existence must not leak across tenants.
  if (!meeting || meeting.ownerId !== user.id) return null;
  return meeting;
}

// data/google-tokens/<userId>/<accountId>.json — one file per connected Google account.
// Both ids are stripped to a safe alphabet before they touch a path: they are internal
// UUIDs today, but a path built from a stored value is a traversal waiting to happen the
// first time something upstream changes.
function userGoogleTokenPath(userId, accountId) {
  return join(config.google.tokenDir, safePathSegment(userId), `${safePathSegment(accountId)}.json`);
}

// Where a single-account installation kept its token before multi-account support.
function legacyUserGoogleTokenPath(userId) {
  return join(config.google.tokenDir, `${safePathSegment(userId)}.json`);
}

function safePathSegment(value) {
  const safe = String(value).replace(/[^a-zA-Z0-9-]/gu, "");
  if (!safe) throw new Error("Refusing to build a token path from an empty identifier.");
  return safe;
}

/**
 * Move pre-multi-account connections into the per-account layout.
 *
 * Runs once at boot. The old file has no identity attached — it predates the identity
 * scopes — so the account is recorded with the address we do know (the user's own login)
 * and marked unverified; the next connect or status check fills in the real address from
 * Google. Doing nothing instead would silently disconnect every existing user.
 */
async function migrateLegacyGoogleTokens() {
  for (const user of users.listUsers()) {
    if (listGoogleAccounts(user).length) continue;

    const legacyPath = legacyUserGoogleTokenPath(user.id);
    const token = await loadGmailToken(legacyPath).catch(() => null);
    if (!token) continue;

    const accountId = randomUUID();
    await saveGmailToken(userGoogleTokenPath(user.id, accountId), token);
    await users.updateUser(user.id, {
      googleAccounts: upsertGoogleAccount([], {
        id: accountId,
        email: user.email,
        name: user.name || "",
        googleSub: "",
        scopes: String(token.scope || "").split(/\s+/u).filter(Boolean)
      }).map((account) => ({
        ...account,
        // The address is a guess until Google confirms it; the UI says so.
        emailVerified: false,
        // Carry the old per-user calendar switches onto the migrated connection so
        // sync behaviour does not change under anyone.
        calendarSyncEnabled: Boolean(user.settings?.calendarSyncEnabled),
        calendarAutoStart: Boolean(user.settings?.calendarAutoStart)
      }))
    });
    await deleteGmailToken(legacyPath).catch(() => {});
    console.log(`Migrated the Google connection for ${user.email} into the multi-account layout.`);
  }
}

/**
 * Fill in an account's real Google address, once, from the token we already hold.
 *
 * Migrated connections start with the user's login address as a placeholder. Rather than
 * make everyone reconnect, resolve it the first time the account is looked at and cache
 * the answer. Best-effort: a failure here must never block reading settings.
 */
async function ensureGoogleAccountIdentity(user, account) {
  if (account.emailVerified !== false) return account;
  try {
    const accessToken = await getGoogleAccessToken({
      auth: getGoogleAuth(),
      tokenPath: userGoogleTokenPath(user.id, account.id)
    });
    const info = await fetchGoogleUserinfo(accessToken);
    const email = validateEmail(info?.email);
    if (!email) return account;
    const updated = await users.updateUser(user.id, {
      googleAccounts: listGoogleAccounts(users.getUser(user.id)).map((entry) =>
        entry.id === account.id
          ? { ...entry, email, name: info.name || entry.name, googleSub: info.sub || "", emailVerified: true }
          : entry
      )
    });
    return findGoogleAccount(updated, account.id) || account;
  } catch {
    return account;
  }
}

/** Every connected account for a user, with migrated ones resolved on first read. */
async function resolveGoogleAccounts(user) {
  const accounts = listGoogleAccounts(user);
  if (!accounts.some((account) => account.emailVerified === false)) return accounts;
  const resolved = [];
  for (const account of accounts) {
    resolved.push(await ensureGoogleAccountIdentity(user, account));
  }
  return resolved;
}

function pruneOAuthStates() {
  const now = Date.now();
  for (const [state, pending] of gmailOAuthStates) {
    if (pending.expiresAt < now) gmailOAuthStates.delete(state);
  }
}

function isGmailConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret && config.google.redirectUri);
}

function startCalendarScheduler() {
  runCalendarSync("startup").catch((error) => {
    console.error(error);
  });
  calendarRuntime.timer = setInterval(() => {
    runCalendarSync("scheduled").catch((error) => {
      console.error(error);
    });
  }, config.google.calendar.pollSeconds * 1000);
  calendarRuntime.timer.unref?.();
}

async function runCalendarSync(reason, { onlyUserId = null } = {}) {
  if (calendarRuntime.syncing) {
    return {
      status: "skipped",
      reason: "sync_in_progress",
      lastResult: calendarRuntime.lastResult
    };
  }
  calendarRuntime.syncing = true;
  calendarRuntime.lastError = null;

  try {
    if (!isGmailConfigured()) {
      throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before syncing Google Calendar.");
    }

    // Manual sync targets the requesting user; the scheduler covers everyone. Which
    // calendars get polled is now per connected Google account, not per user, so one
    // person can watch a work calendar and a personal one and have both land here.
    const targets = onlyUserId ? [users.getUser(onlyUserId)].filter(Boolean) : users.listUsers();

    const now = Date.now();
    let checkedEvents = 0;
    let syncedAccounts = 0;
    const imported = [];
    const skipped = [];
    const userErrors = [];

    for (const user of targets) {
      const accounts = calendarSyncAccounts(await resolveGoogleAccounts(user));
      if (!accounts.length && onlyUserId) {
        throw new Error("Connect a Google account with Calendar access, then enable calendar sync for it.");
      }

      for (const account of accounts) {
        const tokenPath = userGoogleTokenPath(user.id, account.id);
        const tokenStatus = await getGoogleTokenStatus(tokenPath);
        if (!tokenStatus.calendarReadonly) {
          const message = `Reconnect ${account.email || "this Google account"} to grant Calendar read-only access.`;
          if (onlyUserId) throw new Error(message);
          userErrors.push({ userId: user.id, accountId: account.id, code: "calendar_scope_missing", message });
          continue;
        }

        try {
          const events = await listCalendarEvents({
            auth: getGoogleAuth(),
            tokenPath,
            calendarId: account.calendarId || config.google.calendar.calendarId,
            timeMin: new Date(now - config.google.calendar.autoStartLateMinutes * 60_000).toISOString(),
            timeMax: new Date(now + config.google.calendar.lookaheadMinutes * 60_000).toISOString(),
            maxResults: 50
          });
          syncedAccounts += 1;
          checkedEvents += events.length;
          for (const event of events) {
            const result = await upsertCalendarEventMeeting(event, user, account);
            if (result?.meeting) imported.push(result);
            else if (result?.reason) skipped.push(result.reason);
          }
        } catch (error) {
          // One broken connection must not stop the others from syncing — that is the
          // whole point of holding several.
          if (onlyUserId && accounts.length === 1) throw error;
          userErrors.push({
            userId: user.id,
            accountId: account.id,
            code: error.code || null,
            message: `${account.email || "Google account"}: ${error.message}`
          });
        }
      }
    }

    const started = await startDueCalendarMeetings();
    const result = {
      status: "synced",
      reason,
      syncedUsers: targets.length,
      syncedAccounts,
      checkedEvents,
      importedCount: imported.filter((item) => item.created).length,
      updatedCount: imported.filter((item) => !item.created).length,
      skippedCount: skipped.length,
      startedCount: started.length,
      startedMeetingIds: started.map((meeting) => meeting.id),
      userErrors,
      syncedAt: new Date().toISOString()
    };
    calendarRuntime.lastSync = result.syncedAt;
    calendarRuntime.lastResult = result;
    return result;
  } catch (error) {
    calendarRuntime.lastError = {
      message: error.message,
      at: new Date().toISOString()
    };
    throw error;
  } finally {
    calendarRuntime.syncing = false;
  }
}

async function upsertCalendarEventMeeting(event, owner, account) {
  if (!event || event.status === "cancelled") return { reason: "cancelled" };

  const meetUrl = extractGoogleMeetUrl(event);
  if (!meetUrl || !isGoogleMeetUrl(meetUrl)) return { reason: "no_meet_url" };

  const scheduledAt = event.start?.dateTime || "";
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return { reason: "all_day_or_invalid_start" };

  const source = createCalendarSource(event, account);
  const existing = findCalendarMeeting(event, meetUrl, scheduledAt, owner.id);
  if (existing) {
    const patch = {
      source: mergeCalendarSource(existing, source)
    };
    if (existing.status === "scheduled") {
      patch.title = truncateTitle(event.summary || existing.title);
      patch.meetUrl = meetUrl;
      patch.scheduledAt = scheduledAt;
    }
    const updated = await store.updateMeeting(existing.id, patch);
    return { meeting: updated, created: false };
  }

  const meeting = await store.createMeeting({
    ownerId: owner.id,
    title: truncateTitle(event.summary || "Calendar meeting"),
    meetUrl,
    scheduledAt,
    consentMode: "host_confirmed",
    retentionDays: config.google.calendar.retentionDays,
    source
  });
  await applyVideoDefaults(meeting);
  await store.appendEvent(meeting.id, {
    type: "calendar.imported",
    message: "Meeting job created from Google Calendar."
  });
  return { meeting: store.getMeeting(meeting.id), created: true };
}

async function startDueCalendarMeetings() {
  if (!config.google.calendar.autoStart) return [];

  const now = Date.now();
  const leadMs = config.google.calendar.autoStartLeadMinutes * 60_000;
  const lateMs = config.google.calendar.autoStartLateMinutes * 60_000;
  const started = [];

  for (const meeting of store.listMeetings()) {
    if (meeting.source?.provider !== "google_calendar") continue;
    if (meeting.status !== "scheduled") continue;
    if (runningJobs.has(meeting.id) || isActiveJobStatus(meeting.status)) continue;

    // Autostart is opt-in per connected account on top of the global operator switch:
    // a work calendar can join automatically while a personal one never does.
    const owner = meeting.ownerId ? users.getUser(meeting.ownerId) : null;
    if (!owner) continue;
    const importingAccounts = new Set(meetingAccountIds(meeting));
    const autoStartAllowed = listGoogleAccounts(owner).some(
      (account) => importingAccounts.has(account.id) && account.calendarAutoStart
    );
    if (!autoStartAllowed) continue;

    const scheduled = Date.parse(meeting.scheduledAt);
    if (Number.isNaN(scheduled)) continue;
    if (scheduled > now + leadMs || scheduled < now - lateMs) continue;

    await store.appendEvent(meeting.id, {
      type: "calendar.autostart",
      message: "Bot started automatically from Google Calendar."
    });
    startMeetingJob(store.getMeeting(meeting.id));
    started.push(store.getMeeting(meeting.id));
  }

  return started;
}

function findCalendarMeeting(event, meetUrl, scheduledAt, ownerId) {
  const eventId = event.id || "";
  const iCalUID = event.iCalUID || "";
  const scheduledTime = Date.parse(scheduledAt);

  // Dedupe is per owner: two users who attend the same event each get their own job.
  return store.listMeetings().filter((meeting) => meeting.ownerId === ownerId).find((meeting) => {
    const source = meeting.source?.googleCalendar || {};
    if (eventId && source.eventId === eventId) return true;
    if (iCalUID && source.iCalUID === iCalUID && source.originalStartTime === event.originalStartTime?.dateTime) return true;
    if (meeting.status !== "completed" && meeting.meetUrl === meetUrl) {
      const meetingTime = Date.parse(meeting.scheduledAt);
      return Number.isFinite(meetingTime) && Math.abs(meetingTime - scheduledTime) <= 10 * 60_000;
    }
    return false;
  }) || null;
}

function createCalendarSource(event, account) {
  return {
    provider: "google_calendar",
    googleCalendar: {
      calendarId: account?.calendarId || config.google.calendar.calendarId,
      eventId: event.id || "",
      iCalUID: event.iCalUID || "",
      htmlLink: event.htmlLink || "",
      status: event.status || "",
      organizerEmail: event.organizer?.email || "",
      creatorEmail: event.creator?.email || "",
      originalStartTime: event.originalStartTime?.dateTime || event.originalStartTime?.date || "",
      eventUpdatedAt: event.updated || "",
      lastSyncedAt: new Date().toISOString(),
      // Which connected account saw this event. A list, because the same event can be on
      // several connected calendars — the notes should still be one meeting, but any of
      // those inboxes is a legitimate place to send from.
      accounts: account ? [{ accountId: account.id, email: account.email }] : [],
      // Stored so the UI can offer "everyone on the invite" as recipients. Never mailed
      // without an explicit choice — see src/domain/note-delivery.js.
      attendees: sanitizeAttendees(event.attendees)
    }
  };
}

// Attendee lists come from Google, but they are still external input landing in our
// store and later rendered — cap the count and the field lengths.
function sanitizeAttendees(value) {
  if (!Array.isArray(value)) return [];
  const attendees = [];
  const seen = new Set();
  for (const attendee of value.slice(0, 100)) {
    const email = validateEmail(attendee?.email);
    // Meeting rooms and other resources are attendees too, and nobody wants to mail a
    // conference room.
    if (!email || seen.has(email) || attendee?.resource === true) continue;
    seen.add(email);
    attendees.push({
      email,
      name: String(attendee?.displayName || "").trim().slice(0, 120),
      responseStatus: String(attendee?.responseStatus || "").slice(0, 20),
      organizer: Boolean(attendee?.organizer),
      self: Boolean(attendee?.self)
    });
  }
  return attendees;
}

function mergeCalendarSource(meeting, source) {
  const existing = meeting.source?.googleCalendar || {};
  return {
    ...(meeting.source || {}),
    provider: "google_calendar",
    googleCalendar: {
      ...existing,
      ...source.googleCalendar,
      // Union rather than overwrite: a second connected account seeing the same event
      // should be added to the list, not replace the account that imported it first.
      accounts: mergeCalendarAccounts(existing.accounts, source.googleCalendar.accounts)
    }
  };
}

function mergeCalendarAccounts(existing, incoming) {
  const byId = new Map();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    if (entry?.accountId) byId.set(entry.accountId, entry);
  }
  return [...byId.values()];
}

function getGoogleAuth() {
  return {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret
  };
}

function truncateTitle(value) {
  const title = String(value || "").trim();
  return (title || "Calendar meeting").slice(0, 120);
}

async function serveStatic(pathname, response) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(publicDir, `.${safePath}`);
  // Compare against publicDir + separator: a bare startsWith would also accept a
  // sibling directory whose name merely begins with it (…/public-backup).
  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    return sendJson(response, 403, { error: "forbidden" });
  }

  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS
    });
    response.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      // SPA fallback: unknown paths render the app shell, which routes client-side.
      const index = await readFile(join(publicDir, "index.html"));
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[".html"],
        "Cache-Control": "no-store",
        ...SECURITY_HEADERS
      });
      response.end(index);
      return;
    }
    throw error;
  }
}

// A client sending junk is a client error, not a server error. Thrown as HttpError so
// the top-level handler answers 400/413 instead of logging a stack trace and returning
// "Something went wrong" — which reads as an outage and buries real 500s in the noise.
async function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, "payload_too_large", `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
  // Every caller reads named fields off this value; a bare array, string, or null would
  // otherwise sail through validation as an object with all-undefined fields.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed;
}

async function renewRunnerLease(meeting) {
  if (!meeting?.runner) return;
  await store.updateMeeting(meeting.id, {
    runner: renewLease(meeting.runner, Date.now(), config.runner.leaseSeconds)
  });
}

function startLeaseSweeper() {
  const sweepMs = Math.max(10_000, (config.runner.leaseSeconds * 1000) / 2);
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const meeting of store.listMeetings()) {
      try {
        if (shouldReleaseClaim(meeting, now)) {
          await store.updateMeeting(meeting.id, {
            runner: null,
            statusMessage: "Recording worker went silent before starting; waiting for another worker."
          });
          await store.appendEvent(meeting.id, {
            type: "bot.claim_released",
            message: `Worker ${meeting.runner.workerId} lost its lease before recording started; job re-queued.`
          });
        } else if (shouldSalvageRecording(meeting, now)) {
          const rawSegments = meeting.artifacts?.rawSegments || [];
          await store.appendEvent(meeting.id, {
            type: "bot.worker_lost",
            message: `Worker ${meeting.runner.workerId} lost its lease mid-recording with ${rawSegments.length} segments flushed.`
          });
          if (rawSegments.length) {
            // The audio cannot be resumed, but the flushed segments still become notes.
            await store.updateMeeting(meeting.id, { runner: null });
            finalizeRawTranscript({ meeting, store, config, rawSegments })
              .then(async (completed) => {
                await emailMeetingTranscript(completed, { manual: false }).catch((error) => console.error(error));
                await scheduleActionItemsFor(store.getMeeting(completed.id)).catch((error) => console.error(error));
                await propagateToFollowers(completed).catch((error) => console.error(error));
              })
              .catch(async (error) => {
                console.error(error);
                await store.updateMeeting(meeting.id, {
                  status: "failed",
                  statusMessage: "Salvaging the partial transcript failed. Check server logs."
                });
                await propagateFailureToFollowers(meeting.id).catch(() => {});
              });
          } else {
            await store.updateMeeting(meeting.id, {
              status: "failed",
              runner: null,
              statusMessage: "The recording worker disappeared before any transcript was captured."
            });
            await propagateFailureToFollowers(meeting.id).catch(() => {});
          }
          // The worker also owned the only call that turns its uploaded .part into a
          // recording, and it is gone. Left alone those bytes are unplayable, unpurgeable
          // until the retention window runs out, and counted against the disk budget the
          // whole time. Not awaited: a remux must not hold up the salvage of the next
          // meeting in this loop, and finalizeMeetingVideo never throws or double-runs.
          void finalizeMeetingVideo(meeting.id).catch((error) => console.error(error));
        }
      } catch (error) {
        console.error(error);
      }
    }
  }, sweepMs);
  timer.unref?.();
}

function mergeSegmentsById(existing, incoming) {
  const byId = new Map();
  for (const segment of existing) {
    if (segment?.id) byId.set(segment.id, segment);
  }
  let added = 0;
  for (const segment of incoming) {
    if (!segment?.id) continue;
    if (!byId.has(segment.id)) added += 1;
    // Prefer the incoming copy: the runner's final submission carries speaker hints
    // attached after the incremental flush.
    byId.set(segment.id, segment);
  }
  const segments = [...byId.values()].sort(
    (a, b) => Number(a.start || 0) - Number(b.start || 0) || Number(a.sequence || 0) - Number(b.sequence || 0)
  );
  return { segments, added };
}

function isRunnerAuthorized(request) {
  if (!config.runner.token) return false;
  const expected = Buffer.from(`Bearer ${config.runner.token}`);
  const received = Buffer.from(String(request.headers.authorization || ""));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function isActiveJobStatus(status) {
  return ["queued", "recording", "transcribing", "normalizing", "reconstructing", "following"].includes(status);
}

// List-view payload for GET /api/meetings: keeps everything the sidebar and
// action-item counts need, drops the transcript arrays that dominate response
// size. The client (hasFullArtifacts in app.js) treats their absence as "fetch
// GET /api/meetings/:id for the full transcript" and fills it in on selection.
// The list payload. `events` is dropped deliberately: the run log is rendered only by the
// detail view, which fetches the full meeting separately (see ensureMeetingDetail), while
// the list re-fetched every 1.8s carried every event ever recorded. On this instance that
// was 6.2MB of a 7.1MB response, 5.8MB of it bot.heartbeat lines the list cannot display.
// Send the count so the UI can still say a run log exists without shipping it.
function summarizeMeeting(meeting) {
  const { artifacts, events, ...rest } = publicMeeting(meeting);
  return {
    ...rest,
    eventCount: events?.length ?? 0,
    artifacts: {
      notes: artifacts?.notes ?? null,
      reconstructedTranscript: null,
      rawSegmentCount: artifacts?.rawSegments?.length ?? 0,
      normalizedSegmentCount: artifacts?.normalizedSegments?.length ?? 0
    }
  };
}

/* ---------- Video: serialization, capture, clips, retention ---------- */

// The one place a meeting becomes a response. Everything the client sees goes through here
// so a clip's share.tokenHash cannot ride along. It is the stored form of a credential, it
// buys a reader nothing they are entitled to, and the only thing between it and a live
// video link is that GET /s/ hashes what it is handed. Publishing it makes that one detail
// load-bearing for everyone who ever touches the share route.
// Operator-level switches, in one place because they are sent from four routes: the
// dedicated /api/features and every response that establishes a session.
function featuresPayload() {
  return {
    video: {
      enabled: config.video.enabled,
      recordByDefault: config.video.recordByDefault,
      retentionDays: config.video.retentionDays,
      maxClipSeconds: config.video.maxClipSeconds,
      shareDefaultDays: config.video.shareDefaultDays
    }
  };
}

function publicMeeting(meeting) {
  if (!meeting) return meeting;
  return { ...meeting, clips: (meeting.clips || []).map(publicClip) };
}

// Field by field rather than spread-minus-delete, for the same reason buildMeetingJson in
// domain/export.js is: a field added to the stored share tomorrow should have to be listed
// here before it is published, not leak on the day it is written.
function publicClip(clip) {
  const share = clip?.share;
  return {
    ...clip,
    share: share
      ? {
          active: shareActive(share, Date.now()),
          createdAt: share.createdAt ?? null,
          expiresAt: share.expiresAt ?? null,
          revokedAt: share.revokedAt ?? null,
          views: share.views ?? 0,
          lastViewedAt: share.lastViewedAt ?? null
        }
      : null
  };
}

function findClip(meeting, clipId) {
  return (meeting?.clips || []).find((clip) => clip?.id === clipId) || null;
}

// The one place "this clip is mine" is decided, so a clip route added later cannot check
// the meeting and forget the clip. Answers the 401/404 itself and returns null, the same
// shape requireUser uses — and the 404 is deliberately identical for a clip that is not
// yours and one that does not exist.
async function requireOwnedClip(request, response, match) {
  const user = await requireUser(request, response);
  if (!user) return null;
  const meeting = getOwnedMeeting(match[1], user);
  const clip = meeting ? findClip(meeting, match[2]) : null;
  if (!clip) {
    sendJson(response, 404, { error: "not_found" });
    return null;
  }
  return { user, meeting, clip };
}

// Recording is decided once, when the meeting record is created, because it is a consent
// decision about this meeting and not a setting that can be re-read later: a record that
// predates the feature carries no such decision, which is exactly why the worker refuses
// to record unless video.enabled === true.
async function applyVideoDefaults(meeting, requested) {
  if (!config.video.enabled || !meeting) return meeting;
  const enabled = typeof requested === "boolean" ? requested : config.video.recordByDefault;
  return store.updateMeeting(meeting.id, {
    video: {
      enabled,
      // "skipped", not "pending": a meeting that opted out must not look like one whose
      // recording is still on its way.
      status: enabled ? "pending" : "skipped",
      bytes: 0,
      durationMs: 0,
      width: 0,
      height: 0,
      startedAt: null,
      endedAt: null,
      capturedAt: null,
      purgedAt: null,
      error: null
    },
    clips: []
  });
}

// updateMeeting merges artifacts and replaces every other key wholesale, so a video patch
// has to be composed against the current record. Re-read rather than trusting the caller's
// copy: uploads, the pipeline and the sweeper all write the same meeting.
async function patchVideo(meetingId, changes) {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return null;
  return store.updateMeeting(meetingId, { video: { ...(meeting.video || {}), ...changes } });
}

// A worker that keeps pushing past a limit would otherwise rewrite the whole store on
// every refused chunk and fill the run log with the same line. The reason is recorded once.
// Both ceilings — the per-meeting size cap and the free-disk floor — surface as the same
// event: the worker reacts to every 413 identically, and the message says which one it hit.
async function noteVideoLimit(meeting, code, message) {
  if (meeting.video?.error === code) return;
  await patchVideo(meeting.id, { error: code });
  await store.appendEvent(meeting.id, { type: "video.size_limit", message });
}

// Every runner call renews the claim, but video chunks arrive far more often than segment
// flushes and each renewal rewrites meetings.json in full. The lease is re-stamped once it
// is past halfway, which is still well before a sweeper would call the worker lost.
async function renewRunnerLeaseIfStale(meeting) {
  const expiresAt = Date.parse(meeting?.runner?.leaseExpiresAt || "");
  if (!Number.isFinite(expiresAt)) return;
  if (expiresAt - Date.now() > (config.runner.leaseSeconds * 1000) / 2) return;
  await renewRunnerLease(store.getMeeting(meeting.id));
}

// Free space is checked when the job is handed to a worker, not when the first chunk
// arrives: by then the worker has already spent a meeting encoding video this box was
// always going to refuse. A disk with no room left cannot write meetings.json either, so
// the whole app follows it down — dropping the video is the cheap failure.
async function guardVideoDisk(meeting) {
  if (!config.video.enabled || meeting?.video?.enabled !== true) return meeting;
  const free = await freeDiskBytes();
  if (free >= config.video.minFreeDiskGb * GIB) return meeting;

  // enabled is the worker's own gate, so clearing it is what actually stops the capture;
  // the status and the event record that this was a capacity decision, not the owner's.
  await patchVideo(meeting.id, { enabled: false, status: "skipped", error: "low_disk" });
  await store.appendEvent(meeting.id, {
    type: "video.skipped",
    message:
      `Video skipped: ${Math.round(free / GIB)}GB of disk left, under the ` +
      `${config.video.minFreeDiskGb}GB floor. Audio and transcription are unaffected.`
  });
  return store.getMeeting(meeting.id);
}

// A free-space read that cannot throw. statfs failing means something is wrong with the
// filesystem the recordings live on, and every caller treats "no space" as "skip the
// video" — the right answer for a broken disk as well as a full one.
async function freeDiskBytes() {
  try {
    return await mediaStore.freeDiskBytes();
  } catch (error) {
    console.error(error);
    return 0;
  }
}

/**
 * Turn the uploaded fragments into a playable recording, once.
 *
 * The worker abandons this request at 110s while the remux keeps running, so a retry is
 * the normal case rather than an edge one — which makes both idempotency and the in-flight
 * guard load-bearing. Never throws: a video failure is recorded on the video and the
 * meeting finishes normally, because the transcript is the product.
 */
async function finalizeMeetingVideo(meetingId) {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return { ok: false, statusCode: 404, code: "not_found", message: "Meeting not found." };
  // A finished recording answers with what it already has. Re-running the remux would find
  // no .part left (finalize consumes it) and report a ready video as failed.
  if (meeting.video?.status === "ready" && (await recordingExists(meetingId))) {
    return { ok: true, video: meeting.video };
  }

  const inFlight = videoFinalizations.get(meetingId);
  if (inFlight) return inFlight;

  const pending = runVideoFinalize(meetingId).finally(() => videoFinalizations.delete(meetingId));
  videoFinalizations.set(meetingId, pending);
  return pending;
}

async function runVideoFinalize(meetingId) {
  const partSize = await mediaStore.currentPartSize(meetingId).catch(() => 0);
  if (partSize === 0) {
    // Nothing was ever uploaded. The status is left exactly as it is: a meeting that opted
    // out is "skipped", and calling that "failed" in the run log is a support call.
    return {
      ok: false,
      statusCode: 409,
      code: "no_recording",
      message: "There is no captured video to finalize."
    };
  }

  await patchVideo(meetingId, { status: "processing" });
  try {
    const info = await mediaStore.finalizeRecording(meetingId);
    const now = new Date().toISOString();
    const updated = await patchVideo(meetingId, {
      status: "ready",
      bytes: info.bytes,
      durationMs: info.durationMs,
      width: info.width,
      height: info.height,
      endedAt: now,
      // The retention clock starts here, when the finished file exists — not at meeting
      // creation, which a calendar import can put weeks earlier.
      capturedAt: now,
      // A re-recorded meeting starts a fresh window. patchVideo merges, so a purgedAt left
      // over from the last recording would exempt this one from retention and from the
      // disk budget forever, while its bytes still count against both — the same trap
      // JsonStore.updateMeeting already clears artifactsPurgedAt to avoid.
      purgedAt: null,
      error: null
    });
    await store.appendEvent(meetingId, {
      type: "video.ready",
      message: `Recording ready: ${formatMb(info.bytes)}, ${Math.round((info.durationMs || 0) / 1000)}s.`
    });
    return { ok: true, video: updated?.video ?? null };
  } catch (error) {
    console.error(error.stderr ? `${error.message}\n${error.stderr}` : error);
    await patchVideo(meetingId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      error: String(error.code || "finalize_failed")
    }).catch((patchError) => console.error(patchError));
    await store
      .appendEvent(meetingId, {
        type: "video.failed",
        message: `Recording could not be finalized: ${error.message}`
      })
      .catch((eventError) => console.error(eventError));
    return {
      ok: false,
      statusCode: 500,
      code: String(error.code || "finalize_failed"),
      message: "The recording could not be finalized. Check the server logs."
    };
  }
}

async function recordingExists(meetingId) {
  try {
    return Boolean(await mediaStore.statFile(mediaStore.recordingPath(meetingId)));
  } catch {
    return false;
  }
}

// The one place bytes leave the box. serveFileWithRange is handed a factory rather than an
// open stream so a HEAD or a 416 opens no file descriptor at all, and so the window it
// computes and the window that gets read can never disagree.
async function serveMediaFile(request, response, { resolvePath, extraHeaders }) {
  let absPath;
  try {
    absPath = resolvePath();
  } catch (error) {
    // The path builders throw only on an id they refuse to touch, which is a 404 and not a
    // 500: whatever was asked for cannot exist under mediaDir.
    if (error.code === "invalid_id") return sendJson(response, 404, { error: "not_found" });
    throw error;
  }

  // The record outlives the file by design — a purge deletes bytes, and a finalize that
  // died leaves nothing at recordingPath — so missing bytes read as "gone", never as a
  // fault. It is also what keeps a live share link on a purged clip a 404 instead of a 500.
  const info = await mediaStore.statFile(absPath);
  if (!info) return sendJson(response, 404, { error: "not_found" });

  return serveFileWithRange(response, {
    stream: ({ start, end }) => mediaStore.createReadStream(absPath, { start, end }),
    size: info.size,
    rangeHeader: request.headers.range,
    contentType: "video/mp4",
    method: request.method,
    extraHeaders
  });
}

// Answering a request whose body has not been read leaves the unsent chunk on the socket,
// where a keep-alive connection would parse it as the next request. The top-level handler
// does this for anything it catches; these replies carry a payload of their own and so
// have to say it themselves.
function rejectUnreadBody(request, response, statusCode, payload) {
  if (!request.readableEnded) response.setHeader("Connection", "close");
  return sendJson(response, statusCode, payload);
}

/**
 * Delete video that is out of time or out of space.
 *
 * Deliberately not gated on config.video.enabled: turning the feature off must not strand
 * the recordings made while it was on. The planning is pure and lives in
 * domain/video-retention.js; this side owns the files, the record and the run log.
 */
async function sweepVideoRetention(nowMs) {
  if (videoSweepRunning) return;
  videoSweepRunning = true;
  try {
    const expired = planVideoPurge(store.listMeetings(), nowMs, {
      defaultDays: config.video.retentionDays,
      isActiveStatus: isActiveJobStatus
    });
    for (const entry of expired) {
      await purgeMeetingVideo(entry.meetingId, "retention").catch((error) => console.error(error));
    }

    // Read once per sweep, and after the expiries, so the eviction plan is made against
    // what is actually left on disk rather than against a projection of it. Per meeting as
    // well as in total: video.bytes only exists after a successful finalize, so a .part
    // from a killed worker would otherwise inflate the total while being unevictable, and
    // the overage would be paid off by deleting healthy recordings instead.
    const { totalBytes, byMeeting } = await mediaStore.usageByMeeting();
    const evictions = planDiskEviction(store.listMeetings(), {
      usageBytes: totalBytes,
      budgetBytes: config.video.diskBudgetGb * GIB,
      isActiveStatus: isActiveJobStatus,
      diskBytes: byMeeting
    });
    for (const entry of evictions) {
      await purgeMeetingVideo(entry.meetingId, "disk_budget").catch((error) => console.error(error));
    }
  } finally {
    videoSweepRunning = false;
  }
}

// Deletes a meeting's whole media directory — the recording and every clip cut from it —
// and records what that freed. The clip records go with the files: a clip whose bytes are
// gone is a dead row in the dashboard, and its share token still resolving to a missing
// file is how a public link turns into a 500 instead of the 404 it has earned.
async function purgeMeetingVideo(meetingId, reason) {
  const meeting = store.getMeeting(meetingId);
  if (!meeting) return;

  const { bytesFreed } = await mediaStore.deleteMeetingMedia(meetingId);
  const clipCount = (meeting.clips || []).length;
  const purgedAt = new Date().toISOString();
  await store.updateMeeting(meetingId, {
    video: { ...(meeting.video || {}), status: "purged", purgedAt, bytes: 0, error: null },
    clips: []
  });
  // The bytes MediaStore actually freed, not the ones the plan projected: the projection
  // works off sizes recorded on the meeting, which lag a half-written .part.
  const freed = `${formatMb(bytesFreed)} freed, ${clipCount} clip(s) removed`;
  await store.appendEvent(meetingId, {
    type: reason === "retention" ? "retention.video_purged" : "retention.video_evicted",
    message:
      reason === "retention"
        ? `Video purged after its ${effectiveVideoRetentionDays(meeting, config.video.retentionDays)}-day window (${freed}).`
        : `Video evicted to stay inside the ${config.video.diskBudgetGb}GB media budget (${freed}).`
  });
}

// Stamps every live share belonging to one owner as revoked, for an account that is about
// to stop existing. The hash stays, so the tokens keep resolving to a dead share and
// /s/:token answers its usual 404 instead of falling through to something else.
async function revokeSharesOwnedBy(ownerId) {
  const nowMs = Date.now();
  const revokedAt = new Date(nowMs).toISOString();
  for (const meeting of store.listMeetings()) {
    if (meeting.ownerId !== ownerId) continue;
    const clips = meeting.clips || [];
    if (!clips.some((clip) => shareActive(clip?.share, nowMs))) continue;

    await store.updateMeeting(meeting.id, {
      clips: clips.map((clip) => (shareActive(clip?.share, nowMs) ? { ...clip, share: { ...clip.share, revokedAt } } : clip))
    });
    await store.appendEvent(meeting.id, {
      type: "video.clip_share_revoked",
      message: "Public clip links revoked because the account that created them was removed."
    });
  }
}

// A share must not outlive the file it points at: a link that still looks live but 404s is
// worse than one that says it expired. Video retention defaults to 7 days while a share
// request may ask for far more, so the request is clamped into whatever is left of the
// recording's own life. Whole days only, and 0 is a real answer — the caller refuses the
// share rather than minting one the next retention sweep is about to break.
function remainingVideoDays(meeting, nowMs) {
  const days = effectiveVideoRetentionDays(meeting, config.video.retentionDays);
  const capturedAt = Date.parse(meeting.video?.capturedAt || "");
  if (!Number.isFinite(capturedAt)) return days;
  return Math.max(0, Math.floor(days - (nowMs - capturedAt) / (24 * 60 * 60 * 1000)));
}

function formatMb(bytes) {
  return `${Math.round((Number(bytes) || 0) / (1024 * 1024))}MB`;
}

function formatClipRange(clip) {
  return `${Math.round(clip.startMs / 1000)}s–${Math.round(clip.endMs / 1000)}s`;
}

// When a recording completes, every meeting following it (other users on the same
// event) receives a copy of the artifacts and its own transcript email.
async function propagateToFollowers(primary) {
  if (!primary || primary.status !== "completed") return;
  const followers = store
    .listMeetings()
    .filter((meeting) => meeting.followsMeetingId === primary.id && meeting.status === "following");
  for (const follower of followers) {
    try {
      const copied = await copyRecordingArtifacts({ store, from: primary, toId: follower.id });
      await store.appendEvent(follower.id, {
        type: "notes.ready",
        message: "Notes copied from the shared recording of this meeting."
      });
      // The video belongs to the meeting this one followed — no bot ever joined here — so
      // leaving it "pending" would promise the owner a recording that is never coming.
      if (follower.video?.status === "pending") {
        await patchVideo(follower.id, { status: "skipped" });
      }
      await emailMeetingTranscript(copied, { manual: false }).catch((error) => console.error(error));
      await scheduleActionItemsFor(store.getMeeting(follower.id)).catch((error) => console.error(error));
    } catch (error) {
      console.error(error);
    }
  }
}

async function propagateFailureToFollowers(primaryId) {
  const followers = store
    .listMeetings()
    .filter((meeting) => meeting.followsMeetingId === primaryId && meeting.status === "following");
  for (const follower of followers) {
    await store
      .updateMeeting(follower.id, {
        status: "failed",
        statusMessage: "The shared recording this meeting was following failed."
      })
      .catch((error) => console.error(error));
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
  });
  response.end(JSON.stringify(payload));
}

function sendDownload(response, { filename, contentType, body }) {
  // exportFileName() already slugs to [a-z0-9-.], but strip quotes and newlines anyway so a
  // future caller cannot inject a header through a filename.
  const safeName = String(filename).replace(/["\r\n\\]/gu, "");
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
  });
  response.end(body);
}

function sendHtml(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
  });
  response.end(`<!doctype html><html><body><p>${escapeHtml(message)}</p></body></html>`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
