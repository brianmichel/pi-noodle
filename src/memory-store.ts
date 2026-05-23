import { mem0Request } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { DEFAULT_AGENT_ID } from "./constants.ts";
import type { MemoryCategory, StoredMemory } from "./memory-types.ts";
import type { JsonObject } from "./types.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

function extractStoredMemories(payload: unknown): StoredMemory[] {
  const root = toRecord(payload);
  const rawResults = Array.isArray(root.results)
    ? root.results
    : Array.isArray(root.memories)
      ? root.memories
      : Array.isArray(payload)
        ? payload
        : [];

  const memories: StoredMemory[] = [];
  for (const item of rawResults) {
    const record = toRecord(item);
    const metadata = toRecord(record.metadata);
    const categories = toStringArray(metadata.category ?? metadata.categories);
    const memory = typeof record.memory === "string"
      ? record.memory
      : typeof record.text === "string"
        ? record.text
        : "";
    if (!memory) continue;

    const storedMemory: StoredMemory = {
      memory,
      categories,
      metadata,
      ...(typeof record.id === "string" ? { id: record.id } : {}),
    };
    memories.push(storedMemory);
  }

  return memories;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3);
}

function scoreMemory(memory: StoredMemory, queryTokens: string[], categories: MemoryCategory[]): number {
  let score = 0;
  const memoryText = memory.memory.toLowerCase();
  for (const token of queryTokens) {
    if (memoryText.includes(token)) score += 2;
  }
  for (const category of categories) {
    if (memory.categories.includes(category)) score += 3;
  }
  if (memory.metadata.durability === "durable") score += 1;
  return score;
}

export async function listStoredMemories(): Promise<StoredMemory[]> {
  const config = await resolveConfig();
  const query: Record<string, string> = {
    agent_id: DEFAULT_AGENT_ID,
  };
  if (config.userId) query.user_id = config.userId;

  const payload = await mem0Request("GET", "/memories", undefined, query);
  return extractStoredMemories(payload);
}

export async function findRelevantMemories(options: {
  prompt: string;
  categories: MemoryCategory[];
  limit?: number;
}): Promise<StoredMemory[]> {
  const memories = await listStoredMemories();
  const queryTokens = tokenize(options.prompt);
  const scored = memories
    .map((memory) => ({
      ...memory,
      score: scoreMemory(memory, queryTokens, options.categories),
    }))
    .filter((memory) => (memory.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return scored.slice(0, options.limit ?? 3);
}

export async function upsertMemoryCandidate(options: {
  text: string;
  normalized: string;
  metadata: JsonObject;
}): Promise<"saved" | "skipped"> {
  const existing = await listStoredMemories();
  const normalized = options.normalized.trim().toLowerCase();
  if (existing.some((memory) => {
    const current = memory.memory.trim().toLowerCase();
    return current === normalized || current.includes(normalized) || normalized.includes(current);
  })) {
    return "skipped";
  }

  const config = await resolveConfig();
  const payload: JsonObject = {
    messages: [{ role: "user", content: options.text }],
    agent_id: DEFAULT_AGENT_ID,
    metadata: options.metadata,
  };
  if (config.userId) payload.user_id = config.userId;

  await mem0Request("POST", "/memories", payload);
  return "saved";
}
