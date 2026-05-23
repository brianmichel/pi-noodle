import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { buildSearchPayload, mem0Request } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { enqueueWriteTask } from "./queue.ts";
import { ensureMessages, resolveAgentId } from "./session.ts";
import type { JsonObject } from "./types.ts";
import { formatJson, normalizeOptionalString } from "./utils.ts";

export const mem0AddMemoryTool = defineTool({
  name: "mem0_add_memory",
  label: "Mem0 Add Memory",
  description: "Store a new memory in the configured Mem0 API service.",
  promptSnippet: "Store important user or agent facts in Mem0.",
  promptGuidelines: [
    "Use mem0_add_memory when the user asks to save a fact, preference, or context into Mem0.",
  ],
  parameters: Type.Object({
    memory: Type.Optional(Type.String({ description: "Convenience text memory to wrap as a single user message." })),
    messages: Type.Optional(
      Type.Array(
        Type.Object({
          role: Type.String({ description: "Message role, usually user or assistant." }),
          content: Type.String({ description: "Message text content." }),
        }),
        { description: "Conversation messages to send to Mem0 for extraction." },
      ),
    ),
    user_id: Type.Optional(Type.String({ description: "End-user identifier." })),
    agent_id: Type.Optional(Type.String({ description: "Agent identifier." })),
    run_id: Type.Optional(Type.String({ description: "Run/session identifier." })),
    metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional metadata to store with the memory." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const config = await resolveConfig();
    const payload: JsonObject = {
      messages: ensureMessages(params.memory, params.messages),
      agent_id: resolveAgentId(params.agent_id),
    };

    const effectiveUserId = normalizeOptionalString(params.user_id) || config.userId;
    if (effectiveUserId) payload.user_id = effectiveUserId;
    if (params.run_id) payload.run_id = params.run_id;
    if (params.metadata) payload.metadata = params.metadata;

    const jobId = enqueueWriteTask({
      label: "Mem0 add memory",
      target: ctx,
      task: async () => {
        await mem0Request("POST", "/memories", payload);
      },
    });

    const result = {
      queued: true,
      job_id: jobId,
      user_id: effectiveUserId,
      agent_id: payload.agent_id,
    };

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0SearchMemoriesTool = defineTool({
  name: "mem0_search_memories",
  label: "Mem0 Search Memories",
  description: "Search memories in the configured Mem0 API service.",
  promptSnippet: "Search Mem0 for relevant saved facts.",
  promptGuidelines: [
    "Use mem0_search_memories before answering questions that depend on stored Mem0 context.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Natural-language search query." }),
    user_id: Type.Optional(Type.String({ description: "Filter by user ID." })),
    agent_id: Type.Optional(Type.String({ description: "Filter by agent ID." })),
    run_id: Type.Optional(Type.String({ description: "Filter by run ID." })),
    top_k: Type.Optional(Type.Number({ description: "Maximum number of results." })),
    threshold: Type.Optional(Type.Number({ description: "Minimum semantic score threshold." })),
    filters: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Additional Mem0 filters object." })),
  }),
  async execute(_toolCallId, params) {
    const config = await resolveConfig();
    const effectiveUserId = normalizeOptionalString(params.user_id) || config.userId;
    const agentId = normalizeOptionalString(params.agent_id);
    const runId = normalizeOptionalString(params.run_id);
    const result = await mem0Request(
      "POST",
      "/search",
      buildSearchPayload({
        query: params.query,
        ...(params.top_k !== undefined ? { top_k: params.top_k } : {}),
        ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        ...(runId ? { run_id: runId } : {}),
        ...(params.filters ? { filters: params.filters as JsonObject } : {}),
        ...(effectiveUserId ? { user_id: effectiveUserId } : {}),
      }),
    );

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0ListMemoriesTool = defineTool({
  name: "mem0_list_memories",
  label: "Mem0 List Memories",
  description: "List memories from Mem0 by user, agent, or run.",
  parameters: Type.Object({
    user_id: Type.Optional(Type.String({ description: "Filter by user ID." })),
    agent_id: Type.Optional(Type.String({ description: "Filter by agent ID." })),
    run_id: Type.Optional(Type.String({ description: "Filter by run ID." })),
  }),
  async execute(_toolCallId, params) {
    const config = await resolveConfig();
    const result = await mem0Request("GET", "/memories", undefined, {
      user_id: normalizeOptionalString(params.user_id) || config.userId,
      agent_id: normalizeOptionalString(params.agent_id),
      run_id: normalizeOptionalString(params.run_id),
    });

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0GetMemoryTool = defineTool({
  name: "mem0_get_memory",
  label: "Mem0 Get Memory",
  description: "Fetch a specific memory by ID from Mem0.",
  parameters: Type.Object({
    memory_id: Type.String({ description: "Memory ID." }),
  }),
  async execute(_toolCallId, params) {
    const result = await mem0Request("GET", `/memories/${encodeURIComponent(params.memory_id)}`);
    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0UpdateMemoryTool = defineTool({
  name: "mem0_update_memory",
  label: "Mem0 Update Memory",
  description: "Update a specific memory in Mem0.",
  parameters: Type.Object({
    memory_id: Type.String({ description: "Memory ID." }),
    text: Type.Optional(Type.String({ description: "Replacement memory text." })),
    data: Type.Optional(Type.String({ description: "OSS-compatible replacement memory text." })),
    metadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Updated metadata." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    await resolveConfig();

    const payload: JsonObject = {};
    if (params.text) payload.text = params.text;
    if (!params.text && params.data) payload.data = params.data;
    if (params.metadata) payload.metadata = params.metadata;

    if (Object.keys(payload).length === 0) {
      throw new Error("Provide text, data, or metadata for the update.");
    }

    const jobId = enqueueWriteTask({
      label: "Mem0 update memory",
      target: ctx,
      task: async () => {
        await mem0Request("PUT", `/memories/${encodeURIComponent(params.memory_id)}`, payload);
      },
    });

    const result = {
      queued: true,
      job_id: jobId,
      memory_id: params.memory_id,
    };

    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0DeleteMemoryTool = defineTool({
  name: "mem0_delete_memory",
  label: "Mem0 Delete Memory",
  description: "Delete a specific memory from Mem0.",
  parameters: Type.Object({
    memory_id: Type.String({ description: "Memory ID." }),
  }),
  async execute(_toolCallId, params) {
    const result = await mem0Request("DELETE", `/memories/${encodeURIComponent(params.memory_id)}`);
    return {
      content: [{ type: "text", text: formatJson(result) }],
      details: result,
    };
  },
});

export const mem0Tools = [
  mem0AddMemoryTool,
  mem0SearchMemoriesTool,
  mem0ListMemoriesTool,
  mem0GetMemoryTool,
  mem0UpdateMemoryTool,
  mem0DeleteMemoryTool,
] as const;
