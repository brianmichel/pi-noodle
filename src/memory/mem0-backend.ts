import { requestJsonWithFallback } from "../api.ts";
import { resolveConfig } from "../config.ts";
import { DEFAULT_AGENT_ID } from "../constants.ts";
import type { JsonObject } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import type {
  AddMemoryInput,
  ConversationCaptureInput,
  MemoryCategory,
  MemoryListInput,
  MemoryRecord,
  MemoryScope,
  MemorySearchInput,
  UpdateMemoryInput,
} from "./types.ts";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

function normalizeScope(scope?: MemoryScope): MemoryScope {
  return {
    ...(scope?.userId ? { userId: scope.userId } : {}),
    assistantId: scope?.assistantId || DEFAULT_AGENT_ID,
    ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
  };
}

export function normalizeMem0Record(item: unknown): MemoryRecord | null {
  const record = toRecord(item);
  const metadata = toRecord(record.metadata);
  const categories = toStringArray(metadata.category ?? metadata.categories);
  const text = typeof record.memory === "string"
    ? record.memory
    : typeof record.text === "string"
      ? record.text
      : "";

  if (!text) return null;

  const category = typeof metadata.category === "string" ? metadata.category : undefined;

  return {
    text,
    categories,
    metadata: metadata as JsonObject,
    ...(category ? { category: category as MemoryCategory } : {}),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
  };
}

export function extractMem0Records(payload: unknown): MemoryRecord[] {
  const root = toRecord(payload);
  const rawResults = Array.isArray(root.results)
    ? root.results
    : Array.isArray(root.memories)
      ? root.memories
      : Array.isArray(payload)
        ? payload
        : [];

  return rawResults
    .map((item) => normalizeMem0Record(item))
    .filter((item): item is MemoryRecord => item !== null);
}

function buildMem0Query(scope?: MemoryScope): Record<string, string> {
  const normalizedScope = normalizeScope(scope);
  const query: Record<string, string> = {};
  if (normalizedScope.userId) query.user_id = normalizedScope.userId;
  if (normalizedScope.assistantId) query.agent_id = normalizedScope.assistantId;
  if (normalizedScope.sessionId) query.run_id = normalizedScope.sessionId;
  return query;
}

export function buildMem0SearchPayload(input: MemorySearchInput): JsonObject {
  const payload: JsonObject = {
    query: input.query,
  };

  if (input.limit !== undefined) payload.top_k = input.limit;
  if (input.threshold !== undefined) payload.threshold = input.threshold;

  const filters: JsonObject = {
    ...buildMem0Query(input.scope),
    ...(input.filters ?? {}),
  };

  if (input.categories && input.categories.length > 0) {
    filters.categories = input.categories;
  }

  if (Object.keys(filters).length > 0) {
    payload.filters = filters;
  }

  return payload;
}

function buildAddPayload(input: AddMemoryInput | ConversationCaptureInput): JsonObject {
  const scope = normalizeScope(input.scope);
  const addInput = input as Partial<AddMemoryInput>;
  const categories = [
    ...(addInput.categories ?? []),
    ...(addInput.category ? [addInput.category] : []),
  ];

  const metadata: JsonObject = {
    ...(input.metadata ?? {}),
    ...(addInput.category ? { category: addInput.category } : {}),
    ...(categories.length > 0 ? { categories: Array.from(new Set(categories)) } : {}),
  };

  const messages = input.messages && input.messages.length > 0
    ? input.messages
    : addInput.text
      ? [{ role: "user", content: addInput.text }]
      : [];

  if (messages.length === 0) {
    throw new Error("Provide text or messages.");
  }

  return {
    messages,
    ...buildMem0Query(scope),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export class Mem0Backend implements MemoryBackend {
  async add(input: AddMemoryInput): Promise<void> {
    const config = await resolveConfig();
    const scope = {
      ...(config.userId ? { userId: config.userId } : {}),
      ...(input.scope ?? {}),
    };

    await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      pathname: "/memories",
      body: buildAddPayload({ ...input, scope }),
      label: "Mem0 POST /memories",
    });
  }

  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    const config = await resolveConfig();
    const scope = {
      ...(config.userId ? { userId: config.userId } : {}),
      ...(input.scope ?? {}),
    };

    const payload = await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      pathname: "/search",
      body: buildMem0SearchPayload({ ...input, scope }),
      label: "Mem0 POST /search",
    });

    return extractMem0Records(payload);
  }

  async list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    const config = await resolveConfig();
    const scope = {
      ...(config.userId ? { userId: config.userId } : {}),
      ...(input?.scope ?? {}),
    };

    const payload = await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
      },
      method: "GET",
      pathname: "/memories",
      query: buildMem0Query(scope),
      label: "Mem0 GET /memories",
    });

    return extractMem0Records(payload);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const config = await resolveConfig();
    const payload = await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
      },
      method: "GET",
      pathname: `/memories/${encodeURIComponent(id)}`,
      label: "Mem0 GET /memories/:id",
    });

    return normalizeMem0Record(payload);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    const config = await resolveConfig();
    const payload: JsonObject = {
      ...(input.text ? { text: input.text } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    if (Object.keys(payload).length === 0) {
      throw new Error("Provide text or metadata for the update.");
    }

    await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "PUT",
      pathname: `/memories/${encodeURIComponent(id)}`,
      body: payload,
      label: "Mem0 PUT /memories/:id",
    });
  }

  async delete(id: string): Promise<void> {
    const config = await resolveConfig();
    await requestJsonWithFallback({
      baseUrl: config.baseUrl,
      headers: {
        "X-API-Key": config.apiKey,
        Accept: "application/json",
      },
      method: "DELETE",
      pathname: `/memories/${encodeURIComponent(id)}`,
      label: "Mem0 DELETE /memories/:id",
    });
  }

  async captureConversation(input: ConversationCaptureInput): Promise<void> {
    await this.add(input);
  }
}
