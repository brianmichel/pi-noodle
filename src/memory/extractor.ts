import { complete } from "@earendil-works/pi-ai";
import type { Api, Model, Message } from "@earendil-works/pi-ai";

import type {
  ExtractionCandidate,
  ExtractionSensitivity,
  ExtractionStability,
  MemoryApplicability,
  MemoryCategory,
  MemoryDurability,
  MemoryMessage,
} from "./types.ts";

const SYSTEM_PROMPT = `You extract durable, memorable facts from AI assistant conversations.

Return a JSON array of memory objects. Each object must have:
- "text": string — concise third-person statement, max 120 chars (e.g. "User prefers TypeScript for new projects")
- "category": one of "identity" | "response_style" | "coding_pref" | "workflow" | "project"
- "durability": one of "durable" | "semi_durable"
- "confidence": number 0.0–1.0
- "reason": string — short machine-readable reason such as "explicit_statement" | "repeated_pattern" | "inferred_from_behavior"
- "stability": one of "stable" | "likely_stable" | "uncertain"
- "sensitivity": one of "safe" | "sensitive"
- "suggestedAction": one of "save" | "pending" | "discard"
- "applicability": one of "user" | "project" | "unknown"
- "applicabilityConfidence": number 0.0–1.0
- "applicabilityReason": string — short explanation for why this applies broadly vs to the current project

Rules:
- Only extract facts stable across sessions — not task-specific details
- Prioritize user defaults, repeated habits, negative preferences, and project conventions likely to matter later
- Prefer facts stated by the user over assistant speculation
- "project" means the fact seems tied to the current codebase, product, feature, or initiative rather than the user's broad cross-project preference
- Prefer "user" only when the user clearly states a general habit or default likely to apply across unrelated projects
- Use "unknown" when the distinction is ambiguous
- Skip: file contents, code snippets, transient decisions, error messages, tool results
- Skip: credentials, API keys, tokens, passwords, private secrets, financial details, and medical details
- Skip: conversational mechanics ("the user asked", "I replied")
- Skip: anything that only matters for the current task, file, or response
- Identity facts (name, role, background) → durable. Preferences and conventions → semi_durable.
- Use "pending" for plausible but not yet certain durable preferences.
- Use "discard" when something looks transient, risky, or not worth long-term memory.
- Be conservative: return [] if nothing clearly warrants long-term memory
- Return ONLY the JSON array, no other text`;

type RawCandidate = {
  text?: unknown;
  category?: unknown;
  durability?: unknown;
  confidence?: unknown;
  reason?: unknown;
  stability?: unknown;
  sensitivity?: unknown;
  suggestedAction?: unknown;
  applicability?: unknown;
  applicabilityConfidence?: unknown;
  applicabilityReason?: unknown;
};

const VALID_CATEGORIES = new Set<string>(["identity", "response_style", "coding_pref", "workflow", "project"]);
const VALID_DURABILITIES = new Set<string>(["durable", "semi_durable"]);
const VALID_STABILITIES = new Set<string>(["stable", "likely_stable", "uncertain"]);
const VALID_SENSITIVITIES = new Set<string>(["safe", "sensitive"]);
const VALID_ACTIONS = new Set<string>(["save", "pending", "discard"]);
const VALID_APPLICABILITY = new Set<string>(["user", "project", "unknown"]);

function normalizeStability(raw: unknown): ExtractionStability {
  return typeof raw === "string" && VALID_STABILITIES.has(raw) ? raw as ExtractionStability : "uncertain";
}

function normalizeSensitivity(raw: unknown): ExtractionSensitivity {
  return typeof raw === "string" && VALID_SENSITIVITIES.has(raw) ? raw as ExtractionSensitivity : "safe";
}

function normalizeApplicability(raw: unknown): MemoryApplicability {
  return typeof raw === "string" && VALID_APPLICABILITY.has(raw) ? raw as MemoryApplicability : "unknown";
}

function isValidCandidate(raw: unknown): raw is ExtractionCandidate {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as RawCandidate;
  if (typeof r.text !== "string" || r.text.trim().length === 0) return false;
  if (typeof r.category !== "string" || !VALID_CATEGORIES.has(r.category)) return false;
  if (typeof r.durability !== "string" || !VALID_DURABILITIES.has(r.durability)) return false;
  if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) return false;
  return true;
}

function parseJsonArray(content: string): unknown[] {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) return val;
      }
    }
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) return arr;
      } catch {
        // unparseable
      }
    }
  }
  return [];
}

export function parseExtractedCandidates(content: string): ExtractionCandidate[] {
  if (!content) return [];

  const raw = parseJsonArray(content);

  return raw
    .filter(isValidCandidate)
    .map((c) => {
      const applicabilityConfidence = typeof (c as RawCandidate).applicabilityConfidence === "number"
        ? ((c as RawCandidate).applicabilityConfidence as number)
        : undefined;
      const applicabilityReason = typeof (c as RawCandidate).applicabilityReason === "string"
        ? ((c as RawCandidate).applicabilityReason as string)
        : undefined;

      return {
        text: (c as ExtractionCandidate).text.trim(),
        category: (c as ExtractionCandidate).category as MemoryCategory,
        durability: (c as ExtractionCandidate).durability as MemoryDurability,
        confidence: (c as ExtractionCandidate).confidence,
        reason: typeof (c as RawCandidate).reason === "string"
          ? ((c as RawCandidate).reason as string)
          : "llm_extracted",
        stability: normalizeStability((c as RawCandidate).stability),
        sensitivity: normalizeSensitivity((c as RawCandidate).sensitivity),
        suggestedAction: typeof (c as RawCandidate).suggestedAction === "string" && VALID_ACTIONS.has((c as RawCandidate).suggestedAction as string)
          ? ((c as RawCandidate).suggestedAction as "save" | "pending" | "discard")
          : "pending",
        applicability: normalizeApplicability((c as RawCandidate).applicability),
        ...(applicabilityConfidence !== undefined ? { applicabilityConfidence } : {}),
        ...(applicabilityReason ? { applicabilityReason } : {}),
      };
    });
}

export async function extractMemoriesFromMessages(
  messages: MemoryMessage[],
  model: Model<Api>,
  options?: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<ExtractionCandidate[]> {
  if (messages.length === 0) return [];

  const conversationText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const userMessage: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `Extract memorable facts from this conversation:\n\n${conversationText}`,
    }],
    timestamp: Date.now(),
  };

  // Use complete() rather than completeSimple() so we can pass the API key
  // and headers resolved from ctx.modelRegistry.getApiKeyAndHeaders().
  // completeSimple() accepts options but doesn't get auth from the model
  // registry — it only checks env vars, which misses SSO/OAuth setups.
  const result = await complete(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [userMessage],
  }, {
    temperature: 0,
    maxTokens: 1000,
    ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options?.headers ? { headers: options.headers } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });

  const content = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");

  return parseExtractedCandidates(content);
}
