import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_WORKSPACE_SCOPES = [GMAIL_SEND_SCOPE, CALENDAR_READONLY_SCOPE];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars";

export function createGmailOAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_WORKSPACE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGmailCode({ clientId, clientSecret, redirectUri, code }) {
  const token = await requestToken({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code"
  });
  return normalizeToken(token);
}

export async function loadGmailToken(tokenPath) {
  try {
    const raw = await readFile(tokenPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveGmailToken(tokenPath, token) {
  await mkdir(dirname(tokenPath), { recursive: true });
  const tempPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, tokenPath);
}

export async function hasUsableGmailToken(tokenPath) {
  const token = await loadGmailToken(tokenPath);
  return Boolean(token?.access_token || token?.refresh_token);
}

export async function getGoogleTokenStatus(tokenPath) {
  const token = await loadGmailToken(tokenPath);
  return {
    connected: Boolean(token?.access_token || token?.refresh_token),
    gmailSend: tokenHasScope(token, GMAIL_SEND_SCOPE),
    calendarReadonly: tokenHasScope(token, CALENDAR_READONLY_SCOPE),
    scopes: parseScopes(token)
  };
}

export function tokenHasScope(token, scope) {
  return parseScopes(token).includes(scope);
}

export async function sendGmailMessage({ auth, tokenPath, message }) {
  const accessToken = await getGoogleAccessToken({ auth, tokenPath });
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ raw: encodeBase64Url(message) })
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body?.error?.message || "Gmail rejected the transcript email.");
  }
  return body;
}

export async function listCalendarEvents({ auth, tokenPath, calendarId, timeMin, timeMax, maxResults = 20 }) {
  const accessToken = await getGoogleAccessToken({ auth, tokenPath });
  const url = new URL(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(calendarId || "primary")}/events`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("maxResults", String(maxResults));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body?.error?.message || "Google Calendar rejected the events request.");
  }
  return Array.isArray(body?.items) ? body.items : [];
}

export function extractGoogleMeetUrl(event) {
  const candidates = [
    event?.hangoutLink,
    ...(event?.conferenceData?.entryPoints || []).map((entry) => entry?.uri),
    event?.location,
    event?.description
  ];

  for (const candidate of candidates) {
    const match = String(candidate || "").match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s<>"')]+)?/iu);
    if (match?.[0]) return match[0].replace(/[),.;]+$/u, "");
  }
  return "";
}

export function createMimeMessage({ to, from, subject, text, html, boundary = createBoundary() }) {
  const headers = [
    from ? `From: ${sanitizeHeader(from)}` : "",
    `To: ${sanitizeHeader(to)}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0"
  ].filter(Boolean);

  const plainText = normalizeBody(text);
  if (!html) {
    return `${[
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit"
    ].join("\r\n")}\r\n\r\n${plainText}`;
  }

  const safeBoundary = sanitizeBoundary(boundary);
  return `${[
    ...headers,
    `Content-Type: multipart/alternative; boundary="${safeBoundary}"`
  ].join("\r\n")}\r\n\r\n--${safeBoundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${plainText}\r\n--${safeBoundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${normalizeBody(html)}\r\n--${safeBoundary}--`;
}

export function encodeBase64Url(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function sanitizeEmailAddress(value) {
  const email = sanitizeHeader(value).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email)) return "";
  return email;
}

export async function getGoogleAccessToken({ auth, tokenPath }) {
  const token = await loadGmailToken(tokenPath);
  if (!token) throw new Error("Google Workspace is not connected.");

  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) {
    return token.access_token;
  }

  if (!token.refresh_token) {
    throw new Error("Google token expired. Reconnect Google Workspace to continue.");
  }

  const refreshed = await requestToken({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token"
  });
  const next = normalizeToken({
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token
  });
  await saveGmailToken(tokenPath, next);
  return next.access_token;
}

function parseScopes(token) {
  return String(token?.scope || "")
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function requestToken(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body?.error_description || body?.error || "Google OAuth token request failed.");
  }
  return body;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeToken(token) {
  const expiresIn = Number(token.expires_in || 0);
  return {
    ...token,
    expires_at: expiresIn > 0 ? Date.now() + expiresIn * 1000 : token.expires_at || 0,
    saved_at: new Date().toISOString()
  };
}

function sanitizeHeader(value) {
  return String(value ?? "").replace(/[\r\n]+/gu, " ").trim();
}

function normalizeBody(value) {
  return String(value ?? "").replace(/\r?\n/gu, "\r\n");
}

function createBoundary() {
  return `open-notetaker-${randomUUID()}`;
}

function sanitizeBoundary(value) {
  const boundary = String(value || "")
    .replace(/[^A-Za-z0-9'()+_,./:=?-]/gu, "")
    .slice(0, 70);
  return boundary || createBoundary();
}

function encodeMimeHeader(value) {
  const clean = sanitizeHeader(value);
  if (/^[\x20-\x7E]*$/u.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}
