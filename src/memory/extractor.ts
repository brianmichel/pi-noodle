import { completeSimple } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ExtractionCandidate, MemoryCategory, MemoryDurability, MemoryMessage } from "./types.ts";

const SYSTEM_PROMPT = `You extract durable, memorable facts from AI assistant conversations.

Return a JSON array of memory objects. Each object must have:
- "text": string — concise third-person statement, max 120 chars (e.g. "User prefers TypeScript for new projects")
- "category": one of "identity" | "response_style" | "coding_pref" | "workflow" | "project"
- "durability": one of "durable" | "semi_durable"
- "confidence": number 0.0–1.0
- "reason": string — one of "explicit_statement" | "repeated_pattern" | "inferred_from_behavior"

Rules:
- Only extract facts stable across sessions — not task-specific details
- Skip: file contents, code snippets, transient decisions, error messages, tool results
- Skip: credentials, API keys, tokens, passwords
- Skip: conversational mechanics ("the user asked", "I replied")
- Identity facts (name, role, background) → durable. Preferences and conventions → semi_durable.
- Be conservative: return [] if nothing clearly warrants long-term memory
- Return ONLY the JSON array, no other text`;

type RawCandidate = {
  text?: unknown;
  category?: unknown;
  durability?: unknown;
  confidence?: unknown;
  reason?: unknown;
};

const VALID_CATEGORIES = new Set<string>(["identity", "response_style", "coding_pref", "workflow", "project"]);
const VALID_DURABILITIES = new Set<string>(["durable", "semi_durable"]);

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

export async function extractMemoriesFromMessages(
  messages: MemoryMessage[],
  model: Model<Api>,
): Promise<ExtractionCandidate[]> {
  if (messages.length === 0) return [];

  const conversationText = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const result = await completeSimple(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract memorable facts from this conversation:\n\n${conversationText}`,
        timestamp: Date.now(),
      },
    ],
  }, {
    temperature: 0,
    maxTokens: 1000,
  });

  const content = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");

  if (!content) return [];

  const raw = parseJsonArray(content);
  return raw
    .filter(isValidCandidate)
    .map((c) => ({
      text: (c as ExtractionCandidate).text.trim(),
      category: (c as ExtractionCandidate).category as MemoryCategory,
      durability: (c as ExtractionCandidate).durability as MemoryDurability,
      confidence: (c as ExtractionCandidate).confidence,
      reason: typeof (c as RawCandidate).reason === "string"
        ? ((c as RawCandidate).reason as string)
        : "llm_extracted",
    }));
}
