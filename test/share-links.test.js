// Regression tests for public clip links. Each test is named after the failure it locks
// out: a raw token that reached the store, a share that outlived its revocation, or a
// lookup that told an attacker their guess was close.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  SHARE_VIEW_DEDUPE_MS,
  buildShareRecord,
  countShareView,
  findClipByTokenHash,
  hashShareToken,
  mintShareToken,
  publicShareUrl,
  shareActive,
  shareExpiryDays
} from "../src/domain/share-links.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-26T12:00:00.000Z");

function clipWithShare(id, share) {
  return { id, label: "Clip", startMs: 0, endMs: 1000, bytes: 10, share };
}

function activeShare(tokenHash, overrides = {}) {
  return {
    tokenHash,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 7 * DAY_MS).toISOString(),
    revokedAt: null,
    views: 0,
    lastViewedAt: null,
    ...overrides
  };
}

/* ---------- Minting ---------- */

test("a share token carries 32 bytes of randomness, url-safe", () => {
  const { token } = mintShareToken();
  // base64url of 32 bytes: 43 characters, no padding, nothing that needs escaping in a
  // path segment.
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(token, "base64url").length, 32);
});

test("no two share tokens are ever the same", () => {
  const tokens = new Set();
  const hashes = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const { token, tokenHash } = mintShareToken();
    tokens.add(token);
    hashes.add(tokenHash);
  }
  assert.equal(tokens.size, 2000);
  assert.equal(hashes.size, 2000, "and neither are their hashes");
});

test("the hash a token mints with is the hash it looks up with", () => {
  const { token, tokenHash } = mintShareToken();
  assert.equal(tokenHash, hashShareToken(token));
  assert.match(tokenHash, /^[0-9a-f]{64}$/u);
});

test("hashing is stable, so links minted by an older build still resolve", () => {
  // Pinned against the SHA-256 of "hello": changing the digest or the encoding here would
  // silently invalidate every share link already in the wild.
  assert.equal(hashShareToken("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(hashShareToken("hello"), hashShareToken("hello"));
  assert.notEqual(hashShareToken("hello"), hashShareToken("hellO"));
});

test("the raw token never reaches the stored record", () => {
  // This is the whole point of the module. meetings.json already holds every transcript;
  // the video files are the one asset that is not in it, and a raw token in the store
  // would hand those over in the same leak.
  const { token, tokenHash } = mintShareToken();
  const share = buildShareRecord({ tokenHash, days: 7, nowMs: NOW });

  const serialized = JSON.stringify({ meetings: [{ clips: [clipWithShare("clip-1", share)] }] });
  assert.ok(!serialized.includes(token), "the raw token is not anywhere in what gets persisted");
  assert.ok(serialized.includes(tokenHash), "only the hash is");
  assert.deepEqual(Object.keys(share), ["tokenHash", "createdAt", "expiresAt", "revokedAt", "views", "lastViewedAt"]);
});

/* ---------- shareActive ---------- */

test("a clip with no share is not shared", () => {
  assert.equal(shareActive(null, NOW), false);
  assert.equal(shareActive(undefined, NOW), false);
  assert.equal(shareActive("token", NOW), false);
});

test("a live share inside its window is active", () => {
  assert.equal(shareActive(activeShare("a".repeat(64)), NOW), true);
});

test("a revoked share is dead even while its expiry is still in the future", () => {
  const share = activeShare("a".repeat(64), { revokedAt: new Date(NOW - 1000).toISOString() });
  assert.equal(shareActive(share, NOW), false);
});

test("a share is dead the instant it expires, not a moment after", () => {
  const share = activeShare("a".repeat(64), { expiresAt: new Date(NOW).toISOString() });
  assert.equal(shareActive(share, NOW), false, "expiry is exclusive");
  assert.equal(shareActive(share, NOW - 1), true);
  assert.equal(shareActive(share, NOW + 1), false);
});

test("a share whose expiry cannot be read fails closed", () => {
  // A missing or corrupted expiresAt must not be treated as "no expiry set". The only
  // thing worse than a broken link is a public video link that never stops working.
  for (const expiresAt of [undefined, null, "", "   ", "soon", "2026-13-45T99:00:00Z", 0, {}]) {
    assert.equal(shareActive(activeShare("a".repeat(64), { expiresAt }), NOW), false, JSON.stringify(expiresAt));
  }
});

/* ---------- Lookup ---------- */

test("a token hash finds its clip wherever in the store it lives", () => {
  const { tokenHash } = mintShareToken();
  const meetings = [
    { id: "m1", clips: [clipWithShare("c1", null)] },
    { id: "m2" },
    { id: "m3", clips: [] },
    { id: "m4", clips: [clipWithShare("c2", activeShare(hashShareToken("other"))), clipWithShare("c3", activeShare(tokenHash))] }
  ];

  const found = findClipByTokenHash(meetings, tokenHash);
  assert.equal(found.meeting.id, "m4");
  assert.equal(found.clip.id, "c3");
});

test("a token that was never minted finds nothing", () => {
  const meetings = [{ id: "m1", clips: [clipWithShare("c1", activeShare(hashShareToken("real")))] }];
  assert.equal(findClipByTokenHash(meetings, hashShareToken("guessed")), null);
  assert.equal(findClipByTokenHash([], hashShareToken("real")), null);
  assert.equal(findClipByTokenHash(undefined, hashShareToken("real")), null);
});

test("an expired or revoked share is still found, so both answers can be the same 404", () => {
  // Filtering here would let a probe tell "this token was real but expired" apart from
  // "this token never existed" — the exact signal a 32-byte token exists to deny.
  const { token, tokenHash } = mintShareToken();
  const dead = activeShare(tokenHash, { expiresAt: new Date(NOW - DAY_MS).toISOString(), revokedAt: new Date(NOW - DAY_MS).toISOString() });
  const meetings = [{ id: "m1", clips: [clipWithShare("c1", dead)] }];

  const found = findClipByTokenHash(meetings, hashShareToken(token));
  assert.equal(found.clip.id, "c1", "the lookup succeeds");
  assert.equal(shareActive(found.clip.share, NOW), false, "and the caller is the one that refuses it");
});

test("anything that is not a sha256 digest never starts a scan", () => {
  const meetings = [{ id: "m1", clips: [clipWithShare("c1", activeShare(hashShareToken("real")))] }];
  for (const needle of [null, undefined, "", "   ", 42, {}, [], "not-a-hash", "a".repeat(63), "a".repeat(65), "z".repeat(64)]) {
    assert.equal(findClipByTokenHash(meetings, needle), null, JSON.stringify(needle));
  }
});

test("a hash is matched case-insensitively but never as a prefix", () => {
  const hash = hashShareToken("real");
  const meetings = [{ id: "m1", clips: [clipWithShare("c1", activeShare(hash.toUpperCase()))] }];
  assert.equal(findClipByTokenHash(meetings, hash).clip.id, "c1", "a stored digest in upper case still resolves");
  assert.equal(findClipByTokenHash(meetings, `${hash.slice(0, 63)}0`), null, "one byte off is a miss");
});

test("a share record with no hash on it can never be matched", () => {
  // A half-written or hand-edited record must not become a link that any token opens.
  for (const tokenHash of [undefined, null, "", "not-a-hash"]) {
    const meetings = [{ id: "m1", clips: [clipWithShare("c1", activeShare(tokenHash))] }];
    assert.equal(findClipByTokenHash(meetings, hashShareToken("anything")), null);
    assert.equal(findClipByTokenHash(meetings, tokenHash), null, JSON.stringify(tokenHash));
  }
});

/* ---------- URLs ---------- */

test("a share url is the base url plus the token, with exactly one slash between", () => {
  assert.equal(publicShareUrl("https://notes.example.com", "abc"), "https://notes.example.com/s/abc");
  assert.equal(publicShareUrl("https://notes.example.com/", "abc"), "https://notes.example.com/s/abc");
  assert.equal(publicShareUrl("https://notes.example.com///", "abc"), "https://notes.example.com/s/abc");
});

test("a token is escaped into the path even though base64url never needs it", () => {
  // Insurance against a future token encoding: this string ends up in a URL handed to
  // someone else, and a stray slash in it would silently point at a different route.
  assert.equal(publicShareUrl("https://x.test", "a/b?c=d"), "https://x.test/s/a%2Fb%3Fc%3Dd");
});

/* ---------- Expiry windows ---------- */

test("a share window falls back to the default when nothing usable is asked for", () => {
  for (const requested of [undefined, null, "", 0, -5, "soon", Number.NaN]) {
    assert.equal(shareExpiryDays(requested, { defaultDays: 7 }), 7, JSON.stringify(requested));
  }
  assert.equal(shareExpiryDays(undefined, {}), DEFAULT_SHARE_DAYS);
});

test("a share never outlives the video it points at", () => {
  // maxDays is the video's own remaining life. Video retention defaults to 7 days while a
  // request can ask for far more, and a link that survives its file is a dead link that
  // still looks live to whoever holds it.
  assert.equal(shareExpiryDays(30, { defaultDays: 7, maxDays: 3 }), 3);
  assert.equal(shareExpiryDays(2, { defaultDays: 7, maxDays: 3 }), 2);
  assert.equal(shareExpiryDays(7, { defaultDays: 7, maxDays: 0 }), 7, "an unusable ceiling falls back, it does not zero the window");
});

test("no caller can mint a link that lives longer than the hard ceiling", () => {
  assert.equal(shareExpiryDays(3650, { defaultDays: 7 }), MAX_SHARE_DAYS);
  assert.equal(shareExpiryDays(10, { defaultDays: 7, maxDays: 100_000 }), 10);
  assert.equal(shareExpiryDays(3650, { defaultDays: 7, maxDays: 100_000 }), MAX_SHARE_DAYS);
  assert.equal(shareExpiryDays(3650, { defaultDays: 100_000 }), MAX_SHARE_DAYS);
});

test("a share record expires exactly the requested number of days out", () => {
  const share = buildShareRecord({ tokenHash: "a".repeat(64), days: 3, nowMs: NOW });
  assert.equal(share.createdAt, new Date(NOW).toISOString());
  assert.equal(Date.parse(share.expiresAt) - NOW, 3 * DAY_MS);
  assert.equal(share.revokedAt, null);
  assert.equal(share.views, 0);
  assert.equal(share.lastViewedAt, null);
  assert.equal(shareActive(share, NOW + 2 * DAY_MS), true);
  assert.equal(shareActive(share, NOW + 4 * DAY_MS), false);
});

test("a request body passed straight into buildShareRecord still gets clamped", () => {
  const share = buildShareRecord({ tokenHash: "a".repeat(64), days: 9999, maxDays: 5, nowMs: NOW });
  assert.equal(Date.parse(share.expiresAt) - NOW, 5 * DAY_MS);
});

/* ---------- View counting ---------- */

test("the first view of a share is counted", () => {
  const counted = countShareView(activeShare("a".repeat(64)), NOW);
  assert.equal(counted.views, 1);
  assert.equal(counted.lastViewedAt, new Date(NOW).toISOString());
});

test("one viewing is one view, however many range requests the player makes", () => {
  // A browser playing a video fires a burst of Range requests, and every meetings.json
  // write rewrites the whole file. Counting each one would turn a single shared clip into
  // dozens of full-store rewrites.
  let share = activeShare("a".repeat(64));
  share = countShareView(share, NOW);
  for (let index = 1; index < 40; index += 1) {
    assert.equal(countShareView(share, NOW + index * 200), null, "nothing to persist for a continuation request");
  }
  assert.equal(share.views, 1);

  const later = countShareView(share, NOW + SHARE_VIEW_DEDUPE_MS + 1);
  assert.equal(later.views, 2, "a viewing after the window is a new view");
});

test("a clock that jumped backwards skips a write rather than inflating a count", () => {
  const share = activeShare("a".repeat(64), { views: 4, lastViewedAt: new Date(NOW + DAY_MS).toISOString() });
  assert.equal(countShareView(share, NOW), null);
});

test("a corrupted view count starts again from one instead of producing NaN", () => {
  for (const views of [undefined, null, "seven", -3, 1.5, Number.NaN]) {
    assert.equal(countShareView(activeShare("a".repeat(64), { views }), NOW).views, 1, JSON.stringify(views));
  }
  assert.equal(countShareView(null, NOW), null);
});

test("counting a view changes nothing else about the share", () => {
  const share = activeShare("a".repeat(64));
  const counted = countShareView(share, NOW);
  assert.equal(counted.tokenHash, share.tokenHash);
  assert.equal(counted.expiresAt, share.expiresAt);
  assert.equal(counted.revokedAt, share.revokedAt);
  assert.equal(share.views, 0, "the input is not mutated");
});
