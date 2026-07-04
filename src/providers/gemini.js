import {
  ACTION_ITEMS_VERIFICATION_SCHEMA,
  NORMALIZE_INSTRUCTIONS,
  NORMALIZED_SEGMENTS_SCHEMA,
  NOTES_INSTRUCTIONS,
  NOTES_SCHEMA,
  RECONSTRUCT_INSTRUCTIONS,
  RECONSTRUCTED_TRANSCRIPT_SCHEMA,
  VERIFY_ACTION_ITEMS_INSTRUCTIONS,
  participantsNote,
  prepareReconstructionSegments,
  repairActionItems,
  repairReconstructedTranscript
} from "./openai.js";

// Hinglish disambiguation is context-dependent ("kal", pronoun references), so each
// normalization chunk carries the tail of the previous chunk as read-only context.
const NORMALIZE_CONTEXT_SEGMENTS = 3;

// Used to fold per-chunk summaries of a long meeting into a single summary.
const SUMMARY_REDUCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } }
};

const SUMMARY_REDUCE_INSTRUCTIONS =
  "These are ordered section summaries of one long meeting. Combine them into a single, concise summary " +
  "(3-6 sentences) covering the main topics, decisions, and outcomes in chronological order. " +
  "Do not add any facts that are not present in the section summaries.";

export class GeminiProvider {
  constructor({
    apiKey,
    model,
    normalizeChunkSize = 18,
    reconstructChunkSize = 48,
    notesChunkSize = 200,
    requestTimeoutMs = 90_000,
    maxRetries = 2
  }) {
    if (!apiKey) throw new Error("GeminiProvider requires an API key.");
    this.apiKey = apiKey;
    this.model = model || "gemini-3-flash-preview";
    this.normalizeChunkSize = Math.max(1, Number(normalizeChunkSize) || 18);
    this.reconstructChunkSize = Math.max(8, Number(reconstructChunkSize) || 48);
    // Notes extraction over a very long meeting in one call risks both the request
    // timeout and token limits, so a large transcript is summarized chunk-by-chunk and
    // merged. Small meetings (the common case) stay a single call.
    this.notesChunkSize = Math.max(40, Number(notesChunkSize) || 200);
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs) || 90_000);
    // Retries cover transient failures (timeouts, 429, 5xx). A single slow chunk out
    // of dozens on a long meeting is almost always a latency spike, not a fatal error.
    this.maxRetries = Math.max(0, Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 2);
  }

  async normalizeSegments(rawSegments, { participants = [] } = {}) {
    const chunks = chunkArray(rawSegments, this.normalizeChunkSize);
    if (chunks.length <= 1) {
      return this.normalizeSegmentBatch(rawSegments, { participants, context: [] });
    }

    const normalized = [];
    for (const [index, chunk] of chunks.entries()) {
      const context = index > 0 ? chunks[index - 1].slice(-NORMALIZE_CONTEXT_SEGMENTS) : [];
      const chunkSegments = await this.normalizeSegmentBatch(chunk, { participants, context });
      if (chunkSegments.length !== chunk.length) {
        throw new Error(
          `Gemini returned ${chunkSegments.length} normalized segments for a ${chunk.length}-segment chunk.`
        );
      }
      normalized.push(...chunkSegments);
    }
    return normalized.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  }

  async normalizeSegmentBatch(rawSegments, { participants = [], context = [] } = {}) {
    const payload = { segments: rawSegments };
    if (context.length) {
      payload.context = context.map((segment) => ({
        speaker: segment.speaker,
        text: segment.text
      }));
    }

    const response = await this.createJsonResponse({
      schema: NORMALIZED_SEGMENTS_SCHEMA,
      prompt: NORMALIZE_INSTRUCTIONS + participantsNote(participants) + "\n\n" + JSON.stringify(payload)
    });

    return response.segments;
  }

  async extractNotes(notesSource, { participants = [] } = {}) {
    const { units, wrap } = notesUnits(notesSource);
    if (units.length <= this.notesChunkSize) {
      return this.extractNotesBatch(notesSource, { participants });
    }

    // Map: partial notes per chunk of the transcript. One chunk failing after retries
    // costs that section's notes (recorded as a risk), not the whole meeting.
    const chunks = chunkArray(units, this.notesChunkSize);
    const partials = [];
    for (const [index, chunk] of chunks.entries()) {
      try {
        partials.push(await this.extractNotesBatch(wrap(chunk), { participants }));
      } catch (error) {
        console.warn(`Gemini notes chunk ${index + 1}/${chunks.length} failed; skipping that section: ${error.message}`);
        partials.push({
          summary: "",
          detailedNotes: [],
          decisions: [],
          actionItems: [],
          openQuestions: [],
          risks: [`Notes extraction failed for one transcript section: ${error.message}`]
        });
      }
    }
    return this.reduceNotes(partials, { participants });
  }

  async extractNotesBatch(notesSource, { participants = [] } = {}) {
    return this.createJsonResponse({
      schema: NOTES_SCHEMA,
      prompt: NOTES_INSTRUCTIONS + participantsNote(participants) + "\n\n" + JSON.stringify(notesSource)
    });
  }

  // Reduce: dedupe the list fields across chunks and combine the per-chunk summaries
  // into one coherent summary (a small, fast call). Falls back to concatenation if the
  // summary reduction itself fails.
  async reduceNotes(partials, { participants = [] } = {}) {
    const detailedNotes = dedupeStrings(partials.flatMap((partial) => partial?.detailedNotes || []));
    const decisions = dedupeStrings(partials.flatMap((partial) => partial?.decisions || []));
    const openQuestions = dedupeStrings(partials.flatMap((partial) => partial?.openQuestions || []));
    const risks = dedupeStrings(partials.flatMap((partial) => partial?.risks || []));
    const actionItems = dedupeActionItems(partials.flatMap((partial) => partial?.actionItems || []));
    const sectionSummaries = partials.map((partial) => cleanText(partial?.summary)).filter(Boolean);

    let summary = sectionSummaries.join(" ");
    if (sectionSummaries.length > 1) {
      try {
        const reduced = await this.createJsonResponse({
          schema: SUMMARY_REDUCE_SCHEMA,
          prompt:
            SUMMARY_REDUCE_INSTRUCTIONS +
            participantsNote(participants) +
            "\n\n" +
            JSON.stringify({ sectionSummaries })
        });
        if (cleanText(reduced?.summary)) summary = reduced.summary.trim();
      } catch (error) {
        console.warn(`Gemini notes summary reduction failed; using concatenated section summaries: ${error.message}`);
      }
    }

    return { summary, detailedNotes, decisions, actionItems, openQuestions, risks };
  }

  async verifyActionItems({ transcript, notes }, { participants = [] } = {}) {
    const response = await this.createJsonResponse({
      schema: ACTION_ITEMS_VERIFICATION_SCHEMA,
      prompt:
        VERIFY_ACTION_ITEMS_INSTRUCTIONS +
        participantsNote(participants) +
        "\n\n" +
        JSON.stringify({ transcript, actionItems: notes?.actionItems || [] })
    });
    return repairActionItems(response, notes?.actionItems || []);
  }

  async reconstructTranscript(normalizedSegments, { participants = [] } = {}) {
    const chunks = chunkArray(normalizedSegments, this.reconstructChunkSize);
    const combined = {
      roles: [],
      turns: [],
      warnings: []
    };

    for (const [index, chunk] of chunks.entries()) {
      let repaired;
      try {
        const response = await this.reconstructTranscriptBatch({
          segments: chunk,
          existingRoles: combined.roles,
          chunkIndex: index,
          totalChunks: chunks.length,
          participants
        });
        repaired = repairReconstructedTranscript(response);
      } catch (error) {
        // One chunk failing after retries must not lose the whole meeting's transcript.
        // Pass this section through with its normalized speaker labels and flag it, so a
        // single slow window costs one section's role-repair, not the entire recording.
        console.warn(
          `Gemini reconstruct chunk ${index + 1}/${chunks.length} failed; passing it through unrepaired: ${error.message}`
        );
        repaired = passthroughReconstruction(chunk, error);
      }
      combined.roles = mergeRoles(combined.roles, repaired.roles);
      combined.turns.push(...repaired.turns);
      combined.warnings.push(...repaired.warnings);
    }

    const repaired = repairReconstructedTranscript(combined);
    return {
      roles: repaired.roles,
      turns: repaired.turns.map((turn, index) => ({
        ...turn,
        id: `turn_${String(index + 1).padStart(4, "0")}`
      })),
      warnings: [...new Set(repaired.warnings)]
    };
  }

  async reconstructTranscriptBatch({ segments, existingRoles, chunkIndex, totalChunks, participants = [] }) {
    const englishSegments = prepareReconstructionSegments(segments);
    return this.createJsonResponse({
      schema: RECONSTRUCTED_TRANSCRIPT_SCHEMA,
      prompt:
        RECONSTRUCT_INSTRUCTIONS +
        participantsNote(participants) +
        "\n\n" +
        JSON.stringify({
          chunkIndex: chunkIndex + 1,
          totalChunks,
          existingRoles,
          segments: englishSegments
        })
    });
  }

  async createJsonResponse({ schema, prompt }) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.attemptJsonResponse({ schema, prompt });
      } catch (error) {
        lastError = error;
        // Non-transient failures (4xx other than 429, malformed responses) will not get
        // better on retry — surface them immediately.
        if (!error.retryable || attempt === this.maxRetries) throw error;
        const backoffMs = Math.min(8000, 500 * 2 ** attempt);
        console.warn(
          `Gemini request failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}. Retrying in ${backoffMs}ms.`
        );
        await delay(backoffMs);
      }
    }
    throw lastError;
  }

  async attemptJsonResponse({ schema, prompt }) {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-goog-api-key": this.apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(schema)
          }
        })
      });
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(`Gemini request timed out after ${this.requestTimeoutMs}ms.`);
        timeoutError.retryable = true;
        throw timeoutError;
      }
      // Network-level failures (fetch failed, ECONNRESET) are transient by nature.
      error.retryable = true;
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      const requestError = new Error(`Gemini request failed with ${response.status}: ${body}`);
      requestError.retryable = response.status === 429 || response.status >= 500;
      throw requestError;
    }

    const data = await response.json();
    const outputText = extractOutputText(data);
    if (!outputText) {
      throw new Error("Gemini response did not include output text.");
    }
    return JSON.parse(outputText);
  }
}

// Degraded reconstruction for a chunk that could not be role-repaired: keep each
// normalized segment as its own turn under its raw speaker label so the text survives.
function passthroughReconstruction(segments, error) {
  const speakers = [...new Set(segments.map((segment) => String(segment.speaker || "").trim()).filter(Boolean))];
  const roles = speakers.length
    ? speakers.map((label, index) => ({ id: `role_${index + 1}`, label, description: "" }))
    : undefined;
  return repairReconstructedTranscript({
    roles,
    turns: segments.map((segment) => ({
      role: String(segment.speaker || "").trim() || "Speaker",
      start: segment.start,
      end: segment.end,
      text: segment.english || segment.text || "",
      sourceSegmentIds: segment.id ? [segment.id] : [],
      confidence: "low",
      flags: ["reconstruction_skipped"]
    })),
    warnings: [`Speaker reconstruction was skipped for ${segments.length} segment(s): ${error.message}`]
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The notes source is either a reconstructed transcript ({roles, turns}), a normalized
// wrapper ({segments}), or a bare array. Return the units to chunk and a wrapper that
// rebuilds the same shape (preserving roles for context) for a chunk of those units.
function notesUnits(source) {
  if (Array.isArray(source?.turns)) {
    const roles = source.roles || [];
    return { units: source.turns, wrap: (chunk) => ({ roles, turns: chunk }) };
  }
  if (Array.isArray(source?.segments)) {
    return { units: source.segments, wrap: (chunk) => ({ segments: chunk }) };
  }
  if (Array.isArray(source)) {
    return { units: source, wrap: (chunk) => chunk };
  }
  return { units: [], wrap: () => source };
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function dedupeActionItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const task = cleanText(item.task);
    if (!task) continue;
    const key = task.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mergeRoles(existingRoles, newRoles) {
  const roles = [...existingRoles];
  for (const role of newRoles || []) {
    const label = String(role.label || "").trim();
    if (!label) continue;
    const match = roles.find((item) => sameRoleLabel(item.label, label));
    if (match) {
      if (role.description && role.description.length > match.description.length) {
        match.description = role.description;
      }
    } else if (roles.length < 6) {
      roles.push(role);
    }
  }
  return roles;
}

function sameRoleLabel(a, b) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const left = normalize(a);
  const right = normalize(b);
  return left === right || left.includes(right) || right.includes(left);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function extractOutputText(data) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const text = parts
      .map((part) => part.text)
      .filter((part) => typeof part === "string")
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;

  const converted = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && typeof value === "string") {
      converted[key] = value.toUpperCase();
      continue;
    }
    converted[key] = toGeminiSchema(value);
  }
  return converted;
}
