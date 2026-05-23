import type { MemoryCandidate, MemoryCategory, MemoryDurability, PrefilterResult } from "./memory-types.ts";

const EXPLICIT_PATTERNS: Array<{ pattern: RegExp; category: MemoryCategory; durability: MemoryDurability; reason: string }> = [
  { pattern: /\bcall me\s+([^.!?\n]+)/i, category: "identity", durability: "durable", reason: "address_preference" },
  { pattern: /\bi (?:prefer|like)\s+([^.!?\n]+)/i, category: "response_style", durability: "semi_durable", reason: "stated_preference" },
  { pattern: /\b(always|never|don['’]t)\s+([^.!?\n]+)/i, category: "workflow", durability: "semi_durable", reason: "strong_preference" },
  { pattern: /\buse\s+([^.!?\n]+?)\s+by default\b/i, category: "coding_pref", durability: "semi_durable", reason: "default_preference" },
  { pattern: /\bremember\s+that\s+([^.!?\n]+)/i, category: "project", durability: "semi_durable", reason: "explicit_memory_request" },
  { pattern: /\bmy name is\s+([^.!?\n]+)/i, category: "identity", durability: "durable", reason: "identity_fact" },
];

const RETRIEVAL_PATTERNS: RegExp[] = [
  /\b(call me|what should you call me|my name|nickname)\b/i,
  /\b(prefer|by default|always|never|concise|verbose|brief|detailed)\b/i,
  /\b(code|implement|refactor|fix|review|format|summari[sz]e|plan|debug|test)\b/i,
];

const TEMPORARY_PATTERNS: RegExp[] = [
  /\b(for this|this time|for now|today only|in this response|for this task|for this file|for this repo)\b/i,
  /\b(current task|temporary|right now)\b/i,
];

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(api[_ -]?key|token|secret|password|passwd|private key|ssh key|oauth)\b/i,
  /\bm0sk_[a-z0-9]+\b/i,
  /\bsk-[a-z0-9]+\b/i,
  /authorization:\s*bearer/i,
];

const STYLE_HINTS = /\b(concise|brief|short|verbose|detailed|bullet points?|markdown)\b/i;
const CODING_ACTION_HINTS = /\b(use|default to|prefer|always use|never use)\b/i;
const CODING_CONTEXT_HINTS = /\b(code|coding|implementation|implement|function|script|library|framework|stack|tool|tooling|test|testing|formatter|lint|cli|backend|frontend|language)\b/i;

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/^that\s+/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.]+$/, "");
}

function canonicalizeCandidateText(category: MemoryCategory, sourceText: string, extracted: string): string {
  if (category === "identity" && /\b(call me|my name is)\b/i.test(sourceText)) {
    return `Call user ${extracted}`;
  }
  if (category === "response_style" && /\bprefer\b/i.test(sourceText)) {
    return `User prefers ${extracted}`;
  }
  if (category === "coding_pref" && /\bby default\b/i.test(sourceText)) {
    return `Default to ${extracted}`;
  }
  return extracted;
}

function inferCategory(text: string, fallback: MemoryCategory): MemoryCategory {
  if (/\b(call me|name is|nickname)\b/i.test(text)) return "identity";
  if (STYLE_HINTS.test(text)) return "response_style";
  if (CODING_ACTION_HINTS.test(text) && CODING_CONTEXT_HINTS.test(text)) return "coding_pref";
  return fallback;
}

function inferDurability(text: string, fallback: MemoryDurability): MemoryDurability {
  if (TEMPORARY_PATTERNS.some((pattern) => pattern.test(text))) return "ephemeral";
  return fallback;
}

export function buildSignalKey(candidate: MemoryCandidate): string {
  return `${candidate.category}:${candidate.normalized}`;
}

export function shouldBlockSensitiveMemory(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function classifyPromptForRetrieval(prompt: string): boolean {
  return RETRIEVAL_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function prefilterUserMessage(text: string): PrefilterResult {
  const candidates: MemoryCandidate[] = [];
  const candidateReasons = new Set<string>();

  if (shouldBlockSensitiveMemory(text)) {
    return {
      hasCandidate: false,
      shouldRetrieve: classifyPromptForRetrieval(text),
      candidateReasons: ["sensitive_content_blocked"],
      candidates,
    };
  }

  for (const entry of EXPLICIT_PATTERNS) {
    const match = text.match(entry.pattern);
    if (!match) continue;

    const extracted = normalizeMemoryText(match[1] || match[2] || match[0]);
    if (!extracted) continue;

    const category = inferCategory(text, entry.category);
    const durability = inferDurability(text, entry.durability);
    if (durability === "ephemeral") continue;

    const canonicalText = canonicalizeCandidateText(category, text, extracted);
    candidateReasons.add(entry.reason);
    candidates.push({
      text: canonicalText,
      normalized: canonicalText.toLowerCase(),
      category,
      durability,
      source: entry.reason === "explicit_memory_request" ? "explicit" : "heuristic",
      confidence: entry.reason === "explicit_memory_request" || category === "identity" ? 0.98 : 0.82,
      explicit: entry.reason === "explicit_memory_request" || /\bcall me\b/i.test(text),
      reasons: [entry.reason],
      metadata: {
        trigger: entry.reason,
      },
    });
  }

  const deduped = Array.from(new Map(candidates.map((candidate) => [buildSignalKey(candidate), candidate])).values());

  return {
    hasCandidate: deduped.length > 0,
    shouldRetrieve: classifyPromptForRetrieval(text),
    candidateReasons: Array.from(candidateReasons),
    candidates: deduped,
  };
}
