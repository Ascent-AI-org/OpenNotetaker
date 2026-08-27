const MEET_HOSTS = new Set(["meet.google.com"]);
const MEET_SCHEMES = new Set(["https:", "http:"]);

export function validateMeetingInput(input) {
  const errors = {};

  const title = cleanString(input?.title);
  if (!title || title.length < 2 || title.length > 120) {
    errors.title = "Use a title between 2 and 120 characters.";
  }

  const meetUrl = cleanString(input?.meetUrl);
  if (!isGoogleMeetUrl(meetUrl)) {
    errors.meetUrl = "Use a valid Google Meet URL.";
  }

  const scheduledAt = cleanString(input?.scheduledAt);
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
    errors.scheduledAt = "Use a valid date/time.";
  }

  const consentMode = cleanString(input?.consentMode) || "host_confirmed";
  if (!["host_confirmed", "all_participants", "internal_policy"].includes(consentMode)) {
    errors.consentMode = "Choose a supported consent mode.";
  }

  const retentionDays = Number.parseInt(input?.retentionDays ?? "30", 10);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    errors.retentionDays = "Retention must be between 1 and 365 days.";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      title,
      meetUrl,
      scheduledAt: scheduledAt || new Date().toISOString(),
      consentMode,
      retentionDays
    }
  };
}

export function isGoogleMeetUrl(value) {
  try {
    const url = new URL(value);
    // Pin the scheme: the hostname check alone accepts anything the URL parser will
    // take, and this value is later handed to a browser to navigate to and rendered
    // as an href in the dashboard.
    if (!MEET_SCHEMES.has(url.protocol)) return false;
    if (!MEET_HOSTS.has(url.hostname)) return false;
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function sanitizeRawSegments(value) {
  if (!Array.isArray(value)) {
    return { ok: false, error: "rawSegments must be an array." };
  }
  if (value.length > 20_000) {
    return { ok: false, error: "rawSegments is too large." };
  }

  const segments = [];
  for (const [index, segment] of value.entries()) {
    const text = cleanString(segment?.text || segment?.raw);
    if (!text) continue;

    const start = toFiniteNumber(segment?.start, 0);
    const end = toFiniteNumber(segment?.end, start);
    segments.push({
      id: cleanString(segment?.id) || crypto.randomUUID(),
      speaker: cleanString(segment?.speaker) || "Speaker Unknown",
      start,
      end: end >= start ? end : start,
      text: text.slice(0, 5000),
      language: cleanString(segment?.language) || "multi",
      confidence: clamp(toFiniteNumber(segment?.confidence, 0), 0, 1),
      lowConfidenceWords: sanitizeLowConfidenceWords(segment?.lowConfidenceWords),
      speakerHints: sanitizeSpeakerHints(segment?.speakerHints),
      sequence: index
    });
  }

  return { ok: true, value: segments };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSpeakerHints(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 5)
    .map((item) => cleanString(item).slice(0, 80))
    .filter(Boolean);
}

function sanitizeLowConfidenceWords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20)
    .map((item) => ({
      word: cleanString(item?.word).slice(0, 100),
      confidence: clamp(toFiniteNumber(item?.confidence, 0), 0, 1)
    }))
    .filter((item) => item.word);
}

/**
 * A capture-start timestamp reported by a recording worker.
 *
 * The worker's clock, not this server's, so it is validated rather than trusted: an
 * authenticated runner is still a separate machine, and a skewed or malformed value would
 * silently corrupt the video's retention anchor — the stamp that decides when a recording
 * of someone's face gets deleted. Anything that is not a sane past instant falls back to
 * now, which is what this stamped before workers reported it at all.
 */
export function sanitizeCaptureStart(value, { maxAgeMs = 3 * 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  const parsed = Date.parse(value || "");
  const fallback = new Date(nowMs).toISOString();
  if (!Number.isFinite(parsed)) return fallback;
  // A capture cannot have begun after it was reported, so a future stamp is a broken clock.
  if (parsed > nowMs) return fallback;
  if (nowMs - parsed > maxAgeMs) return fallback;
  return new Date(parsed).toISOString();
}
