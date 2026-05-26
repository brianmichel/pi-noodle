import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands as registerCommandsRuntime } from "./commands.ts";
import {
  configureExtractorDebug,
  maybeStartExtractorDebugOverlay,
  noteExtractorQueued,
  noteExtractorSkipped,
  noteUserTurnForExtractorDebug,
} from "./debug-overlay.ts";
import {
  extractorDebug as runtimeExtractorDebug,
  extractorMode as runtimeExtractorMode,
  extractorModelId as runtimeExtractorModelId,
  extractorTriggerEvery as runtimeExtractorTriggerEvery,
  memoryService as runtimeMemoryService,
} from "./memory/runtime.ts";
import type { MemoryRecord } from "./memory/types.ts";
import { flushPendingWrites as flushPendingWritesRuntime } from "./session.ts";
import { memoryTools as runtimeMemoryTools } from "./tools.ts";
import type { NotificationTarget, SessionManagerLike, NoodleExtractorMode } from "./types.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

type MemoryServiceLike = {
  queueAutomaticCapture: (text: string, target?: NotificationTarget) => boolean;
  queueLLMExtraction: (
    sessionManager: SessionManagerLike,
    model: Model<Api> | undefined,
    target?: NotificationTarget,
    extractionOptions?: { apiKey?: string; headers?: Record<string, string> },
  ) => boolean;
  queueConsolidation: (target?: NotificationTarget) => void;
  captureSessionConversation: (
    sessionManager: SessionManagerLike,
    reason: string,
    savedSignatures: Set<string>,
    options?: { target?: NotificationTarget; successMessage?: string },
  ) => Promise<boolean>;
  findRelevantMemories: (prompt: string, limit?: number) => Promise<MemoryRecord[]>;
};

export type MemoryExtensionDeps = {
  memoryService: MemoryServiceLike;
  extractorMode: NoodleExtractorMode;
  extractorModelId?: string;
  extractorTriggerEvery: number;
  extractorDebug?: boolean;
  flushPendingWrites: () => Promise<void>;
  memoryTools: readonly RegisteredTool[];
  registerCommands: (pi: ExtensionAPI) => void;
};

type ExtractorModelRegistry = {
  getAll(): Model<Api>[];
  getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
};

/** Looks up the configured extractor model in the registry and resolves its API key.
 *  Returns null when no model is configured, not found, or has no usable auth.
 *  Logs "not found" via the debug overlay so the handler only deals with context checks. */
async function resolveExtractorModel(
  extractorModelId: string | undefined,
  modelRegistry: ExtractorModelRegistry,
): Promise<{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | null> {
  if (!extractorModelId) return null;
  const model = modelRegistry.getAll().find((m) => m.id === extractorModelId);
  if (!model) {
    noteExtractorSkipped(`extractor model "${extractorModelId}" not found in registry`);
    return null;
  }
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return null;
  return { model, apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}) };
}

const runtimeDeps: MemoryExtensionDeps = {
  memoryService: runtimeMemoryService,
  extractorMode: runtimeExtractorMode,
  ...(runtimeExtractorModelId ? { extractorModelId: runtimeExtractorModelId } : {}),
  extractorTriggerEvery: runtimeExtractorTriggerEvery,
  extractorDebug: runtimeExtractorDebug,
  flushPendingWrites: flushPendingWritesRuntime,
  memoryTools: runtimeMemoryTools,
  registerCommands: registerCommandsRuntime,
};

export function createMemoryExtension(deps: MemoryExtensionDeps = runtimeDeps) {
  return function memoryExtension(pi: ExtensionAPI) {
    const savedSessionSignatures = new Set<string>();
    let sessionMessageCount = 0;

    configureExtractorDebug(deps.extractorDebug ?? false, deps.extractorMode, deps.extractorTriggerEvery);

    pi.on("session_start", async (_event, ctx) => {
      maybeStartExtractorDebugOverlay(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" };

      sessionMessageCount++;
      noteUserTurnForExtractorDebug();
      deps.memoryService.queueAutomaticCapture(event.text, ctx);

      if (deps.extractorMode !== "off" && sessionMessageCount % deps.extractorTriggerEvery === 0) {
        const resolved = await resolveExtractorModel(deps.extractorModelId, ctx.modelRegistry);
        if (resolved) {
          noteExtractorQueued("scheduled", resolved.model.id);
          const queued = deps.memoryService.queueLLMExtraction(
            ctx.sessionManager,
            resolved.model,
            ctx,
            { apiKey: resolved.apiKey, ...(resolved.headers ? { headers: resolved.headers } : {}) },
          );
          if (!queued) noteExtractorSkipped("not enough memory-worthy context yet");
        }
      }

      return { action: "continue" };
    });

    pi.on("before_agent_start", async (event) => {
      try {
        const memories = await deps.memoryService.findRelevantMemories(event.prompt, 3);
        if (memories.length === 0) return;

        const memoryLines = memories.map((memory) => `- ${memory.text}`);
        return {
          systemPrompt: `${event.systemPrompt}\n\nRelevant user memory:\n${memoryLines.join("\n")}`,
        };
      } catch {
        return;
      }
    });

    pi.on("session_before_compact", async (_event, ctx) => {
      await deps.memoryService.captureSessionConversation(
        ctx.sessionManager,
        "before_compact",
        savedSessionSignatures,
        {
          target: ctx,
        },
      );
    });

    pi.on("session_before_switch", async (event, ctx) => {
      await deps.memoryService.captureSessionConversation(
        ctx.sessionManager,
        `before_switch:${event.reason}`,
        savedSessionSignatures,
        {
          target: ctx,
        },
      );
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason !== "reload") {
        await deps.memoryService.captureSessionConversation(
          ctx.sessionManager,
          `shutdown:${event.reason}`,
          savedSessionSignatures,
        ).catch(() => undefined);

        if (deps.extractorMode !== "off") {
          const resolved = await resolveExtractorModel(deps.extractorModelId, ctx.modelRegistry);
          if (resolved) {
            noteExtractorQueued(`shutdown:${event.reason}`, resolved.model.id);
            const queued = deps.memoryService.queueLLMExtraction(
              ctx.sessionManager,
              resolved.model,
              undefined,
              { apiKey: resolved.apiKey, ...(resolved.headers ? { headers: resolved.headers } : {}) },
            );
            if (!queued) noteExtractorSkipped("shutdown run skipped: not enough memory-worthy context yet");
          }
        }

        deps.memoryService.queueConsolidation();
      }

      await deps.flushPendingWrites();
    });

    for (const tool of deps.memoryTools) {
      pi.registerTool(tool);
    }

    deps.registerCommands(pi);
  };
}

export default createMemoryExtension();
