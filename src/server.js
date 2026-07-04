import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
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
import { isGoogleMeetUrl, sanitizeRawSegments, validateMeetingInput } from "./domain/validation.js";
import { buildTranscriptEmail } from "./domain/transcript-email.js";
import {
  CALENDAR_READONLY_SCOPE,
  createGmailOAuthUrl,
  createMimeMessage,
  exchangeGmailCode,
  extractGoogleMeetUrl,
  fetchGoogleUserinfo,
  getGoogleTokenStatus,
  hasUsableGmailToken,
  listCalendarEvents,
  saveGmailToken,
  sendGmailMessage,
  tokenHasScope
} from "./providers/gmail.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicDir = join(rootDir, "public");
const dataPath = join(rootDir, "data", "meetings.json");
const usersPath = join(rootDir, "data", "users.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const config = readConfig();
assertProviderSecrets(config);

const store = new JsonStore(dataPath);
await store.load();

const users = new UsersStore(usersPath);
await users.load();
await users.pruneExpiredSessions();

const sessionTtlMs = config.auth.sessionTtlDays * 24 * 60 * 60 * 1000;
// Session renewals persist at most this often to avoid a store write per request.
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// In-memory limiters: single-process only; move to Redis before running replicas.
const loginIpLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginAccountLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const signupIpLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const passwordResetLimiter = new SlidingWindowRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessionSweeper = setInterval(() => {
  users.pruneExpiredSessions().catch((error) => console.error(error));
}, 60 * 60 * 1000);
sessionSweeper.unref?.();

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

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
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
    return sendJson(response, 201, { user: publicUser(user) });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const ip = clientIp(request);
    if (!loginIpLimiter.consume(ip).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many login attempts. Try later." });
    }

    const body = await readJsonBody(request);
    const email = validateEmail(body.email);
    if (email && !loginAccountLimiter.consume(`${ip}:${email}`).allowed) {
      return sendJson(response, 429, { error: "rate_limited", message: "Too many login attempts for this account. Try later." });
    }

    const user = email ? users.findUserByEmail(email) : null;
    // Unknown emails still burn a full scrypt verification so response timing does
    // not reveal which addresses have accounts.
    const passwordHash = user?.passwordHash || (await DUMMY_PASSWORD_HASH_PROMISE);
    const valid = await verifyPassword(body.password || "", passwordHash);
    if (!user || !valid) {
      return sendJson(response, 401, { error: "invalid_credentials", message: "Invalid email or password." });
    }

    await users.updateUser(user.id, { lastLoginAt: new Date().toISOString(), lastLoginIp: ip });
    await startSession(request, response, user);
    return sendJson(response, 200, { user: publicUser(users.getUser(user.id)) });
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
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (url.pathname === "/api/auth/settings" && request.method === "PATCH") {
    const user = await requireUser(request, response);
    if (!user) return;

    const body = await readJsonBody(request);
    const settings = {};
    if (Array.isArray(body.transcriptRecipients)) {
      const recipients = [];
      const seen = new Set();
      for (const item of body.transcriptRecipients.slice(0, 10)) {
        const email = validateEmail(item);
        if (email && !seen.has(email)) {
          seen.add(email);
          recipients.push(email);
        }
      }
      settings.transcriptRecipients = recipients;
    }
    for (const key of ["autoEmailTranscript", "calendarSyncEnabled", "calendarAutoStart"]) {
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
      const tokenStatus = isGmailConfigured()
        ? await getGoogleTokenStatus(userGoogleTokenPath(member.id))
        : { connected: false };
      rows.push({
        ...publicUser(member),
        lastLoginAt: member.lastLoginAt,
        googleConnected: Boolean(tokenStatus.connected),
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
    await users.removeUser(target.id);
    return sendJson(response, 200, { ok: true });
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

    await saveGmailToken(userGoogleTokenPath(pending.userId), token);
    // Granting calendar scope is a clear intent to import meetings, so switch the
    // per-user sync toggle on. Autostart (a bot joining unattended) stays opt-in.
    if (tokenHasScope(token, CALENDAR_READONLY_SCOPE)) {
      await users.updateUser(pending.userId, { settings: { calendarSyncEnabled: true } });
    }
    return sendHtml(response, 200, "Google connected. You can close this tab and return to OpenNotetaker.");
  }

  if (url.pathname === "/api/meetings" && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      meetings: store.listMeetings().filter((meeting) => meeting.ownerId === user.id)
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
    return sendJson(response, 201, { meeting });
  }

  const meetingMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
  if (meetingMatch && request.method === "GET") {
    const user = await requireUser(request, response);
    if (!user) return;
    const meeting = getOwnedMeeting(meetingMatch[1], user);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 200, { meeting });
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
        meeting: store.getMeeting(meeting.id),
        message: "Re-running notes from the captured transcript."
      });
    }

    startMeetingJob(meeting);

    return sendJson(response, 202, {
      meeting: store.getMeeting(meeting.id),
      message: "Notetaker job started."
    });
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
        meeting: store.getMeeting(meeting.id),
        delivery
      });
    } catch (error) {
      return sendJson(response, 400, {
        error: "email_failed",
        message: error.message
      });
    }
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
      meeting: claimed,
      leaseSeconds: config.runner.leaseSeconds
    });
  }

  const runnerMeetingMatch = url.pathname.match(/^\/api\/runner\/meetings\/([^/]+)$/);
  if (runnerMeetingMatch && request.method === "GET") {
    if (!isRunnerAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    const meeting = store.getMeeting(runnerMeetingMatch[1]);
    if (!meeting) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 200, { meeting });
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
    return sendJson(response, 200, { meeting: updated });
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
    return sendJson(response, 201, { meeting: updated });
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
    // merging by id keeps retries idempotent.
    const merged = mergeSegmentsById(meeting.artifacts?.rawSegments || [], sanitized.value);
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
    // finalization works from whichever copy survived (incremental or final).
    const merged = mergeSegmentsById(meeting.artifacts?.rawSegments || [], sanitized.value);

    finalizeRawTranscript({ meeting, store, config, rawSegments: merged.segments })
      .then(async (completed) => {
        try {
          await emailMeetingTranscript(completed, { manual: false });
        } catch (error) {
          console.error(error);
        }
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

  const recipients = transcriptRecipientsFor(owner);
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
  const tokenPath = userGoogleTokenPath(owner.id);
  if (!(await hasUsableGmailToken(tokenPath))) {
    throw new Error("Connect Google (Gmail) before sending transcript email.");
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

function transcriptRecipientsFor(owner) {
  const configured = owner.settings?.transcriptRecipients || [];
  return configured.length ? configured : [owner.email];
}

function deliverySentToAll(delivery, recipients) {
  if (delivery?.status !== "sent") return false;
  const sentRecipients = Array.isArray(delivery.recipients)
    ? delivery.recipients
    : [delivery.recipient].filter(Boolean);
  const normalizedSent = new Set(sentRecipients.map((recipient) => recipient.toLowerCase()));
  return recipients.every((recipient) => normalizedSent.has(recipient.toLowerCase()));
}

async function getGmailStatus(user) {
  const configured = isGmailConfigured();
  const tokenStatus = configured ? await getGoogleTokenStatus(userGoogleTokenPath(user.id)) : null;
  const recipients = transcriptRecipientsFor(user);
  return {
    configured,
    connected: Boolean(tokenStatus?.gmailSend),
    googleConnected: Boolean(tokenStatus?.connected),
    automaticTranscriptEmail: Boolean(user.settings?.autoEmailTranscript),
    recipient: recipients.join(", "),
    recipients,
    redirectUri: config.google.redirectUri
  };
}

async function getCalendarStatus(user) {
  const configured = isGmailConfigured();
  const tokenStatus = configured ? await getGoogleTokenStatus(userGoogleTokenPath(user.id)) : null;
  return {
    configured,
    connected: Boolean(tokenStatus?.calendarReadonly),
    googleConnected: Boolean(tokenStatus?.connected),
    enabled: Boolean(user.settings?.calendarSyncEnabled) && config.google.calendar.enabled,
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
  const tokenPath = userGoogleTokenPath(user.id);
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
  // The direct socket address. Do not trust X-Forwarded-For here until a trusted
  // reverse proxy is part of the deployment and made explicit in config.
  return request.socket.remoteAddress || "unknown";
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

function userGoogleTokenPath(userId) {
  return join(config.google.tokenDir, `${String(userId).replace(/[^a-zA-Z0-9-]/g, "")}.json`);
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

    // Manual sync targets the requesting user; the scheduler targets every user who
    // opted in via settings.
    const targets = onlyUserId
      ? [users.getUser(onlyUserId)].filter(Boolean)
      : users.listUsers().filter((user) => user.settings?.calendarSyncEnabled);

    const now = Date.now();
    let checkedEvents = 0;
    const imported = [];
    const skipped = [];
    const userErrors = [];

    for (const user of targets) {
      const tokenPath = userGoogleTokenPath(user.id);
      const tokenStatus = await getGoogleTokenStatus(tokenPath);
      if (!tokenStatus.calendarReadonly) {
        if (onlyUserId) {
          throw new Error("Reconnect Google to grant Calendar read-only access.");
        }
        userErrors.push({ userId: user.id, message: "calendar_scope_missing" });
        continue;
      }

      try {
        const events = await listCalendarEvents({
          auth: getGoogleAuth(),
          tokenPath,
          calendarId: config.google.calendar.calendarId,
          timeMin: new Date(now - config.google.calendar.autoStartLateMinutes * 60_000).toISOString(),
          timeMax: new Date(now + config.google.calendar.lookaheadMinutes * 60_000).toISOString(),
          maxResults: 50
        });
        checkedEvents += events.length;
        for (const event of events) {
          const result = await upsertCalendarEventMeeting(event, user);
          if (result?.meeting) imported.push(result);
          else if (result?.reason) skipped.push(result.reason);
        }
      } catch (error) {
        if (onlyUserId) throw error;
        userErrors.push({ userId: user.id, message: error.message });
      }
    }

    const started = await startDueCalendarMeetings();
    const result = {
      status: "synced",
      reason,
      syncedUsers: targets.length,
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

async function upsertCalendarEventMeeting(event, owner) {
  if (!event || event.status === "cancelled") return { reason: "cancelled" };

  const meetUrl = extractGoogleMeetUrl(event);
  if (!meetUrl || !isGoogleMeetUrl(meetUrl)) return { reason: "no_meet_url" };

  const scheduledAt = event.start?.dateTime || "";
  if (!scheduledAt || Number.isNaN(Date.parse(scheduledAt))) return { reason: "all_day_or_invalid_start" };

  const source = createCalendarSource(event);
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

    // Autostart is opt-in per user on top of the global operator switch.
    const owner = meeting.ownerId ? users.getUser(meeting.ownerId) : null;
    if (!owner?.settings?.calendarAutoStart) continue;

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

function createCalendarSource(event) {
  return {
    provider: "google_calendar",
    googleCalendar: {
      calendarId: config.google.calendar.calendarId,
      eventId: event.id || "",
      iCalUID: event.iCalUID || "",
      htmlLink: event.htmlLink || "",
      status: event.status || "",
      organizerEmail: event.organizer?.email || "",
      creatorEmail: event.creator?.email || "",
      originalStartTime: event.originalStartTime?.dateTime || event.originalStartTime?.date || "",
      eventUpdatedAt: event.updated || "",
      lastSyncedAt: new Date().toISOString()
    }
  };
}

function mergeCalendarSource(meeting, source) {
  return {
    ...(meeting.source || {}),
    provider: "google_calendar",
    googleCalendar: {
      ...(meeting.source?.googleCalendar || {}),
      ...source.googleCalendar
    }
  };
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
  if (!filePath.startsWith(publicDir)) {
    return sendJson(response, 403, { error: "forbidden" });
  }

  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      const index = await readFile(join(publicDir, "index.html"));
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[".html"],
        "Cache-Control": "no-store"
      });
      response.end(index);
      return;
    }
    throw error;
  }
}

async function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
      await emailMeetingTranscript(copied, { manual: false }).catch((error) => console.error(error));
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
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
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
