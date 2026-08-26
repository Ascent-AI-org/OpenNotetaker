// Range parsing for video playback. A <video> element scrubs by asking for byte ranges;
// answer every request with 200 and the whole file and the player has to re-download
// from zero on each drag of the scrubber, which on a two-hour recording is unusable.
//
// A Range header is attacker-controlled text that arrives before any auth decision has
// been rendered into bytes, so nothing here throws: garbage resolves to null (serve the
// whole file) or to unsatisfiable (416). A malformed Range must never become a 500.
const RANGE_SPEC = /^(\d*)-(\d*)$/u;

export function parseRangeHeader(header, size) {
  if (typeof header !== "string") return null;
  if (!Number.isSafeInteger(size) || size < 0) return null;

  const value = header.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return null;

  const spec = value.slice("bytes=".length).trim();
  // A multi-range answer has to be a multipart/byteranges body. Serving only the first
  // range under a 206 looks like it works until a player asks for two and silently gets
  // half its data, so decline the whole header instead: falling back to the full file is
  // always a legal answer to a Range a server chooses not to honour. Duplicate Range
  // headers, which Node joins with ", ", land here too and get the same treatment.
  if (spec.includes(",")) return null;

  const match = RANGE_SPEC.exec(spec);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    // Suffix form: the last N bytes, which is how players read an MP4's trailing moov
    // atom before they can seek at all. "bytes=-0" asks for nothing and is unsatisfiable
    // rather than an empty 206 — there is no such thing as a zero-length range.
    const suffix = toInteger(rawEnd);
    if (suffix === 0 || size === 0) return { unsatisfiable: true };
    return { start: suffix >= size ? 0 : size - suffix, end: size - 1 };
  }

  const start = toInteger(rawStart);
  // Answering 200 to a start past the end of the file makes a seeking player restart the
  // download from byte zero; 416 tells it the file shrank and to re-read the length.
  if (start >= size) return { unsatisfiable: true };

  if (!rawEnd) return { start, end: size - 1 };

  const end = toInteger(rawEnd);
  if (end < start) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

// The grammar allows an arbitrarily long digit run, and Number() turns one into an
// imprecise double. Pinning those to MAX_SAFE_INTEGER keeps the comparisons above
// meaningful — a start that large is past any real file, an end that large clamps.
function toInteger(digits) {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}
