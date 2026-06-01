import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands as registerCommandsRuntime } from "./commands.ts";
import {
  configureExtractorDebug,
  maybeStartExtractorDebugOverlay,
  noteUserTurnForExtractorDebug,
} from "./debug-overlay.ts";
import {
  extractorDebug as runtimeExtractorDebug,
  extractorMode as runtimeExtractorMode,
  extractorModelId as runtimeExtractorModelId,
  extractorTriggerEvery as runtimeExtractorTriggerEvery,
  memoryService as runtimeMemoryService,
} from "./memory/runtime.ts";
import type { MemoryCaptureEvent, MemoryCaptureResult, MemoryExtractorResolution, MemoryRecord } from "./memory/types.ts";
import { flushPendingWrites as flushPendingWritesRuntime } from "./session.ts";
import { memoryTools as runtimeMemoryTools } from "./tools.ts";
import type { NoodleExtractorMode } from "./types.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

type MemoryServiceLike = {
  capture: (event: MemoryCaptureEvent) => Promise<MemoryCaptureResult>;
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
    configureExtractorDebug(deps.extractorDebug ?? false, deps.extractorMode, deps.extractorTriggerEvery);

    const buildExtractor = (ctx: ExtractorContext): MemoryCaptureEvent["extractor"] | undefined => {
      if (deps.extractorMode === "off") return undefined;
      return {
        resolve: () => resolveExtractorModel(deps.extractorModelId, ctx.modelRegistry),
      };
    };

    pi.on("session_start", async (_event, ctx) => {
      maybeStartExtractorDebugOverlay(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return { action: "continue" };

      noteUserTurnForExtractorDebug();
      const extractor = buildExtractor(ctx);
      await deps.memoryService.capture({
        type: "user_input",
        text: event.text,
        sessionManager: ctx.sessionManager,
        target: ctx,
        ...(extractor ? { extractor } : {}),
      });

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
      const extractor = buildExtractor(ctx);
      await deps.memoryService.capture({
        type: "session_before_compact",
        sessionManager: ctx.sessionManager,
        target: ctx,
        ...(extractor ? { extractor } : {}),
      });
    });

    pi.on("session_before_switch", async (event, ctx) => {
      const extractor = buildExtractor(ctx);
      await deps.memoryService.capture({
        type: "session_before_switch",
        reason: event.reason,
        sessionManager: ctx.sessionManager,
        target: ctx,
        ...(extractor ? { extractor } : {}),
      });
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const extractor = buildExtractor(ctx);
      await deps.memoryService.capture({
        type: "session_shutdown",
        reason: event.reason,
        sessionManager: ctx.sessionManager,
        ...(extractor ? { extractor } : {}),
      });

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
): Promise<MemoryExtractorResolution | null> {
  if (!extractorModelId) return null;

  const model = modelRegistry.getAll().find((candidate) => candidate.id === extractorModelId);
  if (!model) {
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
