import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  clearConfig,
  readStoredConfig,
  resolveConfig,
  resolveConfigPath,
  resolveSystemUserId,
  writeConfig,
} from "./config.ts";
import { maskSecret, normalizeBaseUrl, normalizeOptionalString } from "./utils.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("mem0-config", {
    description: "Configure Mem0 extension: /mem0-config show | clear | set <baseUrl> <apiKey> [userId]",
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

        ctx.ui.notify(`Mem0 config path: ${configPath}`, "info");
        ctx.ui.notify(`Mem0 base URL: ${baseUrl}`, "info");
        ctx.ui.notify(`Mem0 API key: ${maskSecret(apiKey)}`, "info");
        ctx.ui.notify(`Mem0 configured user ID: ${configuredUserId}`, "info");
        ctx.ui.notify(`Mem0 effective user ID: ${effectiveUserId}`, "info");
        return;
      }

      if (trimmed === "clear") {
        await clearConfig();
        ctx.ui.notify(`Cleared Mem0 config file at ${configPath}.`, "info");
        return;
      }

      if (trimmed.startsWith("set ")) {
        const parts = trimmed.split(/\s+/);
        const baseUrl = parts[1];
        const apiKey = parts[2];
        const userId = parts[3];

        if (!baseUrl || !apiKey) {
          ctx.ui.notify("Usage: /mem0-config set <baseUrl> <apiKey> [userId]", "error");
          return;
        }

        await writeConfig({
          baseUrl,
          apiKey,
          ...(userId ? { userId } : {}),
        });
        ctx.ui.notify(`Saved Mem0 config to ${configPath} (${normalizeBaseUrl(baseUrl)}).`, "info");
        return;
      }

      ctx.ui.notify("Usage: /mem0-config show | clear | set <baseUrl> <apiKey> [userId]", "error");
    },
  });

  pi.registerCommand("mem0-test", {
    description: "Test the configured Mem0 API connection",
    handler: async (_args, ctx) => {
      try {
        const config = await resolveConfig();
        const headers = { "X-API-Key": config.apiKey, Accept: "application/json" };

        const authStatus = await fetch(`${config.baseUrl}/auth/setup-status`, {
          headers,
        });
        const authBody = await authStatus.text();

        if (authStatus.status === 404) {
          ctx.ui.notify(
            "Mem0 auth/setup-status returned 404. This usually means your self-hosted Mem0 build does not expose that auth route.",
            "info",
          );
        } else {
          ctx.ui.notify(`Mem0 setup-status: ${authStatus.status} ${authBody}`.slice(0, 500), "info");
        }

        const docsStatus = await fetch(`${config.baseUrl}/docs`, {
          headers: { Accept: "text/html,application/json" },
        });
        ctx.ui.notify(`Mem0 docs endpoint: ${docsStatus.status}`, docsStatus.ok ? "info" : "error");

        const memoriesUrl = new URL(`${config.baseUrl}/memories`);
        if (config.userId) {
          memoriesUrl.searchParams.set("user_id", config.userId);
        }

        const memoriesStatus = await fetch(memoriesUrl, { headers });
        const memoriesBody = await memoriesStatus.text();
        ctx.ui.notify(
          `Mem0 memories endpoint: ${memoriesStatus.status} ${memoriesBody}`.slice(0, 500),
          memoriesStatus.ok ? "info" : "error",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
