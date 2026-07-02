const PHRASE_MAP = [
  ["haan toh", "okay,"],
  ["kal tak", "by tomorrow"],
  ["first cut", "first version"],
  ["bhej dena", "send it"],
  ["dikhna chahiye", "should be visible"],
  ["theek hai", "okay"],
  ["kara lunga", "will get done"],
  ["wala", "related"],
  ["abhi pending hai", "is still pending"],
  ["aa rahe hain", "are coming in"],
  ["kal sham tak", "by tomorrow evening"],
  ["thoda scary lag raha hai", "feels a bit intimidating"],
  ["rakhte hain", "keep"],
  ["daal dunga", "will add it"]
];

const DEMO_TRANSLATIONS = new Map([
  [
    "haan toh kal tak landing page ka first cut bhej dena, aur pricing section mein annual discount clearly dikhna chahiye",
    "Please send the first version of the landing page by tomorrow, and make sure the annual discount is clearly visible in the pricing section."
  ],
  [
    "theek hai, main Aditi se copy review kara lunga, but Stripe wala webhook abhi pending hai kyunki test mode events inconsistent aa rahe hain",
    "Okay, I will get Aditi to review the copy, but the Stripe webhook is still pending because the test mode events are coming in inconsistently."
  ],
  [
    "okay, Stripe ko blocker mark karte hain. Dhruv, please kal sham tak logs share kar dena so we can debug before Friday demo",
    "Okay, let's mark Stripe as a blocker. Dhruv, please share the logs by tomorrow evening so we can debug before the Friday demo."
  ],
  [
    "one more thing, onboarding flow mein jo permission screen hai uska text thoda scary lag raha hai. Can we make it more clear but not hide the recording consent?",
    "One more thing: the permission screen in the onboarding flow feels a bit intimidating. Can we make it clearer without hiding the recording consent?"
  ],
  [
    "yes, consent ko explicit rakhte hain. Main new copy draft karke Notion mein daal dunga, owner Priya, due Thursday",
    "Yes, let's keep consent explicit. I will draft new copy and add it to Notion. Owner: Priya. Due: Thursday."
  ]
]);

export class MockLlmProvider {
  async normalizeSegments(rawSegments) {
    return rawSegments.map((segment) => ({
      id: segment.id,
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      raw: segment.text,
      english: DEMO_TRANSLATIONS.get(segment.text) || normalizeText(segment.text),
      confidence: segment.confidence >= 0.9 ? "high" : "medium",
      uncertainTerms: []
    }));
  }

  async verifyActionItems({ notes }) {
    return { actionItems: notes?.actionItems || [], warnings: [] };
  }

  async extractNotes(normalizedSegments) {
    const sourceSegments = Array.isArray(normalizedSegments)
      ? normalizedSegments
      : normalizedSegments?.turns || [];
    const transcript = sourceSegments.map((segment) => segment.english || segment.text || "").join(" ");
    const detailedNotes = [];
    const decisions = [];
    const actionItems = [];
    const openQuestions = [];
    const risks = [];

    if (/landing page/i.test(transcript)) {
      detailedNotes.push("The landing page first version is expected by tomorrow, with the annual discount visible in the pricing section if pricing was discussed.");
      actionItems.push({
        task: "Send the first version of the landing page.",
        owner: "Unknown",
        due: /tomorrow/i.test(transcript) ? "Tomorrow" : "Not stated",
        evidenceTimestamp: evidenceTime(normalizedSegments, /landing page/i),
        evidenceSegmentIds: evidenceIds(normalizedSegments, /landing page/i)
      });
    }

    if (/stripe|webhook/i.test(transcript)) {
      detailedNotes.push("Stripe webhook work is currently blocked or pending.");
      decisions.push("Mark Stripe webhook behavior as a blocker.");
      openQuestions.push("Why are Stripe test mode webhook events inconsistent?");
      risks.push("Stripe webhook instability may affect the Friday demo.");
    }

    if (/logs/i.test(transcript)) {
      actionItems.push({
        task: "Share logs for debugging.",
        owner: /dhruv/i.test(transcript) ? "Dhruv" : "Unknown",
        due: /tomorrow evening/i.test(transcript) ? "Tomorrow evening" : "Not stated",
        evidenceTimestamp: evidenceTime(normalizedSegments, /logs/i),
        evidenceSegmentIds: evidenceIds(normalizedSegments, /logs/i)
      });
    }

    if (/permission screen|recording consent|consent/i.test(transcript)) {
      detailedNotes.push("The onboarding permission screen needs clearer language while keeping recording consent explicit.");
      decisions.push("Keep recording consent explicit in the onboarding copy.");
    }

    if (/notion|new copy|priya/i.test(transcript)) {
      actionItems.push({
        task: "Draft clearer consent copy and add it to Notion.",
        owner: /priya/i.test(transcript) ? "Priya" : "Unknown",
        due: /thursday/i.test(transcript) ? "Thursday" : "Not stated",
        evidenceTimestamp: evidenceTime(normalizedSegments, /notion|new copy|priya/i),
        evidenceSegmentIds: evidenceIds(normalizedSegments, /notion|new copy|priya/i)
      });
    }

    if (!detailedNotes.length) {
      detailedNotes.push("The meeting transcript was captured and converted into English.");
    }

    return {
      summary: summarizeTranscript(transcript),
      detailedNotes,
      decisions,
      actionItems,
      openQuestions,
      risks
    };
  }

  async reconstructTranscript(normalizedSegments) {
    return {
      roles: [
        {
          id: "role_1",
          label: "Product team",
          description: "Team member discussing delivery, implementation, and blockers."
        },
        {
          id: "role_2",
          label: "Stakeholder",
          description: "Participant asking questions and reviewing requirements."
        }
      ],
      turns: normalizedSegments.map((segment, index) => ({
        id: `turn_${String(index + 1).padStart(4, "0")}`,
        role: index % 2 === 0 ? "Product team" : "Stakeholder",
        start: segment.start,
        end: segment.end,
        text: segment.english,
        sourceSegmentIds: [segment.id],
        confidence: segment.confidence || "medium",
        flags: []
      })),
      warnings: []
    };
  }
}

function normalizeText(text) {
  let normalized = text;
  for (const [source, target] of PHRASE_MAP) {
    normalized = normalized.replace(new RegExp(source, "gi"), target);
  }

  normalized = normalized
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();

  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}.`;
}

function summarizeTranscript(transcript) {
  const topics = [];
  if (/landing page/i.test(transcript)) topics.push("landing page delivery");
  if (/stripe|webhook/i.test(transcript)) topics.push("Stripe webhook debugging");
  if (/consent|permission/i.test(transcript)) topics.push("consent copy");
  if (!topics.length) return "The meeting was transcribed and converted into clean English notes.";
  return `The team discussed ${topics.join(", ")}.`;
}

function evidenceTime(segments, pattern) {
  return formatTime(findEvidenceSegment(segments, pattern)?.start || 0);
}

function evidenceIds(segments, pattern) {
  const segment = findEvidenceSegment(segments, pattern);
  return segment?.id ? [segment.id] : [];
}

function findEvidenceSegment(segments, pattern) {
  const sourceSegments = Array.isArray(segments) ? segments : segments?.turns || segments?.segments || [];
  return sourceSegments.find(
    (item) => pattern.test(item.english || item.text || "") || pattern.test(item.raw || "")
  );
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const remainder = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
