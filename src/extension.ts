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
import type { NotificationTarget, NoodleExtractorMode, SessionManagerLike } from "./types.ts";

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

type ExtractorContext = {
  modelRegistry: ExtractorModelRegistry;
  sessionManager: SessionManagerLike;
};

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

    const captureSession = (
      reason: string,
      sessionManager: SessionManagerLike,
      options?: { target?: NotificationTarget; successMessage?: string },
    ) => deps.memoryService.captureSessionConversation(sessionManager, reason, savedSessionSignatures, options);

    const maybeQueueExtraction = async (
      reason: string,
      ctx: ExtractorContext,
      target?: NotificationTarget,
    ): Promise<boolean> => {
      if (deps.extractorMode === "off") return false;

      const resolved = await resolveExtractorModel(deps.extractorModelId, ctx.modelRegistry);
      if (!resolved) return false;

      noteExtractorQueued(reason, resolved.model.id);
      const queued = deps.memoryService.queueLLMExtraction(
        ctx.sessionManager,
        resolved.model,
        target,
        { apiKey: resolved.apiKey, ...(resolved.headers ? { headers: resolved.headers } : {}) },
      );

      if (!queued) {
        noteExtractorSkipped(
          reason.startsWith("shutdown:")
            ? "shutdown run skipped: not enough memory-worthy context yet"
            : "not enough memory-worthy context yet",
        );
      }
      return queued;
    };

    pi.on("session_start", async (_event, ctx) => {
      maybeStartExtractorDebugOverlay(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" };

      sessionMessageCount += 1;
      noteUserTurnForExtractorDebug();
      deps.memoryService.queueAutomaticCapture(event.text, ctx);

      const shouldExtract =
        deps.extractorMode !== "off" && sessionMessageCount % deps.extractorTriggerEvery === 0;
      if (shouldExtract) {
        await maybeQueueExtraction("scheduled", ctx, ctx);
      }

      return { action: "continue" };
    });

    pi.on("before_agent_start", async (event) => {
      try {
        const memories = await deps.memoryService.findRelevantMemories(event.prompt, 3);
        if (memories.length === 0) return;

        return {
          systemPrompt: `${event.systemPrompt}\n\nRelevant user memory:\n${memories.map((memory) => `- ${memory.text}`).join("\n")}`,
        };
      } catch {
        return;
      }
    });

    pi.on("session_before_compact", async (_event, ctx) => {
      await captureSession("before_compact", ctx.sessionManager, { target: ctx });
    });

    pi.on("session_before_switch", async (event, ctx) => {
      await captureSession(`before_switch:${event.reason}`, ctx.sessionManager, { target: ctx });
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason !== "reload") {
        await captureSession(`shutdown:${event.reason}`, ctx.sessionManager).catch(() => undefined);
        await maybeQueueExtraction(`shutdown:${event.reason}`, ctx);
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

async function resolveExtractorModel(
  extractorModelId: string | undefined,
  modelRegistry: ExtractorModelRegistry,
): Promise<{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | null> {
  if (!extractorModelId) return null;

  const model = modelRegistry.getAll().find((candidate) => candidate.id === extractorModelId);
  if (!model) {
    noteExtractorSkipped(`extractor model "${extractorModelId}" not found in registry`);
    return null;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth.apiKey) return null;

  return {
    model,
    apiKey: auth.apiKey,
    ...(auth.headers ? { headers: auth.headers } : {}),
  };
}

export default createMemoryExtension();
