import type {
  LocalSignal,
  MemoryCandidate,
  MemoryCategory,
  MemoryDurability,
  MemoryPolicyDecision,
  PrefilterResult,
} from "./types.ts";
import type { NoodleExtractorMode } from "../types.ts";

const EXPLICIT_PATTERNS: Array<{
  pattern: RegExp;
  category: MemoryCategory;
  durability: MemoryDurability;
  reason: string;
  confidence?: number;
  explicit?: boolean;
}> = [
  {
    pattern: /\bremember(?:\s+that)?\s+([^.!?\n]+)/i,
    category: "project",
    durability: "semi_durable",
    reason: "explicit_memory_request",
    confidence: 0.99,
    explicit: true,
  },
];

const RETRIEVAL_PATTERNS: RegExp[] = [
  /\b(call me|what should you call me|my name|nickname)\b/i,
  /\b(prefer|by default|always|never|concise|verbose|brief|detailed|usually|normally|avoid|should i use|should i avoid)\b/i,
  /\b(code|implement|refactor|fix|review|format|summari[sz]e|plan|debug|test|language|runtime|stack|daemon|backend|script)\b/i,
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

const STYLE_HINTS = /\b(concise|brief|short|verbose|detailed|bullet points?|markdown|plain text)\b/i;
const CODING_CONTEXT_HINTS = /\b(code|coding|implementation|implement|function|script|library|framework|stack|tool|tooling|test|testing|formatter|lint|cli|backend|frontend|language|daemon)\b/i;

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/^that\s+/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.]+$/, "");
}

function canonicalizeCandidateText(_category: MemoryCategory, _sourceText: string, extracted: string, _reason: string): string {
  return extracted;
}

function inferCategory(text: string, fallback: MemoryCategory, _reason: string): MemoryCategory {
  if (/\b(call me|my name|nickname)\b/i.test(text)) return "identity";
  if (STYLE_HINTS.test(text)) return "response_style";
  if (CODING_CONTEXT_HINTS.test(text)) return "coding_pref";
  return fallback;
}

function inferDurability(text: string, fallback: MemoryDurability): MemoryDurability {
  if (TEMPORARY_PATTERNS.some((pattern) => pattern.test(text))) return "ephemeral";
  return fallback;
}

function confidenceFor(entry: { confidence?: number }, category: MemoryCategory): number {
  if (typeof entry.confidence === "number") return entry.confidence;
  return category === "identity" ? 0.96 : 0.8;
}

export function buildSignalKey(candidate: MemoryCandidate): string {
  return `${candidate.category}:${candidate.normalized}`;
}

export function shouldBlockSensitiveMemory(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldRetrieveMemories(prompt: string): boolean {
  return RETRIEVAL_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function categoriesForPrompt(prompt: string): MemoryCategory[] {
  const categories: MemoryCategory[] = ["identity", "response_style"];

  if (/\b(code|implement|implementation|refactor|fix|test|review|debug|scripts?|function|library|framework|tool|tooling|stack|daemon|backend|services?|language|runtime)\b/i.test(prompt)) {
    categories.push("coding_pref", "workflow");
  }

  if (/\b(repo|project|convention|branch|workflow|team|codebase|stack)\b/i.test(prompt)) {
    categories.push("project", "workflow");
  }

  return Array.from(new Set(categories));
}

export function tokenizePrompt(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3);
}

export function scoreMemoryText(memoryText: string, queryTokens: string[], categories: string[], memoryCategories: string[], durability?: unknown): number {
  let score = 0;
  const normalizedText = memoryText.toLowerCase();

  for (const token of queryTokens) {
    if (normalizedText.includes(token)) score += 2;
  }

  for (const category of categories) {
    if (memoryCategories.includes(category)) score += 3;
  }

  if (durability === "durable") score += 1;
  return score;
}

// The extractor can suggest an action, but local policy makes the final decision.
// This keeps persistence deterministic, testable, and easy to tune by mode.
export function evaluateCandidateDecision(
  candidate: MemoryCandidate,
  signal: LocalSignal,
  mode: NoodleExtractorMode = "balanced",
): MemoryPolicyDecision {
  let score = 0;
  const reasons: string[] = [];

  // 1. Explicit asks should be saved immediately.
  if (candidate.explicit) {
    score += 10;
    reasons.push("explicit_request");
  }

  // 2. Identity facts are durable and usually useful later.
  if (candidate.category === "identity") {
    score += 6;
    reasons.push("identity_fact");
  }

  // 3. Strong wording (negative preferences/defaults/standards) is high-value.
  if (candidate.reasons.includes("negative_preference")) {
    score += 5;
    reasons.push("negative_preference");
  } else if (candidate.reasons.includes("strong_preference")) {
    score += 4;
    reasons.push("strong_preference");
  } else if (candidate.reasons.some((reason) => ["default_preference", "workflow_default", "project_standard", "project_default", "project_stack", "tech_decision"].includes(reason))) {
    score += 3;
    reasons.push("project_or_default_convention");
  }

  // 4. Repetition is the safest non-explicit promotion signal.
  if (signal.count >= 4) {
    score += 5;
    reasons.push("repeated_signal");
  } else if (signal.count >= 3) {
    score += 4;
    reasons.push("repeated_signal");
  } else if (signal.count >= 2) {
    score += 3;
    reasons.push("repeated_signal");
  }

  // 5. Confidence should help, but not overrule durability/repetition by itself.
  if (signal.strongestConfidence >= 0.9) {
    score += 2;
    reasons.push("very_high_confidence");
  } else if (signal.strongestConfidence >= 0.75) {
    score += 1;
    reasons.push("high_confidence");
  }

  // 6. Retrieval telemetry is weak but useful evidence that the fact mattered.
  if ((signal.retrievalCount ?? 0) >= 3) {
    score += 2;
    reasons.push("retrieved_repeatedly");
  } else if ((signal.retrievalCount ?? 0) >= 1) {
    score += 1;
    reasons.push("retrieved_once");
  }

  // 7. Durable preference categories deserve some weight even before they repeat a lot.
  if (candidate.category === "coding_pref" || candidate.category === "response_style") {
    score += 1;
    reasons.push("preference_category");
  }

  // 8. Project standards / stack declarations are valuable even on first mention.
  if (candidate.category === "project" && candidate.reasons.some((reason) => ["project_standard", "project_stack", "tech_decision"].includes(reason))) {
    score += 2;
    reasons.push("project_convention");
  }

  // 9. Durable memories get a slight nudge over semi-durable habits.
  if (candidate.durability === "durable") {
    score += 1;
    reasons.push("durable");
  }

  const sensitivity = candidate.metadata["sensitivity"];
  if (sensitivity === "sensitive") {
    reasons.push("sensitive_blocked");
    return {
      action: "discard",
      score,
      shouldPromote: false,
      reasons,
    };
  }

  if (candidate.explicit) {
    return { action: "save", score, shouldPromote: true, reasons };
  }

  if (candidate.category === "identity" && signal.strongestConfidence >= 0.9) {
    return { action: "save", score, shouldPromote: true, reasons };
  }

  if (mode === "conservative") {
    if (score >= 7) return { action: "save", score, shouldPromote: true, reasons };
    return { action: "discard", score, shouldPromote: false, reasons };
  }

  if (score >= (mode === "proactive" ? 6 : 5)) {
    return { action: "save", score, shouldPromote: true, reasons };
  }

  const isPreferenceLike = candidate.category === "coding_pref" || candidate.category === "response_style" || candidate.category === "workflow" || candidate.category === "project";
  const confidenceFloor = mode === "proactive" ? 0.65 : 0.72;
  if (isPreferenceLike && signal.strongestConfidence >= confidenceFloor) {
    return { action: "pending", score, shouldPromote: false, reasons };
  }

  return { action: "discard", score, shouldPromote: false, reasons };
}

export function evaluateCandidatePromotion(candidate: MemoryCandidate, signal: LocalSignal): {
  score: number;
  shouldPromote: boolean;
  reasons: string[];
} {
  const decision = evaluateCandidateDecision(candidate, signal, "balanced");
  return {
    score: decision.score,
    shouldPromote: decision.shouldPromote,
    reasons: decision.reasons,
  };
}

export function prefilterUserMessage(text: string): PrefilterResult {
  const candidates: MemoryCandidate[] = [];
  const candidateReasons = new Set<string>();

  if (shouldBlockSensitiveMemory(text)) {
    return {
      hasCandidate: false,
      shouldRetrieve: shouldRetrieveMemories(text),
      candidateReasons: ["sensitive_content_blocked"],
      candidates,
    };
  }

  for (const entry of EXPLICIT_PATTERNS) {
    const match = text.match(entry.pattern);
    if (!match) continue;

    const rawExtracted = normalizeMemoryText(match[1] || match[2] || match[0]);
    if (!rawExtracted) continue;

    const category = inferCategory(text, entry.category, entry.reason);
    const durability = inferDurability(text, entry.durability);
    if (durability === "ephemeral") continue;

    const extracted = rawExtracted.replace(/^use\s+/i, "");
    const canonicalText = canonicalizeCandidateText(category, text, extracted, entry.reason);
    candidateReasons.add(entry.reason);
    candidates.push({
      text: canonicalText,
      normalized: canonicalText.toLowerCase(),
      category,
      durability,
      source: entry.reason === "explicit_memory_request" ? "explicit" : "heuristic",
      confidence: confidenceFor(entry, category),
      explicit: entry.explicit === true,
      reasons: [entry.reason],
      metadata: {
        trigger: entry.reason,
      },
    });
  }

  const deduped = Array.from(new Map(candidates.map((candidate) => [buildSignalKey(candidate), candidate])).values());

  return {
    hasCandidate: deduped.length > 0,
    shouldRetrieve: shouldRetrieveMemories(text),
    candidateReasons: Array.from(candidateReasons),
    candidates: deduped,
  };
}
