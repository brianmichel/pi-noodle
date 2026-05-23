import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { memoryService } from "./memory/runtime.ts";
import type { JsonObject } from "./types.ts";
import { formatJson } from "./utils.ts";

const scopeSchema = Type.Object({
  userId: Type.Optional(Type.String({ description: "User identifier." })),
  assistantId: Type.Optional(Type.String({ description: "Assistant identifier." })),
  sessionId: Type.Optional(Type.String({ description: "Session/run identifier." })),
});

const metadataSchema = Type.Object({}, { additionalProperties: true, description: "Optional metadata." });

export const memoryAddTool = defineTool({
  name: "memory_add",
  label: "Memory Add",
  description: "Store a memory record using the configured memory backend.",
  promptSnippet: "Store important user or agent facts in long-term memory.",
  promptGuidelines: [
    "Use memory_add when the user explicitly asks to save a stable preference, identity detail, or workflow default.",
  ],
  parameters: Type.Object({
    text: Type.Optional(Type.String({ description: "Convenience text memory to store." })),
    messages: Type.Optional(
      Type.Array(
        Type.Object({
          role: Type.String({ description: "Message role." }),
          content: Type.String({ description: "Message content." }),
        }),
        { description: "Conversation messages to capture as memory." },
      ),
    ),
    category: Type.Optional(Type.String({ description: "Primary memory category." })),
    categories: Type.Optional(Type.Array(Type.String({ description: "Additional categories." }))),
    scope: Type.Optional(scopeSchema),
    metadata: Type.Optional(metadataSchema),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    await memoryService.add({
      ...(params.text ? { text: params.text } : {}),
      ...(params.messages ? { messages: params.messages } : {}),
      ...(params.category ? { category: params.category as never } : {}),
      ...(params.categories ? { categories: params.categories } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.metadata ? { metadata: params.metadata as JsonObject } : {}),
    });

    const result = { queued: false, saved: true };

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memorySearchTool = defineTool({
  name: "memory_search",
  label: "Memory Search",
  description: "Search stored memories using the configured memory backend.",
  promptSnippet: "Search memory for relevant saved facts.",
  promptGuidelines: [
    "Use memory_search before answering questions that depend on previously saved preferences or identity details.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Natural-language search query." }),
    categories: Type.Optional(Type.Array(Type.String({ description: "Optional category filters." }))),
    scope: Type.Optional(scopeSchema),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
    threshold: Type.Optional(Type.Number({ description: "Optional backend similarity threshold." })),
    filters: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Backend-specific filters." })),
  }),
  async execute(_toolCallId, params) {
    const result = await memoryService.search({
      query: params.query,
      ...(params.categories ? { categories: params.categories } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
      ...(params.filters ? { filters: params.filters as JsonObject } : {}),
    });

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memoryListTool = defineTool({
  name: "memory_list",
  label: "Memory List",
  description: "List memories from the configured memory backend.",
  parameters: Type.Object({
    scope: Type.Optional(scopeSchema),
  }),
  async execute(_toolCallId, params) {
    const result = await memoryService.list(params.scope);
    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memoryGetTool = defineTool({
  name: "memory_get",
  label: "Memory Get",
  description: "Fetch a specific memory by ID.",
  parameters: Type.Object({
    id: Type.String({ description: "Memory ID." }),
  }),
  async execute(_toolCallId, params) {
    const result = await memoryService.get(params.id);
    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memoryUpdateTool = defineTool({
  name: "memory_update",
  label: "Memory Update",
  description: "Update a specific memory.",
  parameters: Type.Object({
    id: Type.String({ description: "Memory ID." }),
    text: Type.Optional(Type.String({ description: "Replacement memory text." })),
    metadata: Type.Optional(metadataSchema),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    await memoryService.update(params.id, {
      ...(params.text ? { text: params.text } : {}),
      ...(params.metadata ? { metadata: params.metadata as JsonObject } : {}),
    });

    const result = { updated: true, id: params.id };

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memoryDeleteTool = defineTool({
  name: "memory_delete",
  label: "Memory Delete",
  description: "Delete a specific memory.",
  parameters: Type.Object({
    id: Type.String({ description: "Memory ID." }),
  }),
  async execute(_toolCallId, params) {
    await memoryService.delete(params.id);
    const result = { deleted: true, id: params.id };
    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const memoryTools = [
  memoryAddTool,
  memorySearchTool,
  memoryListTool,
  memoryGetTool,
  memoryUpdateTool,
  memoryDeleteTool,
] as const;
