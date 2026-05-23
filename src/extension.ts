import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands.ts";
import { extractorEnabled, extractorModelId, extractorTriggerEvery, memoryService } from "./memory/runtime.ts";
import { flushPendingWrites } from "./session.ts";
import { memoryTools } from "./tools.ts";

export default function memoryExtension(pi: ExtensionAPI) {
  const savedSessionSignatures = new Set<string>();
  let sessionMessageCount = 0;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    sessionMessageCount++;
    memoryService.queueAutomaticCapture(event.text, ctx);

    if (extractorEnabled && sessionMessageCount % extractorTriggerEvery === 0) {
      // Resolve the model: prefer the configured model ID; fall back to the active model.
      const model =
        ctx.modelRegistry.getAll().find((m) => m.id === extractorModelId) ??
        ctx.model;
      memoryService.queueLLMExtraction(ctx.sessionManager, model, ctx);
    }

    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event) => {
    try {
      const memories = await memoryService.findRelevantMemories(event.prompt, 3);
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
    await memoryService.captureSessionConversation(
      ctx.sessionManager,
      "before_compact",
      savedSessionSignatures,
      {
        target: ctx,
      },
    );
  });

  pi.on("session_before_switch", async (event, ctx) => {
    await memoryService.captureSessionConversation(
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
      await memoryService.captureSessionConversation(
        ctx.sessionManager,
        `shutdown:${event.reason}`,
        savedSessionSignatures,
      ).catch(() => undefined);

      if (extractorEnabled) {
        const model = extractorModelId
          ? ctx.modelRegistry.getAll().find((m) => m.id === extractorModelId)
          : ctx.model;
        memoryService.queueLLMExtraction(ctx.sessionManager, model);
      }

      memoryService.queueConsolidation();
    }

    await flushPendingWrites();
  });

  for (const tool of memoryTools) {
    pi.registerTool(tool);
  }

  registerCommands(pi);
}
