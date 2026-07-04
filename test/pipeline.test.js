import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { MockLlmProvider } from "../src/providers/mock.js";
import { processRawSegments } from "../src/domain/pipeline.js";
import { repairActionItems, repairReconstructedTranscript } from "../src/providers/openai.js";
import { DeepgramStreamingClient, deepgramResultToSegments } from "../src/providers/deepgram.js";
import { JsonStore } from "../src/storage/json-store.js";
import { UsersStore, publicUser } from "../src/storage/users-store.js";
import {
  buildSessionCookie,
  hashPassword,
  hashSessionToken,
  generateSessionToken,
  parseCookies,
  validateEmail,
  validatePassword,
  verifyPassword
} from "../src/domain/auth.js";
import { SlidingWindowRateLimiter } from "../src/domain/rate-limit.js";
import {
  buildLease,
  findRecordingPeer,
  leaseExpired,
  pickClaimableMeeting,
  renewLease,
  shouldReleaseClaim,
  shouldSalvageRecording
} from "../src/domain/runner-jobs.js";
import {
  CALENDAR_READONLY_SCOPE,
  createMimeMessage,
  encodeBase64Url,
  extractGoogleMeetUrl,
  sanitizeEmailAddress,
  tokenHasScope
} from "../src/providers/gmail.js";
import { formatTranscriptEmail, formatTranscriptEmailHtml } from "../src/domain/transcript-email.js";
import { createDemoTranscript } from "../src/domain/demo-transcript.js";
import { sanitizeRawSegments, validateMeetingInput } from "../src/domain/validation.js";
import {
  looksLikeLoopbackDevice,
  parseAvfoundationDevices,
  resolveAvfoundationAudioDevice
} from "../src/bot-runner/audio-devices.js";
import { MeetBrowserBot } from "../src/bot-runner/meet-browser.js";

test("reads comma-separated transcript email recipients", () => {
  const previousTo = process.env.TRANSCRIPT_EMAIL_TO;
  const previousFrom = process.env.TRANSCRIPT_EMAIL_FROM;
  try {
    process.env.TRANSCRIPT_EMAIL_TO = "dhruv@example.com, sanya@example.com, bad-value, DHruv@example.com";
    process.env.TRANSCRIPT_EMAIL_FROM = "sender@example.com";

    const config = readConfig();

    assert.deepEqual(config.email.transcript.recipients, ["dhruv@example.com", "sanya@example.com"]);
    assert.equal(config.email.transcript.recipient, "dhruv@example.com");
    assert.equal(config.email.transcript.from, "sender@example.com");
  } finally {
    restoreEnv("TRANSCRIPT_EMAIL_TO", previousTo);
    restoreEnv("TRANSCRIPT_EMAIL_FROM", previousFrom);
  }
});

test("validates Google Meet URLs", () => {
  const result = validateMeetingInput({
    title: "Product sync",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: new Date().toISOString(),
    consentMode: "host_confirmed",
    retentionDays: 30
  });

  assert.equal(result.ok, true);
});

test("rejects non-Meet URLs", () => {
  const result = validateMeetingInput({
    title: "Product sync",
    meetUrl: "https://example.com/abc-defg-hij",
    consentMode: "host_confirmed",
    retentionDays: 30
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.meetUrl, "Use a valid Google Meet URL.");
});

test("normalizes Hinglish demo segments and extracts action items", async () => {
  const provider = new MockLlmProvider();
  const rawSegments = createDemoTranscript();
  const normalized = await provider.normalizeSegments(rawSegments);
  const notes = await provider.extractNotes(normalized);

  assert.equal(normalized.length, rawSegments.length);
  assert.match(normalized[0].english, /by tomorrow/i);
  assert.equal(notes.actionItems.length, 3);
  assert.equal(notes.actionItems[1].owner, "Dhruv");
  assert.equal(notes.actionItems[1].evidenceSegmentIds.length, 1);
  assert.equal(notes.actionItems[1].evidenceSegmentIds[0], normalized[2].id);
});

test("sanitizes raw transcript segments from a runner callback", () => {
  const result = sanitizeRawSegments([
    {
      id: "seg-a",
      speaker: "Speaker 1",
      start: "1.5",
      end: "3.5",
      text: "haan kal tak bhej dena",
      confidence: 0.92,
      lowConfidenceWords: [{ word: "bhej", confidence: 0.42 }],
      speakerHints: ["Sanya Malhotra", "", 42, "Dhruv Bakshi"]
    },
    {
      text: ""
    }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].start, 1.5);
  assert.equal(result.value[0].language, "multi");
  assert.deepEqual(result.value[0].lowConfidenceWords, [{ word: "bhej", confidence: 0.42 }]);
  assert.deepEqual(result.value[0].speakerHints, ["Sanya Malhotra", "Dhruv Bakshi"]);
});

test("recovers from a corrupted store file and survives a failed write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-notetaker-store-"));
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const storePath = join(dataDir, "meetings.json");
  await writeFile(storePath, "{ not valid json !!!", "utf8");

  const store = new JsonStore(storePath);
  await store.load();
  assert.deepEqual(store.listMeetings(), []);
  const backups = (await readdir(dataDir)).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);

  const meeting = await store.createMeeting({
    title: "Recovery check",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: new Date().toISOString(),
    consentMode: "host_confirmed",
    retentionDays: 30
  });

  // A transient write failure must reject the caller but not poison future writes.
  await chmod(dataDir, 0o500);
  await assert.rejects(store.updateMeeting(meeting.id, { statusMessage: "blocked write" }));
  await chmod(dataDir, 0o755);
  const updated = await store.updateMeeting(meeting.id, { statusMessage: "write works again" });
  assert.equal(updated.statusMessage, "write works again");
});

test("hashes and verifies passwords with scrypt, failing closed on tampering", async () => {
  const hash = await hashPassword("kal tak bhej dena 123");
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("kal tak bhej dena 123", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
  assert.equal(await verifyPassword("kal tak bhej dena 123", hash.slice(0, -4) + "AAAA"), false);
  assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
  assert.equal(await verifyPassword("anything", ""), false);
});

test("validates auth inputs and session cookie plumbing", () => {
  assert.equal(validateEmail("  Dhruv@Example.COM "), "dhruv@example.com");
  assert.equal(validateEmail("not-an-email"), "");
  assert.equal(validatePassword("short").ok, false);
  assert.equal(validatePassword("long enough password").ok, true);

  const token = generateSessionToken();
  assert.ok(token.length >= 40);
  assert.notEqual(generateSessionToken(), token);
  assert.equal(hashSessionToken(token).length, 64);

  const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);
  const parsed = parseCookies(`foo=bar; opennotetaker_session=${encodeURIComponent(token)}`);
  assert.equal(parsed.opennotetaker_session, token);
});

test("rate limiter blocks at the cap and frees after the window", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, max: 3 });
  const start = 1_000_000;
  assert.equal(limiter.consume("ip1", start).allowed, true);
  assert.equal(limiter.consume("ip1", start + 1000).allowed, true);
  assert.equal(limiter.consume("ip1", start + 2000).allowed, true);
  const blocked = limiter.consume("ip1", start + 3000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // A different key is unaffected; the same key frees once the window slides.
  assert.equal(limiter.consume("ip2", start + 3000).allowed, true);
  assert.equal(limiter.consume("ip1", start + 61_001).allowed, true);
});

test("users store enforces unique emails, session expiry, and hides password hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-notetaker-users-"));
  const store = new UsersStore(join(dir, "users.json"));
  await store.load();

  const user = await store.createUser({
    id: "user-1",
    email: "Dhruv@Example.com",
    name: "Dhruv",
    passwordHash: "scrypt$fake"
  });
  assert.equal(user.email, "dhruv@example.com");
  assert.equal(store.findUserByEmail("DHRUV@example.COM")?.id, "user-1");
  await assert.rejects(
    store.createUser({ id: "user-2", email: "dhruv@example.com", passwordHash: "x" }),
    /already exists/
  );

  const exposed = publicUser(store.getUser("user-1"));
  assert.equal(exposed.passwordHash, undefined);
  assert.deepEqual(exposed.settings.transcriptRecipients, []);

  const updated = await store.updateUser("user-1", { settings: { autoEmailTranscript: true } });
  assert.equal(updated.settings.autoEmailTranscript, true);
  assert.deepEqual(updated.settings.transcriptRecipients, []);

  const tokenHash = hashSessionToken(generateSessionToken());
  await store.createSession({ tokenHash, userId: "user-1", ttlMs: 1000, ip: "::1", userAgent: "test" });
  const now = Date.now();
  assert.equal(store.getSessionByTokenHash(tokenHash, now)?.userId, "user-1");
  assert.equal(store.getSessionByTokenHash(tokenHash, now + 2000), null);
  assert.equal(await store.pruneExpiredSessions(now + 2000), 1);
});

test("finds a same-slot recording to follow instead of sending a second bot", () => {
  const now = Date.parse("2026-07-02T10:00:00.000Z");
  const mine = {
    id: "m-b",
    ownerId: "bob",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-07-02T10:00:00Z"
  };
  const activePeer = {
    id: "m-a",
    ownerId: "alice",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-07-02T09:55:00Z",
    status: "recording"
  };

  assert.equal(findRecordingPeer([activePeer, mine], mine, now)?.id, "m-a");

  // Different URL, far-off slot, and follower meetings are never peers.
  assert.equal(findRecordingPeer([{ ...activePeer, meetUrl: "https://meet.google.com/zzz-zzzz-zzz" }, mine], mine, now), null);
  assert.equal(findRecordingPeer([{ ...activePeer, scheduledAt: "2026-07-02T08:00:00Z" }, mine], mine, now), null);
  assert.equal(findRecordingPeer([{ ...activePeer, followsMeetingId: "m-x" }, mine], mine, now), null);

  // A freshly completed recording still serves late joiners; a stale one does not.
  const completedPeer = { ...activePeer, status: "completed", updatedAt: new Date(now - 60_000).toISOString() };
  assert.equal(findRecordingPeer([completedPeer, mine], mine, now)?.id, "m-a");
  const stalePeer = { ...completedPeer, updatedAt: new Date(now - 7 * 60 * 60_000).toISOString() };
  assert.equal(findRecordingPeer([stalePeer, mine], mine, now), null);

  // Failed recordings are not followed: the second user's bot should try itself.
  assert.equal(findRecordingPeer([{ ...activePeer, status: "failed" }, mine], mine, now), null);
});

test("claims the oldest queued meeting and respects active leases", () => {
  const now = Date.parse("2026-07-02T10:00:00.000Z");
  const meetings = [
    { id: "m1", status: "completed", scheduledAt: "2026-07-02T08:00:00Z" },
    { id: "m2", status: "queued", scheduledAt: "2026-07-02T09:30:00Z" },
    { id: "m3", status: "queued", scheduledAt: "2026-07-02T09:00:00Z" },
    {
      id: "m4",
      status: "queued",
      scheduledAt: "2026-07-02T08:30:00Z",
      runner: buildLease("worker-a", now - 10_000, 120)
    }
  ];

  // m4 is oldest but actively claimed; m3 is the oldest unclaimed queued meeting.
  assert.equal(pickClaimableMeeting(meetings, now).id, "m3");

  // Once worker-a's lease expires, m4 becomes claimable again (and is oldest).
  const later = now + 121_000;
  assert.equal(pickClaimableMeeting(meetings, later).id, "m4");

  assert.equal(pickClaimableMeeting([{ id: "x", status: "recording" }], now), null);
});

test("releases dead claims and salvages dead recordings after lease expiry", () => {
  const now = Date.parse("2026-07-02T10:00:00.000Z");
  const lease = buildLease("worker-a", now, 120);
  assert.equal(lease.workerId, "worker-a");
  assert.equal(leaseExpired({ runner: lease }, now + 119_000), false);
  assert.equal(leaseExpired({ runner: lease }, now + 121_000), true);

  const renewed = renewLease(lease, now + 100_000, 120);
  assert.equal(leaseExpired({ runner: renewed }, now + 121_000), false);
  assert.equal(renewed.claimedAt, lease.claimedAt);

  const expired = now + 121_000;
  assert.equal(shouldReleaseClaim({ status: "queued", runner: lease }, expired), true);
  assert.equal(shouldReleaseClaim({ status: "queued", runner: lease }, now), false);
  assert.equal(shouldReleaseClaim({ status: "queued" }, expired), false);
  assert.equal(shouldSalvageRecording({ status: "recording", runner: lease }, expired), true);
  assert.equal(shouldSalvageRecording({ status: "recording", runner: lease }, now), false);
  // Pipeline states after transcript submission no longer depend on the worker.
  assert.equal(shouldSalvageRecording({ status: "transcribing", runner: lease }, expired), false);
});

test("parses AVFoundation audio devices and identifies loopback candidates", () => {
  const output = `
    [AVFoundation indev @ 0x1] AVFoundation video devices:
    [AVFoundation indev @ 0x1] [0] MacBook Pro Camera
    [AVFoundation indev @ 0x1] AVFoundation audio devices:
    [AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
    [AVFoundation indev @ 0x1] [1] BlackHole 2ch
  `;
  const devices = parseAvfoundationDevices(output);
  const selected = resolveAvfoundationAudioDevice(":1", devices);

  assert.equal(devices.audio.length, 2);
  assert.equal(selected.name, "BlackHole 2ch");
  assert.equal(looksLikeLoopbackDevice(selected.name), true);
  assert.equal(looksLikeLoopbackDevice(devices.audio[0].name), false);
});

test("configures Deepgram streaming for raw 16k linear PCM", () => {
  const client = new DeepgramStreamingClient({
    apiKey: "test-key",
    keyterms: ["Dhruv", "OpenNotetaker"]
  });
  const url = client.buildUrl();

  assert.equal(url.searchParams.get("encoding"), "linear16");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("channels"), "1");
  assert.deepEqual(url.searchParams.getAll("keyterm"), ["Dhruv", "OpenNotetaker"]);
  // 300ms endpointing by default: 100ms shredded Hinglish utterances into fragments.
  assert.equal(url.searchParams.get("endpointing"), "300");

  const overridden = new DeepgramStreamingClient({
    apiKey: "test-key",
    extraParams: { endpointing: "500" }
  });
  assert.equal(overridden.buildUrl().searchParams.get("endpointing"), "500");
});

test("splits Deepgram results into per-speaker segments using word-level diarization", () => {
  const payload = {
    type: "Results",
    is_final: true,
    start: 10,
    duration: 2.6,
    channel: {
      alternatives: [
        {
          transcript: "haan theek hai main bhej dunga",
          confidence: 0.9,
          words: [
            { word: "haan", punctuated_word: "Haan", start: 10, end: 10.4, confidence: 0.95, speaker: 0 },
            { word: "theek", punctuated_word: "theek", start: 10.4, end: 10.8, confidence: 0.92, speaker: 0 },
            { word: "hai", punctuated_word: "hai,", start: 10.8, end: 11, confidence: 0.9, speaker: 0 },
            { word: "main", punctuated_word: "main", start: 11.4, end: 11.8, confidence: 0.6, speaker: 1 },
            { word: "bhej", punctuated_word: "bhej", start: 11.8, end: 12.2, confidence: 0.88, speaker: 1 },
            { word: "dunga", punctuated_word: "dunga.", start: 12.2, end: 12.6, confidence: 0.91, speaker: 1 }
          ]
        }
      ]
    }
  };

  const segments = deepgramResultToSegments(payload);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, "Speaker 1");
  assert.equal(segments[0].text, "Haan theek hai,");
  assert.equal(segments[0].start, 10);
  assert.equal(segments[0].end, 11);
  assert.equal(segments[1].speaker, "Speaker 2");
  assert.equal(segments[1].text, "main bhej dunga.");
  assert.deepEqual(segments[1].lowConfidenceWords, [{ word: "main", confidence: 0.6 }]);

  // Reconnected sockets restart timestamps at zero; the offset restores meeting time.
  const offsetSegments = deepgramResultToSegments(payload, 100);
  assert.equal(offsetSegments[0].start, 110);
  assert.equal(offsetSegments[1].end, 112.6);

  assert.deepEqual(deepgramResultToSegments({ type: "Results", is_final: false }), []);
});

test("inspects Google Meet waiting-room and solo-call states correctly", () => {
  const bot = new MeetBrowserBot({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "OpenNotetaker",
    chromeLaunchMode: "rawcdp"
  });

  assert.equal(
    runInspectMeetingScript(bot, {
      body: "Please wait until a meeting host brings you into the call",
      buttons: ["Leave call"]
    }).status,
    "waiting_room"
  );

  assert.equal(
    runInspectMeetingScript(bot, {
      body: "Meeting details\nYour call is ending soon",
      buttons: ["Leave call", "Chat with everyone"]
    }).status,
    "ended"
  );

  assert.deepEqual(
    runInspectMeetingScript(bot, {
      body: "Meeting details\nExternal participants joined\n1\nOpenNotetaker - Recording\nChat with everyone",
      buttons: ["Leave call", "Chat with everyone", "Meeting details"]
    }),
    {
      status: "alone",
      participantCount: 1,
      body: "Meeting details\nExternal participants joined\n1\nOpenNotetaker - Recording\nChat with everyone"
    }
  );

  assert.equal(
    runInspectMeetingScript(bot, {
      body: "Meeting details\nExternal participants joined\n2\nDhruv\nOpenNotetaker - Recording\nChat with everyone",
      buttons: ["Leave call", "Chat with everyone", "Meeting details"]
    }).status,
    "admitted"
  );
});

test("prefers the People-panel roster over bare-number heuristics for the alone check", () => {
  const bot = new MeetBrowserBot({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "OpenNotetaker",
    chromeLaunchMode: "rawcdp"
  });

  const rosterSelectors = (names) => ({
    '[role="list"][aria-label*="articipant" i]': [
      fakeElement({
        selectors: {
          '[role="listitem"]': names.map((name) => fakeElement({ ariaLabel: name }))
        }
      })
    ]
  });

  // A stray "1" in the page text (chat message, badge) must not read as "alone" when
  // the roster clearly shows two participants.
  assert.equal(
    runInspectMeetingScript(bot, {
      body: "Meeting details\n1\nChat with everyone",
      buttons: ["Leave call", "Chat with everyone"],
      selectors: rosterSelectors(["Dhruv Bakshi", "OpenNotetaker - Recording"])
    }).status,
    "admitted"
  );

  assert.equal(
    runInspectMeetingScript(bot, {
      body: "Meeting details\nChat with everyone",
      buttons: ["Leave call", "Chat with everyone"],
      selectors: rosterSelectors(["OpenNotetaker - Recording"])
    }).status,
    "alone"
  );
});

test("collects participant names and the caption speaker from the Meet UI", () => {
  const bot = new MeetBrowserBot({
    meetUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "OpenNotetaker",
    chromeLaunchMode: "rawcdp"
  });

  const signals = runCollectSignalsScript(bot, {
    selectors: {
      '[role="list"][aria-label*="articipant" i]': [
        fakeElement({
          selectors: {
            '[role="listitem"]': [
              fakeElement({ ariaLabel: "Dhruv Bakshi" }),
              fakeElement({ ariaLabel: "Sanya Malhotra" }),
              fakeElement({ ariaLabel: "OpenNotetaker - Recording" }),
              fakeElement({ ariaLabel: "42" })
            ]
          }
        })
      ],
      '[jsname="dsyhDe"], [aria-label*="aption" i][role="region"], .a4cQT': [
        fakeElement({
          selectors: {
            '[class*="NWpY1d"], [class*="zs7s8d"], [class*="name" i]': [
              fakeElement({ text: "Dhruv Bakshi" }),
              fakeElement({ text: "Sanya Malhotra" })
            ]
          }
        })
      ]
    }
  });

  assert.deepEqual(signals.participants, ["Dhruv Bakshi", "Sanya Malhotra", "OpenNotetaker - Recording"]);
  assert.equal(signals.captionSpeaker, "Sanya Malhotra");
  assert.deepEqual(signals.activeSpeakers, ["Sanya Malhotra"]);
  assert.equal(signals.participantCount, 3);
});

test("Gemini provider requests structured JSON and parses model output", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      segments: [
                        {
                          id: "seg-a",
                          speaker: "Speaker 1",
                          start: 1,
                          end: 2,
                          raw: "haan kal tak",
                          english: "Yes, by tomorrow.",
                          confidence: "high",
                          uncertainTerms: []
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test" });
    const result = await provider.normalizeSegments([
      { id: "seg-a", speaker: "Speaker 1", start: 1, end: 2, text: "haan kal tak" }
    ]);

    assert.equal(result[0].english, "Yes, by tomorrow.");
    assert.match(request.url, /models\/gemini-test:generateContent$/);
    assert.equal(request.options.headers["X-goog-api-key"], "test-key");
    const body = JSON.parse(request.options.body);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini provider normalizes long transcripts in chunks", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    const segments = payload.segments;
    requests.push({
      ids: segments.map((segment) => segment.id),
      contextTexts: (payload.context || []).map((segment) => segment.text)
    });
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      segments: segments.map((segment) => ({
                        id: segment.id,
                        speaker: segment.speaker,
                        start: segment.start,
                        end: segment.end,
                        raw: segment.text,
                        english: `English ${segment.id}`,
                        confidence: "high",
                        uncertainTerms: []
                      }))
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-test",
      normalizeChunkSize: 2
    });
    const result = await provider.normalizeSegments([
      { id: "seg-1", speaker: "Speaker 1", start: 1, end: 2, text: "one" },
      { id: "seg-2", speaker: "Speaker 1", start: 2, end: 3, text: "two" },
      { id: "seg-3", speaker: "Speaker 2", start: 3, end: 4, text: "three" },
      { id: "seg-4", speaker: "Speaker 2", start: 4, end: 5, text: "four" },
      { id: "seg-5", speaker: "Speaker 1", start: 5, end: 6, text: "five" }
    ]);

    assert.deepEqual(requests.map((request) => request.ids), [["seg-1", "seg-2"], ["seg-3", "seg-4"], ["seg-5"]]);
    // Later chunks carry the tail of the previous chunk as read-only context so
    // Hinglish disambiguation ("kal", pronouns) does not reset at chunk boundaries.
    assert.deepEqual(requests[0].contextTexts, []);
    assert.deepEqual(requests[1].contextTexts, ["one", "two"]);
    assert.deepEqual(requests[2].contextTexts, ["three", "four"]);
    assert.deepEqual(result.map((segment) => segment.id), ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini provider audits action items against the transcript", async () => {
  const originalFetch = globalThis.fetch;
  let prompt;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    prompt = body.contents[0].parts[0].text;
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      actionItems: [
                        {
                          task: "Ship the landing page.",
                          owner: "Sanya Malhotra",
                          due: "Tomorrow",
                          evidenceTimestamp: "00:05",
                          evidenceSegmentIds: ["seg-1"]
                        },
                        {
                          task: "Share Stripe logs.",
                          owner: "  ",
                          due: "",
                          evidenceTimestamp: "00:12",
                          evidenceSegmentIds: ["seg-4"]
                        }
                      ],
                      warnings: ["Added missed commitment: Share Stripe logs."]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test" });
    const verified = await provider.verifyActionItems(
      {
        transcript: { turns: [] },
        notes: {
          actionItems: [
            {
              task: "Ship the landing page.",
              owner: "Sanya Malhotra",
              due: "Tomorrow",
              evidenceTimestamp: "00:05",
              evidenceSegmentIds: ["seg-1"]
            }
          ]
        }
      },
      { participants: ["Sanya Malhotra", "Dhruv Bakshi"] }
    );

    assert.match(prompt, /auditing extracted meeting action items/i);
    assert.match(prompt, /Known meeting participants from the Google Meet roster: Sanya Malhotra, Dhruv Bakshi/);
    assert.equal(verified.actionItems.length, 2);
    assert.equal(verified.actionItems[1].owner, "Unknown");
    assert.equal(verified.actionItems[1].due, "Not stated");
    assert.deepEqual(verified.warnings, ["Added missed commitment: Share Stripe logs."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repairs malformed action item audits by falling back to the original list", () => {
  const fallback = [{ task: "Keep me", owner: "Dhruv", due: "Friday", evidenceTimestamp: "00:01", evidenceSegmentIds: [] }];
  assert.deepEqual(repairActionItems({ nonsense: true }, fallback).actionItems, fallback);
  assert.deepEqual(repairActionItems(null, fallback).actionItems, fallback);
  const repaired = repairActionItems({ actionItems: [{ task: "  ", owner: "x" }, { task: "Real", evidenceSegmentIds: "bad" }] }, fallback);
  assert.equal(repaired.actionItems.length, 1);
  assert.equal(repaired.actionItems[0].task, "Real");
  assert.deepEqual(repaired.actionItems[0].evidenceSegmentIds, []);
});

test("Gemini provider reconstructs speaker roles in chunks", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    assert.match(prompt, /Every turn\.text value must be written in clean English/);
    requests.push({
      ids: payload.segments.map((segment) => segment.id),
      existingRoles: payload.existingRoles,
      segments: payload.segments
    });

    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      roles: [
                        {
                          id: "vendor",
                          label: "Ostrya / Sanya",
                          description: "Vendor side explaining scope and pricing."
                        },
                        {
                          id: "client",
                          label: "Client / Satyam",
                          description: "Client side asking questions and confirming terms."
                        }
                      ],
                      turns: payload.segments.map((segment, index) => ({
                        id: `chunk-${payload.chunkIndex}-${index}`,
                        role: index % 2 === 0 ? "vendor" : "client",
                        start: segment.start,
                        end: segment.end,
                        text: `Clean turn for ${segment.id}`,
                        sourceSegmentIds: [segment.id],
                        confidence: "high",
                        flags: []
                      })),
                      warnings: payload.chunkIndex === 2 ? ["Pricing conflict preserved."] : []
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-test",
      reconstructChunkSize: 8
    });
    const result = await provider.reconstructTranscript(
      Array.from({ length: 17 }, (_, index) => ({
        id: `seg-${index + 1}`,
        speaker: `Speaker ${(index % 3) + 1}`,
        start: index + 1,
        end: index + 2,
        english: `segment ${index + 1}`
      }))
    );

    assert.deepEqual(requests.map((request) => request.ids), [
      ["seg-1", "seg-2", "seg-3", "seg-4", "seg-5", "seg-6", "seg-7", "seg-8"],
      ["seg-9", "seg-10", "seg-11", "seg-12", "seg-13", "seg-14", "seg-15", "seg-16"],
      ["seg-17"]
    ]);
    assert.equal(requests[0].existingRoles.length, 0);
    assert.equal(requests[0].segments[0].english, "segment 1");
    assert.equal(Object.hasOwn(requests[0].segments[0], "raw"), false);
    assert.equal(requests[1].existingRoles[0].label, "Ostrya / Sanya");
    assert.deepEqual(result.roles.map((role) => role.label), ["Ostrya / Sanya", "Client / Satyam"]);
    assert.equal(result.turns[0].id, "turn_0001");
    assert.equal(result.turns[0].role, "Ostrya / Sanya");
    assert.equal(result.turns[1].role, "Client / Satyam");
    assert.deepEqual(result.warnings, ["Pricing conflict preserved."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini provider retries a transient timeout and then succeeds", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const abort = new Error("The operation was aborted.");
      abort.name = "AbortError";
      throw abort;
    }
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      segments: [
                        {
                          id: "seg-a",
                          speaker: "Speaker 1",
                          start: 1,
                          end: 2,
                          raw: "x",
                          english: "Recovered after a retry.",
                          confidence: "high",
                          uncertainTerms: []
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test", maxRetries: 2 });
    const result = await provider.normalizeSegments([
      { id: "seg-a", speaker: "Speaker 1", start: 1, end: 2, text: "x" }
    ]);
    assert.equal(calls, 2, "the first call times out and the second succeeds");
    assert.equal(result[0].english, "Recovered after a retry.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini provider does not retry a non-retryable 4xx", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      async text() {
        return "invalid argument";
      }
    };
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test", maxRetries: 3 });
    await assert.rejects(
      provider.normalizeSegments([{ id: "seg-a", speaker: "Speaker 1", start: 1, end: 2, text: "x" }]),
      /Gemini request failed with 400/
    );
    assert.equal(calls, 1, "a 400 is fatal — no retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini reconstruct degrades a failed chunk to passthrough instead of failing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    // The chunk containing seg-1 always times out; every other chunk succeeds.
    if (payload.segments.some((segment) => segment.id === "seg-1")) {
      const abort = new Error("The operation was aborted.");
      abort.name = "AbortError";
      throw abort;
    }
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      roles: [{ id: "r1", label: "Role One", description: "" }],
                      turns: payload.segments.map((segment) => ({
                        id: `t-${segment.id}`,
                        role: "Role One",
                        start: segment.start,
                        end: segment.end,
                        text: `Clean ${segment.id}`,
                        sourceSegmentIds: [segment.id],
                        confidence: "high",
                        flags: []
                      })),
                      warnings: []
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    // reconstructChunkSize floors at 8, so 16 segments make exactly two chunks: the
    // first (seg-1..seg-8) always times out, the second (seg-9..seg-16) succeeds.
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-test",
      reconstructChunkSize: 8,
      maxRetries: 0
    });
    const segments = Array.from({ length: 16 }, (_, index) => ({
      id: `seg-${index + 1}`,
      speaker: `Speaker ${(index % 2) + 1}`,
      start: index + 1,
      end: index + 2,
      english: `english ${index + 1}`
    }));

    const result = await provider.reconstructTranscript(segments);

    // All sixteen segments survive as turns even though the first chunk's LLM call failed.
    assert.equal(result.turns.length, 16);
    const texts = result.turns.map((turn) => turn.text);
    assert.ok(texts.includes("english 1"), "the failed chunk falls back to the normalized text");
    assert.ok(texts.includes("Clean seg-9"), "the healthy chunk keeps its repaired text");
    assert.ok(result.warnings.some((warning) => /reconstruction was skipped/i.test(warning)));
    assert.ok(result.turns.some((turn) => turn.flags.includes("reconstruction_skipped")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pipeline still produces notes when speaker reconstruction throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-notetaker-pipeline-"));
  const storePath = join(dir, "data", "meetings.json");
  const store = new JsonStore(storePath);
  await store.load();
  const meeting = await store.createMeeting({
    title: "Reconstruct failure",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: new Date().toISOString(),
    consentMode: "host_confirmed",
    retentionDays: 30
  });

  // A provider whose reconstruction pass fails hard (e.g. an unrecoverable LLM error):
  // the meeting must still complete from the normalized transcript rather than fail.
  const failingReconstructProvider = {
    async normalizeSegments(rawSegments) {
      return rawSegments.map((segment) => ({
        id: segment.id,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
        raw: segment.text,
        english: `English ${segment.id}`,
        confidence: "high",
        uncertainTerms: []
      }));
    },
    async reconstructTranscript() {
      throw new Error("reconstruction unavailable");
    },
    async extractNotes() {
      return {
        summary: "A short meeting.",
        detailedNotes: ["Something was discussed."],
        decisions: [],
        actionItems: [{ task: "Follow up", owner: "Unknown", due: "Not stated", evidenceSegmentIds: [] }],
        openQuestions: [],
        risks: []
      };
    },
    async verifyActionItems({ notes }) {
      return { actionItems: notes.actionItems, warnings: [] };
    }
  };

  const completed = await processRawSegments({
    meeting,
    store,
    llmProvider: failingReconstructProvider,
    rawSegments: [
      { id: "seg-1", speaker: "Speaker 1", start: 0, end: 2, text: "haan kal tak" },
      { id: "seg-2", speaker: "Speaker 2", start: 2, end: 4, text: "theek hai" }
    ]
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.artifacts.notes.actionItems.length, 1);
  // Re-read the meeting: processRawSegments returns the snapshot taken just before the
  // final notes.ready event is appended.
  const events = store.getMeeting(meeting.id).events.map((event) => event.type);
  assert.ok(events.includes("transcript.reconstruct_failed"), "the degradation is recorded as an event");
  assert.ok(events.includes("notes.ready"));
});

test("re-finalizing an unchanged transcript reuses the stored normalization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "open-notetaker-reuse-"));
  const store = new JsonStore(join(dir, "data", "meetings.json"));
  await store.load();
  const meeting = await store.createMeeting({
    title: "Reuse normalization",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: new Date().toISOString(),
    consentMode: "host_confirmed",
    retentionDays: 30
  });
  const rawSegments = [
    { id: "seg-1", speaker: "Speaker 1", start: 0, end: 2, text: "haan kal tak" },
    { id: "seg-2", speaker: "Speaker 2", start: 2, end: 4, text: "theek hai" }
  ];
  // A previous successful normalization is already stored for exactly these segments.
  await store.updateMeeting(meeting.id, {
    artifacts: {
      normalizedSegments: rawSegments.map((segment) => ({
        id: segment.id,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
        raw: segment.text,
        english: `English ${segment.id}`,
        confidence: "high",
        uncertainTerms: []
      }))
    }
  });

  const provider = {
    async normalizeSegments() {
      throw new Error("normalization must not run when a valid one is already stored");
    },
    async reconstructTranscript(segments) {
      return {
        roles: [],
        turns: segments.map((segment, index) => ({
          id: `turn-${index}`,
          role: "Role",
          start: segment.start,
          end: segment.end,
          text: segment.english || segment.text || "",
          sourceSegmentIds: [segment.id],
          confidence: "medium",
          flags: []
        })),
        warnings: []
      };
    },
    async extractNotes() {
      return { summary: "S", detailedNotes: [], decisions: [], actionItems: [], openQuestions: [], risks: [] };
    },
    async verifyActionItems({ notes }) {
      return { actionItems: notes.actionItems, warnings: [] };
    }
  };

  const completed = await processRawSegments({ meeting, store, llmProvider: provider, rawSegments });
  assert.equal(completed.status, "completed");
  const events = store.getMeeting(meeting.id).events.map((event) => event.type);
  assert.ok(events.includes("transcript.normalized"));
  const normalizedEvent = store
    .getMeeting(meeting.id)
    .events.find((event) => event.type === "transcript.normalized");
  assert.match(normalizedEvent.message, /Reused the existing English normalization/);
});

test("Gemini extracts notes in one call for a short meeting", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "Short meeting.",
                      detailedNotes: ["One note."],
                      decisions: [],
                      actionItems: [],
                      openQuestions: [],
                      risks: []
                    })
                  }
                ]
              }
            }
          ]
        };
      }
    };
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test" });
    const notes = await provider.extractNotes({
      roles: [],
      turns: Array.from({ length: 5 }, (_, index) => ({ id: `turn-${index}`, text: `line ${index}` }))
    });
    assert.equal(calls, 1, "a short meeting is a single notes call");
    assert.equal(notes.summary, "Short meeting.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini extracts notes by map-reduce for a long meeting and dedupes across chunks", async () => {
  const originalFetch = globalThis.fetch;
  let mapCalls = 0;
  let reduceCalls = 0;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const okJson = (value) => ({
      ok: true,
      async json() {
        return { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] };
      }
    });

    if (/ordered section summaries/i.test(prompt)) {
      reduceCalls += 1;
      const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
      assert.ok(Array.isArray(payload.sectionSummaries) && payload.sectionSummaries.length > 1);
      return okJson({ summary: "One combined summary." });
    }

    mapCalls += 1;
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    const firstId = (payload.turns || payload.segments || [])[0]?.id;
    return okJson({
      summary: `Section ${firstId}`,
      detailedNotes: [`Detail ${firstId}`, "Shared detail"],
      decisions: ["Shared decision"],
      actionItems: [
        { task: `Task ${firstId}`, owner: "Unknown", due: "Not stated", evidenceSegmentIds: [] },
        { task: "Shared task", owner: "Unknown", due: "Not stated", evidenceSegmentIds: [] }
      ],
      openQuestions: [],
      risks: []
    });
  };

  try {
    const provider = new GeminiProvider({ apiKey: "test-key", model: "gemini-test", notesChunkSize: 40 });
    const turns = Array.from({ length: 90 }, (_, index) => ({ id: `seg-${index + 1}`, text: `line ${index + 1}` }));
    const notes = await provider.extractNotes({ roles: [], turns });

    assert.equal(mapCalls, 3, "90 turns at chunk size 40 → three map calls");
    assert.equal(reduceCalls, 1, "one summary reduction call");
    assert.equal(notes.summary, "One combined summary.");
    // List fields are concatenated across chunks and de-duplicated.
    assert.deepEqual(notes.decisions, ["Shared decision"]);
    assert.equal(notes.detailedNotes.filter((note) => note === "Shared detail").length, 1);
    assert.equal(notes.actionItems.filter((item) => item.task === "Shared task").length, 1);
    assert.deepEqual(
      notes.actionItems.map((item) => item.task).filter((task) => task.startsWith("Task ")),
      ["Task seg-1", "Task seg-41", "Task seg-81"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repairs reconstructed transcript role ids and unsafe values", () => {
  const repaired = repairReconstructedTranscript({
    roles: [{ id: "vendor", label: "Ostrya / Sanya" }],
    turns: [
      {
        role: "vendor",
        start: 10,
        end: 5,
        text: "Proposal terms were discussed.",
        confidence: "certain"
      }
    ],
    warnings: ["  Keep scope conflict visible.  "]
  });

  assert.equal(repaired.turns[0].role, "Ostrya / Sanya");
  assert.equal(repaired.turns[0].end, 10);
  assert.equal(repaired.turns[0].confidence, "medium");
  assert.deepEqual(repaired.warnings, ["Keep scope conflict visible."]);
});

test("mock notes extraction accepts reconstructed transcript turns", async () => {
  const provider = new MockLlmProvider();
  const notes = await provider.extractNotes({
    turns: [
      {
        start: 2,
        text: "Please send the first version of the landing page by tomorrow."
      },
      {
        start: 8,
        text: "Dhruv should share logs by tomorrow evening."
      }
    ]
  });

  assert.equal(notes.actionItems.length, 2);
  assert.equal(notes.actionItems[0].evidenceTimestamp, "00:02");
  assert.equal(notes.actionItems[1].owner, "Dhruv");
});

test("Gmail MIME messages are header-safe and base64url encoded", () => {
  const message = createMimeMessage({
    to: "dhruv@example.com\nBcc: attacker@example.com",
    from: "dhruv@example.com",
    subject: "Transcript\nInjected",
    text: "Meeting notes"
  });
  const encoded = encodeBase64Url(message);

  assert.match(message, /^To: dhruv@example.com Bcc: attacker@example.com$/m);
  assert.match(message, /^Subject: Transcript Injected$/m);
  assert.doesNotMatch(encoded, /[+/=]/);
  assert.equal(sanitizeEmailAddress("bad\n@example.com"), "");
});

test("Gmail MIME messages include an HTML alternative when provided", () => {
  const message = createMimeMessage({
    to: "dhruv@example.com",
    from: "notes@example.com",
    subject: "Transcript",
    text: "Plain transcript",
    html: "<p>Readable transcript</p>",
    boundary: "test-boundary"
  });

  assert.match(message, /Content-Type: multipart\/alternative; boundary="test-boundary"/);
  assert.match(message, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(message, /Plain transcript/);
  assert.match(message, /Content-Type: text\/html; charset="UTF-8"/);
  assert.match(message, /<p>Readable transcript<\/p>/);
  assert.match(message, /--test-boundary--/);
});

test("formats transcript email with English transcript sections by default", () => {
  const body = formatTranscriptEmail({
    id: "meeting-1",
    title: "Product sync",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-06-28T10:00:00.000Z",
    artifacts: {
      notes: {
        summary: "The team discussed launch work.",
        actionItems: [
          {
            task: "Ship the landing page.",
            owner: "Dhruv",
            due: "Tomorrow",
            evidenceTimestamp: "00:05"
          }
        ],
        decisions: ["Keep the first version simple."],
        openQuestions: [],
        risks: []
      },
      normalizedSegments: [
        {
          speaker: "Speaker 1",
          start: 1,
          end: 3,
          english: "Please send this by tomorrow."
        }
      ],
      reconstructedTranscript: {
        roles: [
          {
            id: "vendor",
            label: "Vendor",
            description: "Person assigning follow-up work."
          },
          {
            id: "client",
            label: "Client",
            description: "Person receiving the follow-up."
          }
        ],
        turns: [
          {
            role: "Vendor",
            start: 1,
            end: 3,
            text: "Please send this by tomorrow.",
            confidence: "high",
            flags: ["speaker repaired"]
          }
        ],
        warnings: ["Deepgram speaker labels were weak evidence."]
      },
      rawSegments: [
        {
          speaker: "Speaker 1",
          start: 1,
          end: 3,
          text: "kal tak bhej dena"
        }
      ]
    }
  });

  assert.match(body, /SUMMARY\nThe team discussed launch work\./);
  assert.match(body, /ACTION ITEMS\n1\. Ship the landing page\./);
  assert.match(body, /ENGLISH ROLE-CORRECTED TRANSCRIPT\nParticipants:\n- Vendor: Person assigning follow-up work\./);
  assert.match(body, /\[00:01-00:03\] Vendor \(speaker repaired\): Please send this by tomorrow\./);
  assert.match(body, /CLEAN ENGLISH TRANSCRIPT\n\[00:01-00:03\] Speaker 1: Please send this by tomorrow\./);
  assert.doesNotMatch(body, /RAW TRANSCRIPT/);
  assert.doesNotMatch(body, /kal tak bhej dena/);
});

test("formats transcript email with raw evidence only when explicitly requested", () => {
  const body = formatTranscriptEmail(
    {
      id: "meeting-1",
      title: "Product sync",
      meetUrl: "https://meet.google.com/abc-defg-hij",
      scheduledAt: "2026-06-28T10:00:00.000Z",
      artifacts: {
        notes: {
          summary: "The team discussed launch work.",
          actionItems: [],
          decisions: [],
          openQuestions: [],
          risks: []
        },
        normalizedSegments: [],
        reconstructedTranscript: null,
        rawSegments: [
          {
            speaker: "Speaker 1",
            start: 1,
            end: 3,
            text: "kal tak bhej dena"
          }
        ]
      }
    },
    { includeRawEvidence: true }
  );

  assert.match(body, /RAW TRANSCRIPT EVIDENCE\n\[00:01-00:03\] Speaker 1: kal tak bhej dena/);
});

test("formats transcript HTML email with escaped meeting and transcript fields", () => {
  const html = formatTranscriptEmailHtml({
    id: "meeting-1",
    title: "<script>alert(1)</script>",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    scheduledAt: "2026-06-28T10:00:00.000Z",
    artifacts: {
      notes: {
        summary: "Summary with <b>markup</b>.",
        actionItems: [
          {
            task: "Send 5 > 3 confirmation.",
            owner: "Dhruv & team",
            due: "Tomorrow",
            evidenceTimestamp: "00:05"
          }
        ],
        decisions: ["Use <unsafe> content literally."],
        openQuestions: [],
        risks: []
      },
      reconstructedTranscript: {
        roles: [
          {
            label: "Vendor <Sanya>",
            description: "Explains scope & pricing."
          }
        ],
        turns: [
          {
            role: "Vendor <Sanya>",
            start: 1,
            end: 3,
            text: "This has 5 > 3 and & symbols.",
            confidence: "high",
            flags: ["speaker <repair>"]
          }
        ],
        warnings: ["Check <scope> conflict."]
      },
      normalizedSegments: [],
      rawSegments: []
    }
  });

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Summary with &lt;b&gt;markup&lt;\/b&gt;\./);
  assert.match(html, /Dhruv &amp; team/);
  assert.match(html, /5 &gt; 3/);
  assert.match(html, /speaker &lt;repair&gt;/);
  assert.match(html, /English Role-Corrected Transcript/);
  assert.doesNotMatch(html, /Raw Transcript Evidence/);
});

test("extracts Google Meet links from Calendar event conference data and text fields", () => {
  assert.equal(
    extractGoogleMeetUrl({
      conferenceData: {
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij?authuser=0" }]
      }
    }),
    "https://meet.google.com/abc-defg-hij?authuser=0"
  );

  assert.equal(
    extractGoogleMeetUrl({
      description: "Join here: https://meet.google.com/xyz-abcd-efg."
    }),
    "https://meet.google.com/xyz-abcd-efg"
  );
});

test("detects Calendar read-only scope on saved Google OAuth tokens", () => {
  assert.equal(
    tokenHasScope(
      {
        scope: `https://www.googleapis.com/auth/gmail.send ${CALENDAR_READONLY_SCOPE}`
      },
      CALENDAR_READONLY_SCOPE
    ),
    true
  );

  assert.equal(tokenHasScope({ scope: "https://www.googleapis.com/auth/gmail.send" }, CALENDAR_READONLY_SCOPE), false);
});

function runInspectMeetingScript(bot, { body, buttons, selectors = {} }) {
  const document = fakeDocument({ body, buttons, selectors });
  return Function("document", `"use strict"; return (${bot.inspectMeetingScript()});`)(document);
}

function runCollectSignalsScript(bot, { selectors = {} } = {}) {
  const document = fakeDocument({ body: "", buttons: [], selectors });
  return Function("document", `"use strict"; return (${bot.collectSignalsScript()});`)(document);
}

function fakeDocument({ body, buttons, selectors }) {
  return {
    body: { innerText: body },
    querySelector: (selector) => selectors[selector]?.[0] ?? null,
    querySelectorAll: (selector) => {
      if (selector === "button") {
        return buttons.map((label) => ({
          innerText: label,
          getAttribute: (name) => (name === "aria-label" ? label : "")
        }));
      }
      return selectors[selector] ?? [];
    }
  };
}

function fakeElement({ ariaLabel = "", text = "", attrs = {}, selectors = {} } = {}) {
  return {
    getAttribute: (name) => (name === "aria-label" ? ariaLabel : attrs[name] ?? null),
    textContent: text,
    innerText: text,
    querySelector: (selector) => selectors[selector]?.[0] ?? null,
    querySelectorAll: (selector) => selectors[selector] ?? []
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
