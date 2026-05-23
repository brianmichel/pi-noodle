import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { requestJsonWithFallback } from "./api.ts";
import {
  clearConfig,
  readStoredConfig,
  resolveConfig,
  resolveConfigPath,
  resolveSystemUserId,
  writeConfig,
} from "./config.ts";
import { memoryService } from "./memory/runtime.ts";
import { maskSecret, normalizeBaseUrl, normalizeOptionalString } from "./utils.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("memory-config", {
    description: "Configure the default Mem0 memory backend: /memory-config show | clear | set <baseUrl> <apiKey> [userId]",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();
      const configPath = resolveConfigPath();

      if (!trimmed || trimmed === "show") {
        const stored = await readStoredConfig();
        const baseUrl = stored.baseUrl || process.env.MEM0_BASE_URL || "(unset)";
        const apiKey = stored.apiKey || process.env.MEM0_API_KEY || "";
        const configuredUserId = stored.userId || process.env.MEM0_USER_ID || "(unset)";
        const effectiveUserId = normalizeOptionalString(stored.userId || process.env.MEM0_USER_ID)
          || await resolveSystemUserId()
          || "(unresolved)";

        ctx.ui.notify(`Memory backend config path: ${configPath}`, "info");
        ctx.ui.notify(`Memory backend base URL: ${baseUrl}`, "info");
        ctx.ui.notify(`Memory backend API key: ${maskSecret(apiKey)}`, "info");
        ctx.ui.notify(`Memory backend configured user ID: ${configuredUserId}`, "info");
        ctx.ui.notify(`Memory backend effective user ID: ${effectiveUserId}`, "info");
        return;
      }

      if (trimmed === "clear") {
        await clearConfig();
        ctx.ui.notify(`Cleared memory backend config file at ${configPath}.`, "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const parts = trimmed.split(/\s+/);
        const baseUrl = parts[1];
        const apiKey = parts[2];
        const userId = parts[3];

        if (!baseUrl || !apiKey) {
          ctx.ui.notify("Usage: /memory-config set <baseUrl> <apiKey> [userId]", "error");
          return;
        }

        await writeConfig({
          baseUrl,
          apiKey,
          ...(userId ? { userId } : {}),
        });
        ctx.ui.notify(`Saved memory backend config to ${configPath} (${normalizeBaseUrl(baseUrl)}).`, "info");
        return;
      }

      ctx.ui.notify("Usage: /memory-config show | clear | set <baseUrl> <apiKey> [userId]", "error");
    },
  });

  pi.registerCommand("memory-test", {
    description: "Test the configured memory backend connection",
    handler: async (_args, ctx) => {
      try {
        const config = await resolveConfig();
        const headers = { "X-API-Key": config.apiKey, Accept: "application/json" };

        try {
          const authStatus = await requestJsonWithFallback({
            baseUrl: config.baseUrl,
            headers,
            method: "GET",
            pathname: "/auth/setup-status",
            label: "Memory backend auth status",
          });
          ctx.ui.notify(`Memory backend auth status: ${JSON.stringify(authStatus)}`.slice(0, 500), "info");
        } catch (error) {
          ctx.ui.notify(`Auth status check skipped: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), "info");
        }

        const memories = await memoryService.list();
        ctx.ui.notify(`Memory backend list succeeded: ${memories.length} memories visible.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
