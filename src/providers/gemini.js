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

export class GeminiProvider {
  constructor({ apiKey, model, normalizeChunkSize = 18, reconstructChunkSize = 48, requestTimeoutMs = 90_000, maxRetries = 2 }) {
    if (!apiKey) throw new Error("GeminiProvider requires an API key.");
    this.apiKey = apiKey;
    this.model = model || "gemini-3-flash-preview";
    this.normalizeChunkSize = Math.max(1, Number(normalizeChunkSize) || 18);
    this.reconstructChunkSize = Math.max(8, Number(reconstructChunkSize) || 48);
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

  async extractNotes(normalizedSegments, { participants = [] } = {}) {
    return this.createJsonResponse({
      schema: NOTES_SCHEMA,
      prompt: NOTES_INSTRUCTIONS + participantsNote(participants) + "\n\n" + JSON.stringify(normalizedSegments)
    });
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
