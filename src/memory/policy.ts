import type {
  LocalSignal,
  MemoryCandidate,
  MemoryCategory,
  MemoryDurability,
  PrefilterResult,
} from "./types.ts";

const EXPLICIT_PATTERNS: Array<{
  pattern: RegExp;
  category: MemoryCategory;
  durability: MemoryDurability;
  reason: string;
  confidence?: number;
  explicit?: boolean;
}> = [
  // Identity
  { pattern: /\bcall me\s+([^.!?\n]+)/i, category: "identity", durability: "durable", reason: "address_preference", confidence: 0.99, explicit: true },
  { pattern: /\bmy name is\s+([^.!?\n]+)/i, category: "identity", durability: "durable", reason: "identity_fact", confidence: 0.99 },
  { pattern: new RegExp("\\bi(?:\\u0027m|\\u2019m| am) (?:a|an)\\s+([^.!?\\n,]{3,50}?)\\s*(?:,|\\.|$|\\s+(?:at|who|and|but)\\b)", "i"), category: "identity", durability: "durable", reason: "role_identity", confidence: 0.96 },
  { pattern: new RegExp("\\bi(?:\\u0027ve|\\u2019ve| have) been (?:doing|using|working (?:with|on))\\s+([^.!?\\n]+?)\\s+for\\s+(?:\\d+\\s+years?|years|a (?:long|while))\\b", "i"), category: "identity", durability: "durable", reason: "expertise", confidence: 0.94 },

  // Explicit memory / durable user statements
  { pattern: /\bremember\s+that\s+([^.!?\n]+)/i, category: "project", durability: "semi_durable", reason: "explicit_memory_request", confidence: 0.99, explicit: true },
  { pattern: /\bfor most projects[,]?\s+i(?:\u0027d|\u2019d| would)?\s*(?:prefer|use)\s+([^.!?\n]+)/i, category: "coding_pref", durability: "semi_durable", reason: "project_default", confidence: 0.82 },
  { pattern: /\bi (?:prefer|like)\s+([^.!?\n]+)/i, category: "response_style", durability: "semi_durable", reason: "stated_preference", confidence: 0.84 },
  { pattern: /\bi usually prefer\s+([^.!?\n]+)/i, category: "response_style", durability: "semi_durable", reason: "habitual_preference", confidence: 0.78 },
  { pattern: /\bi tend to prefer\s+([^.!?\n]+)/i, category: "response_style", durability: "semi_durable", reason: "habitual_preference", confidence: 0.78 },
  { pattern: /\bi normally use\s+([^.!?\n]+)/i, category: "workflow", durability: "semi_durable", reason: "workflow_default", confidence: 0.76 },

  // Strong / negative preferences
  { pattern: new RegExp("\\b((?:always|never|don\\u0027t|don\\u2019t)\\s+[^.!?\\n]+)", "i"), category: "workflow", durability: "semi_durable", reason: "strong_preference", confidence: 0.86 },
  { pattern: /\bplease don(?:\u0027|’)t\s+([^.!?\n]+)/i, category: "workflow", durability: "semi_durable", reason: "negative_preference", confidence: 0.88 },
  { pattern: /\bavoid\s+([^.!?\n]+)/i, category: "workflow", durability: "semi_durable", reason: "negative_preference", confidence: 0.8 },

  // Coding defaults
  { pattern: /\buse\s+([^.!?\n]+?)\s+by default\b/i, category: "coding_pref", durability: "semi_durable", reason: "default_preference", confidence: 0.84 },
  { pattern: /\bdefault to\s+([^.!?\n]+)/i, category: "coding_pref", durability: "semi_durable", reason: "default_preference", confidence: 0.84 },

  // Response format / style
  { pattern: /\balways (?:give me|use|show|write)\s+(bullet points?|numbered lists?|markdown|plain text|code blocks?|prose|headers?)\b/i, category: "response_style", durability: "semi_durable", reason: "format_preference", confidence: 0.88 },

  // Project / team defaults
  { pattern: new RegExp("\\bwe(?:\\u0027re|\\u2019re| are) (?:using|going with)\\s+([^.!?\\n]+?)\\s+(?:for|as|in)\\s+(?:our|this|all|the)\\b", "i"), category: "project", durability: "semi_durable", reason: "tech_decision", confidence: 0.84 },
  { pattern: /\bwe standardi[sz]e on\s+([^.!?\n]+)/i, category: "project", durability: "semi_durable", reason: "project_standard", confidence: 0.9 },
  { pattern: /\bour stack is\s+([^.!?\n]+)/i, category: "project", durability: "semi_durable", reason: "project_stack", confidence: 0.86 },
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
const NEGATIVE_HINTS = /\b(don(?:\u0027|’)t|avoid|never)\b/i;
const CODING_ACTION_HINTS = /\b(use|default to|prefer|always use|never use|avoid|standardi[sz]e on)\b/i;
const CODING_CONTEXT_HINTS = /\b(code|coding|implementation|implement|function|script|library|framework|stack|tool|tooling|test|testing|formatter|lint|cli|backend|frontend|language|daemon)\b/i;

function normalizeMemoryText(text: string): string {
  return text
    .trim()
    .replace(/^that\s+/i, "")
    .replace(/^to\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.]+$/, "");
}

function canonicalizeCandidateText(category: MemoryCategory, sourceText: string, extracted: string, reason: string): string {
  const negativeBase = extracted
    .replace(/^(?:never|don(?:\u0027|’)t|please don(?:\u0027|’)t)\s+/i, "")
    .replace(/^use\s+/i, "");

  switch (reason) {
    case "address_preference":
    case "identity_fact":
      return `Call user ${extracted}`;
    case "role_identity":
      return `User is a ${extracted}`;
    case "expertise":
      return `User has experience with ${extracted}`;
    case "stated_preference":
    case "habitual_preference":
      return `User prefers ${extracted}`;
    case "workflow_default":
      return `User normally uses ${extracted}`;
    case "project_default":
    case "default_preference":
      return `Default to ${extracted}`;
    case "format_preference":
      return `User prefers ${extracted} format`;
    case "tech_decision":
    case "project_standard":
    case "project_stack":
      return `Team uses ${extracted}`;
    case "negative_preference":
    case "strong_preference":
      return /^user /i.test(extracted) ? extracted : `User avoids ${negativeBase}`;
    default:
      break;
  }
  if (category === "coding_pref" && /\bby default\b/i.test(sourceText)) {
    return `Default to ${extracted}`;
  }
  return extracted;
}

function inferCategory(text: string, fallback: MemoryCategory, reason: string): MemoryCategory {
  if (/\b(call me|name is|nickname)\b/i.test(text)) return "identity";
  if (["project_standard", "project_stack", "tech_decision"].includes(reason)) return "project";
  if (reason === "workflow_default") return "workflow";
  if (reason === "project_default") return "coding_pref";
  if (CODING_ACTION_HINTS.test(text) && CODING_CONTEXT_HINTS.test(text)) return "coding_pref";
  if (NEGATIVE_HINTS.test(text) && STYLE_HINTS.test(text)) return "response_style";
  if (STYLE_HINTS.test(text)) return "response_style";
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

export function evaluateCandidatePromotion(candidate: MemoryCandidate, signal: LocalSignal): {
  score: number;
  shouldPromote: boolean;
  reasons: string[];
} {
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

  const shouldPromote = candidate.explicit || score >= 5;
  return { score, shouldPromote, reasons };
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
