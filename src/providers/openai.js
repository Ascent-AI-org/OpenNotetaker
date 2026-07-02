export const NORMALIZED_SEGMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "speaker", "start", "end", "raw", "english", "confidence", "uncertainTerms"],
        properties: {
          id: { type: "string" },
          speaker: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          raw: { type: "string" },
          english: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          uncertainTerms: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  }
};

const ACTION_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["task", "owner", "due", "evidenceTimestamp", "evidenceSegmentIds"],
  properties: {
    task: { type: "string" },
    owner: { type: "string" },
    due: { type: "string" },
    evidenceTimestamp: { type: "string" },
    evidenceSegmentIds: {
      type: "array",
      items: { type: "string" }
    }
  }
};

export const NOTES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "detailedNotes", "decisions", "actionItems", "openQuestions", "risks"],
  properties: {
    summary: { type: "string" },
    detailedNotes: {
      type: "array",
      items: { type: "string" }
    },
    decisions: {
      type: "array",
      items: { type: "string" }
    },
    actionItems: {
      type: "array",
      items: ACTION_ITEM_SCHEMA
    },
    openQuestions: {
      type: "array",
      items: { type: "string" }
    },
    risks: {
      type: "array",
      items: { type: "string" }
    }
  }
};

export const ACTION_ITEMS_VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actionItems", "warnings"],
  properties: {
    actionItems: {
      type: "array",
      items: ACTION_ITEM_SCHEMA
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  }
};

export const RECONSTRUCTED_TRANSCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roles", "turns", "warnings"],
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" }
        }
      }
    },
    turns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "start", "end", "text", "sourceSegmentIds", "confidence", "flags"],
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
          sourceSegmentIds: {
            type: "array",
            items: { type: "string" }
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          flags: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  }
};

export const NORMALIZE_INSTRUCTIONS =
  "Convert noisy Hinglish, Hindi, and code-switched meeting transcript segments into precise English. " +
  "The source may include Deepgram STT mistakes, Devanagari Hindi, Romanized Hindi, English terms, and occasional wrong-language artifacts. " +
  "Use the segment text, confidence, and lowConfidenceWords as evidence. Correct obvious phonetic/STT mistakes only when the intended meaning is clear. " +
  "Preserve speaker, timestamps, names, product terms, numbers, deadlines, and uncertainty. Do not summarize. " +
  "Do not invent owners, dates, decisions, or missing words. Put unclear names/terms in uncertainTerms and mark confidence low or medium. " +
  "Known Hinglish pitfalls: 'kal' means yesterday OR tomorrow and 'parso' means day-after-tomorrow OR day-before-yesterday — resolve from verb tense and context " +
  "('kal bhej dena' is a future request so tomorrow; 'kal bheja tha' is past so yesterday); if genuinely ambiguous, keep the Hindi word and add it to uncertainTerms. " +
  "Keep Indian number units as spoken (lakh, crore) without converting them. Keep honorifics such as ji, sir, or bhaiya attached to names. " +
  "When a context array is provided, it contains the immediately preceding conversation for disambiguation only: do NOT normalize or return context entries.";

export const NOTES_INSTRUCTIONS =
  "Extract concise meeting notes from the transcript. Prefer reconstructed role turns when present; otherwise use normalized English segments. Use evidence from the transcript only. " +
  "Action items must include owner and due date when stated, otherwise use Unknown or Not stated. " +
  "Every action item must include evidenceSegmentIds: the ids of the transcript segments or turns where the commitment is stated. " +
  "Keep consent, blockers, deadlines, pricing, scope, and contradictions explicit. " +
  "For sales/proposal calls, capture package pricing, deliverables, invoice/contract/payment terms, and next steps.";

export const RECONSTRUCT_INSTRUCTIONS =
  "Deepgram speaker diarization is weak evidence. Reconstruct the transcript into stable conversation roles and clean turns. " +
  "Use only the provided English text for each segment. Every turn.text value must be written in clean English, even when the original meeting was in Hindi or Hinglish. " +
  "Do not output Devanagari script, Hindi sentences, Hinglish sentences, or untranslated source-language phrases in turn.text unless the phrase is a proper noun, brand, or quoted product term. " +
  "Treat Speaker 1/2/3 labels as hints only, not truth. Some segments include speakerHints: participant display names sampled from the Google Meet UI (captions and active-speaker signals) " +
  "while that segment was spoken. speakerHints are stronger evidence than Speaker N labels; when a hint identifies the speaker, use that participant's name in the role label. " +
  "Infer remaining roles from content and intent, such as vendor side versus client side. " +
  "If names or organizations are clearly stated, use them in role labels; otherwise use role labels without inventing names. " +
  "Merge fake extra speakers into the correct role when likely. Split a source segment into multiple turns when it clearly contains two people speaking. " +
  "Preserve timestamps approximately, source segment ids, commercial details, numbers, deliverables, and uncertainty. " +
  "Correct obvious domain terms only when clear. Do not invent facts. If deliverables/pricing conflict, preserve both and add a warning.";

export const VERIFY_ACTION_ITEMS_INSTRUCTIONS =
  "You are auditing extracted meeting action items for completeness and accuracy. Compare the action items against the full transcript. " +
  "Add commitments, follow-ups, and deadline promises that are stated in the transcript but missing from the list, including small ones " +
  "(for example 'main bhej dunga', 'I'll share the logs', 'hum Monday ko call karte hain'). " +
  "Correct an item's owner or due date only when the transcript clearly states otherwise. Do not invent items, owners, or dates that are not in the transcript. " +
  "Every action item must keep evidenceSegmentIds pointing at the transcript segment or turn ids that state it. " +
  "Return the complete corrected action item list, and list any corrections you made in warnings.";

export function participantsNote(participants = []) {
  const names = (participants || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!names.length) return "";
  return (
    ` Known meeting participants from the Google Meet roster: ${names.join(", ")}. ` +
    "Prefer these exact spellings for names; the STT output may have misspelled them. " +
    "Use these display names for owners and role labels when the evidence identifies the person."
  );
}

export class OpenAiProvider {
  constructor({ apiKey, model }) {
    if (!apiKey) throw new Error("OpenAiProvider requires an API key.");
    this.apiKey = apiKey;
    this.model = model || "gpt-5.4-mini";
  }

  async normalizeSegments(rawSegments, { participants = [] } = {}) {
    const response = await this.createJsonResponse({
      name: "normalized_segments",
      schema: NORMALIZED_SEGMENTS_SCHEMA,
      input: [
        {
          role: "developer",
          content: NORMALIZE_INSTRUCTIONS + participantsNote(participants)
        },
        {
          role: "user",
          content: JSON.stringify({ segments: rawSegments })
        }
      ]
    });

    return response.segments;
  }

  async extractNotes(normalizedSegments, { participants = [] } = {}) {
    return this.createJsonResponse({
      name: "meeting_notes",
      schema: NOTES_SCHEMA,
      input: [
        {
          role: "developer",
          content: NOTES_INSTRUCTIONS + participantsNote(participants)
        },
        {
          role: "user",
          content: JSON.stringify(normalizedSegments)
        }
      ]
    });
  }

  async verifyActionItems({ transcript, notes }, { participants = [] } = {}) {
    return this.createJsonResponse({
      name: "verified_action_items",
      schema: ACTION_ITEMS_VERIFICATION_SCHEMA,
      input: [
        {
          role: "developer",
          content: VERIFY_ACTION_ITEMS_INSTRUCTIONS + participantsNote(participants)
        },
        {
          role: "user",
          content: JSON.stringify({ transcript, actionItems: notes?.actionItems || [] })
        }
      ]
    });
  }

  async reconstructTranscript(normalizedSegments, { participants = [] } = {}) {
    const response = await this.createJsonResponse({
      name: "reconstructed_transcript",
      schema: RECONSTRUCTED_TRANSCRIPT_SCHEMA,
      input: [
        {
          role: "developer",
          content: RECONSTRUCT_INSTRUCTIONS + participantsNote(participants)
        },
        {
          role: "user",
          content: JSON.stringify({ segments: prepareReconstructionSegments(normalizedSegments) })
        }
      ]
    });

    return repairReconstructedTranscript(response);
  }

  async createJsonResponse({ name, schema, input }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input,
        text: {
          format: {
            type: "json_schema",
            name,
            schema,
            strict: true
          }
        }
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI request failed with ${response.status}: ${body}`);
    }

    const data = await response.json();
    const outputText = extractOutputText(data);
    if (!outputText) {
      throw new Error("OpenAI response did not include output text.");
    }
    return JSON.parse(outputText);
  }
}

export function repairReconstructedTranscript(value) {
  const roles = Array.isArray(value?.roles) && value.roles.length
    ? value.roles.map((role, index) => ({
        id: cleanString(role.id) || `role_${index + 1}`,
        label: cleanString(role.label) || `Role ${index + 1}`,
        description: cleanString(role.description)
      }))
    : [
        { id: "role_1", label: "Role 1", description: "" },
        { id: "role_2", label: "Role 2", description: "" }
      ];

  const roleAliases = new Map();
  for (const role of roles) {
    roleAliases.set(normalizeRoleKey(role.id), role.label);
    roleAliases.set(normalizeRoleKey(role.label), role.label);
  }

  const turns = Array.isArray(value?.turns)
    ? value.turns
        .map((turn, index) => {
          const start = finiteNumber(turn.start, 0);
          const end = finiteNumber(turn.end, start);
          const role = cleanString(turn.role);
          return {
            id: cleanString(turn.id) || `turn_${index + 1}`,
            role: roleAliases.get(normalizeRoleKey(role)) || role || roles[0].label,
            start,
            end: end >= start ? end : start,
            text: cleanString(turn.text),
            sourceSegmentIds: Array.isArray(turn.sourceSegmentIds)
              ? turn.sourceSegmentIds.map(cleanString).filter(Boolean)
              : [],
            confidence: ["low", "medium", "high"].includes(turn.confidence) ? turn.confidence : "medium",
            flags: Array.isArray(turn.flags) ? turn.flags.map(cleanString).filter(Boolean).slice(0, 8) : []
          };
        })
        .filter((turn) => turn.text)
        .sort((a, b) => a.start - b.start)
    : [];

  return {
    roles,
    turns: turns.map((turn, index) => ({
      ...turn,
      id: turn.id || `turn_${index + 1}`
    })),
    warnings: Array.isArray(value?.warnings) ? value.warnings.map(cleanString).filter(Boolean).slice(0, 20) : []
  };
}

export function repairActionItems(value, fallbackItems = []) {
  const items = Array.isArray(value?.actionItems) ? value.actionItems : null;
  if (!items) return { actionItems: fallbackItems, warnings: [] };

  return {
    actionItems: items
      .map((item) => ({
        task: cleanString(item?.task),
        owner: cleanString(item?.owner) || "Unknown",
        due: cleanString(item?.due) || "Not stated",
        evidenceTimestamp: cleanString(item?.evidenceTimestamp),
        evidenceSegmentIds: Array.isArray(item?.evidenceSegmentIds)
          ? item.evidenceSegmentIds.map(cleanString).filter(Boolean).slice(0, 8)
          : []
      }))
      .filter((item) => item.task),
    warnings: Array.isArray(value?.warnings) ? value.warnings.map(cleanString).filter(Boolean).slice(0, 20) : []
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRoleKey(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

export function prepareReconstructionSegments(segments) {
  return segments.map((segment) => {
    const prepared = {
      id: segment.id,
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      english: segment.english || segment.text || "",
      confidence: segment.confidence || "medium",
      uncertainTerms: Array.isArray(segment.uncertainTerms) ? segment.uncertainTerms : []
    };
    if (Array.isArray(segment.speakerHints) && segment.speakerHints.length) {
      prepared.speakerHints = segment.speakerHints;
    }
    return prepared;
  });
}
