import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands.ts";
import { flushPendingWrites, saveSessionMemories } from "./session.ts";
import { mem0Tools } from "./tools.ts";

export default function mem0ClientExtension(pi: ExtensionAPI) {
  const savedSessionSignatures = new Set<string>();

  pi.on("session_before_compact", async (_event, ctx) => {
    const saved = await saveSessionMemories(
      ctx.sessionManager,
      "before_compact",
      savedSessionSignatures,
      {
        target: ctx,
        successMessage: "Saved session memories to Mem0 before compacting.",
      },
    );

    if (saved) {
      ctx.ui.notify("Queued session memories for async Mem0 save before compacting.", "info");
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const saved = await saveSessionMemories(
      ctx.sessionManager,
      `before_switch:${event.reason}`,
      savedSessionSignatures,
      {
        target: ctx,
        successMessage: "Saved session memories to Mem0 before switching sessions.",
      },
    );

    if (saved) {
      ctx.ui.notify("Queued session memories for async Mem0 save before switching sessions.", "info");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload") {
      await saveSessionMemories(
        ctx.sessionManager,
        `shutdown:${event.reason}`,
        savedSessionSignatures,
      );
    }

    await flushPendingWrites();
  });

  for (const tool of mem0Tools) {
    pi.registerTool(tool);
  }

  registerCommands(pi);
}
