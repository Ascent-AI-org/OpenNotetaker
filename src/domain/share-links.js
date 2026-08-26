// The security model for public clip links.
//
// Only the SHA-256 of a share token is ever stored. Do not "fix" the inconvenience of
// being unable to re-display a link by keeping the raw token next to the hash:
// data/meetings.json already holds every transcript, and the video files are the one
// asset that is NOT in it. Storing raw tokens would mean a leaked store file hands over
// live, unauthenticated video links too — the same reason session tokens are stored
// hashed in src/storage/users-store.js. The raw token is returned exactly once, at
// creation; the recovery path for a lost link is regenerate, not re-copy.
//
// Everything here is pure. The route owns persistence, rate limiting and the 404s.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

// 32 bytes, so a link is unguessable even though /s/:token is unauthenticated and
// IP-rate-limited rather than account-rate-limited.
const SHARE_TOKEN_BYTES = 32;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export const DEFAULT_SHARE_DAYS = 7;

// A hard ceiling on top of whatever the caller asks for. A link nobody remembers issuing
// is the one that leaks, and an unrevoked share on a self-hosted box has nobody watching
// it — so every link dies on its own eventually.
export const MAX_SHARE_DAYS = 90;

// A browser playing a video fires a burst of Range requests for a single viewing, and
// every meetings.json write rewrites the whole file. Counting each request would turn one
// shared clip into dozens of full-store rewrites.
export const SHARE_VIEW_DEDUPE_MS = 5 * 60_000;

/**
 * A new share token and the only form of it that gets persisted.
 *
 * The caller shows `token` to the owner once and stores `tokenHash`. Writing `token`
 * anywhere durable — the meeting record, an event message, a log line — defeats the
 * entire point of hashing it.
 */
export function mintShareToken() {
  const token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashShareToken(token) };
}

export function hashShareToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Whether a share is still usable. Fails closed: a share whose expiry is missing or
 * unparseable is treated as dead rather than as "no expiry set", because the one thing
 * worse than a broken link is a public video link that never stops working.
 */
export function shareActive(share, nowMs = Date.now()) {
  if (!share || typeof share !== "object") return false;
  if (share.revokedAt) return false;
  const expiresAt = Date.parse(share.expiresAt || "");
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > nowMs;
}

/**
 * Find the clip a token hash belongs to, anywhere in the store.
 *
 * Deliberately does not filter on shareActive: the route checks that separately and
 * answers the same 404 either way, so a probe cannot learn that a token was real but
 * expired. Keep it that way — an "expired link" response tells an attacker their guess
 * hit, which is exactly the signal a 32-byte token exists to deny them.
 */
export function findClipByTokenHash(meetings, tokenHash) {
  const needle = normalizeHash(tokenHash);
  if (!needle) return null;

  for (const meeting of meetings || []) {
    for (const clip of meeting?.clips || []) {
      const stored = normalizeHash(clip?.share?.tokenHash);
      if (stored && hashesMatch(stored, needle)) return { meeting, clip };
    }
  }
  return null;
}

export function publicShareUrl(baseUrl, token) {
  return `${String(baseUrl || "").replace(/\/+$/u, "")}/s/${encodeURIComponent(String(token))}`;
}

/**
 * How long a new share should live, in days.
 *
 * `maxDays` is the video's own remaining life. A link that outlives the file it points at
 * is a dead link that still looks live to whoever holds it, and video retention is 7 days
 * by default while a share request can ask for far more — so the request is clamped into
 * the video's window rather than refused.
 */
export function shareExpiryDays(requestedDays, { defaultDays, maxDays } = {}) {
  const ceiling = Math.max(1, Math.min(positiveInt(maxDays) ?? MAX_SHARE_DAYS, MAX_SHARE_DAYS));
  const fallback = positiveInt(defaultDays) ?? DEFAULT_SHARE_DAYS;
  const requested = positiveInt(requestedDays) ?? fallback;
  return Math.min(Math.max(1, requested), ceiling);
}

/**
 * The stored shape of a share. Note what is absent: there is no field for the raw token,
 * and adding one is the change that turns a store leak into a video leak.
 */
export function buildShareRecord({ tokenHash, days, defaultDays, maxDays, nowMs = Date.now() } = {}) {
  // Re-clamped here even when the caller already resolved the window, so a route that
  // passes a request body straight through cannot mint a decade-long link.
  const window = shareExpiryDays(days, { defaultDays, maxDays });
  return {
    tokenHash,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + window * DAY_MS).toISOString(),
    revokedAt: null,
    views: 0,
    lastViewedAt: null
  };
}

/**
 * The share as it should be stored after a view, or null when this request does not count
 * as one — in which case the caller persists nothing at all. A viewing is a burst of Range
 * requests, so anything inside the dedupe window is the same viewing.
 */
export function countShareView(share, nowMs = Date.now(), { dedupeMs = SHARE_VIEW_DEDUPE_MS } = {}) {
  if (!share || typeof share !== "object") return null;
  const lastViewedAt = Date.parse(share.lastViewedAt || "");
  // A lastViewedAt in the future (a clock that moved backwards) also lands here, which is
  // the harmless direction: it skips a write rather than inflating a count.
  if (Number.isFinite(lastViewedAt) && nowMs - lastViewedAt < dedupeMs) return null;

  return {
    ...share,
    views: (Number.isInteger(share.views) && share.views > 0 ? share.views : 0) + 1,
    lastViewedAt: new Date(nowMs).toISOString()
  };
}

// Anything that is not a plain sha256 hex digest can never match a stored hash, so it
// never gets to start a scan.
function normalizeHash(value) {
  if (typeof value !== "string") return null;
  const hash = value.trim().toLowerCase();
  return SHA256_HEX.test(hash) ? hash : null;
}

// Both sides are already digests of a caller-supplied secret, so `===` would be safe here
// — steering the compared bytes needs a SHA-256 preimage. Constant-time anyway, because
// that argument is too subtle to be the only thing between a timing probe and someone's
// video.
function hashesMatch(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function positiveInt(value) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim() || Number.NaN);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
}
