import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfig, resolveConfigPath, writeConfig } from "./config.ts";
import { runConfigScreen } from "./config-screen.ts";
import { EXTRACTOR_DEFAULT_MODEL, memoryService } from "./memory/runtime.ts";
import { maskSecret } from "./utils.ts";
import {
  isExplorerRunning,
  openExplorerBrowser,
  readExplorerState,
  spawnExplorer,
  stopExplorer,
} from "./web/manager.ts";

// ---------------------------------------------------------------------------
// Option strings (Pi's ctx.ui.select takes string[], not objects)
// ---------------------------------------------------------------------------

const DB_MODE_OPTIONS = [
  "Local   — SQLite file on disk (default)",
  "Cloud   — Turso hosted libSQL (sync everywhere)",
];

const PROVIDER_OPTIONS = [
  "OpenAI     — text-embedding-3-small (needs API key)",
  "LM Studio  — local at http://localhost:1234/v1",
  "Ollama     — local at http://localhost:11434/v1",
  "Custom     — any /v1/embeddings endpoint",
];

// ---------------------------------------------------------------------------
// Shell types for the ctx.ui surface we actually use
// ---------------------------------------------------------------------------

type CtxUi = {
  select: (t: string, o: string[]) => Promise<string | undefined>;
  input: (p: string, d?: string) => Promise<string | undefined>;
  confirm: (t: string, m: string) => Promise<boolean>;
  notify: (m: string, l: "info" | "error") => void;
  custom?: <T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
  ) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("noodle", {
    description:
      "Noodle memory — status, settings, review, and web explorer",
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "settings" || sub === "setup") {
        await runSetup(ctx.ui as unknown as CtxUi);
        return;
      }

      if (sub === "review") {
        await runReview(ctx.ui as unknown as CtxUi);
        return;
      }

      if (sub === "init") {
        const path = resolveConfigPath();
        writeConfig({});
        ctx.ui.notify(
          `Created config at ${path}. Run /noodle settings to configure.`,
          "info",
        );
        return;
      }

      if (sub.match(/web\s+stop\b/)) {
        if (stopExplorer()) {
          ctx.ui.notify("Memory Explorer stopped.", "info");
        } else {
          ctx.ui.notify("Memory Explorer is not running.", "info");
        }
        return;
      }

      if (sub.startsWith("web")) {
        const dev = /\bdev\b/.test(sub);
        const portMatch = sub.match(/\b(\d{2,5})\b/);
        const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : 3000;

        if (isExplorerRunning()) {
          const running = readExplorerState();
          const activePort = running?.port ?? port;
          openExplorerBrowser(activePort);
          ctx.ui.notify(
            `Memory Explorer already running at http://localhost:${activePort}`,
            "info",
          );
          return;
        }

        const spawned = spawnExplorer(port, dev);
        if (!spawned) {
          ctx.ui.notify("Failed to start Memory Explorer.", "error");
          return;
        }

        ctx.ui.notify(
          dev
            ? `Memory Explorer (dev) starting at http://localhost:${port} — use /noodle web stop when done`
            : `Memory Explorer started at http://localhost:${port} — closes automatically when all tabs are closed`,
          "info",
        );
        return;
      }

      // Default: show status
      const config = resolveConfig();
      ctx.ui.notify("─── Noodle Memory ───", "info");
      ctx.ui.notify("Commands: /noodle settings | /noodle review | /noodle web", "info");
      ctx.ui.notify(`Config: ${resolveConfigPath()}`, "info");
      ctx.ui.notify(
        `Database: ${config.db.mode}  ${showDbTarget(config)}`,
        "info",
      );
      if (config.db.mode === "cloud" && config.db.authToken) {
        ctx.ui.notify(`Auth token: ${maskSecret(config.db.authToken)}`, "info");
      }
      ctx.ui.notify(
        `Embedding: ${config.embedding.provider}  ${config.embedding.model}`,
        "info",
      );
      ctx.ui.notify(`Endpoint: ${config.embedding.baseUrl}`, "info");
      ctx.ui.notify(`API key: ${maskSecret(config.embedding.apiKey)}`, "info");
      if (config.extractor?.enabled) {
        const ec = config.extractor;
        const modelLabel = ec.model ?? EXTRACTOR_DEFAULT_MODEL;
        ctx.ui.notify(
          `Extractor: enabled  ${modelLabel}  every ${ec.triggerEvery ?? 10} turns`,
          "info",
        );
      } else {
        ctx.ui.notify("Extractor: disabled  (run /noodle settings to enable)", "info");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

async function runSetup(ui: CtxUi): Promise<void> {
  try {
    ui.notify(`Config will be saved to: ${resolveConfigPath()}`, "info");

    const current = resolveConfig();
    const screenResult = await runConfigScreen(ui, current);
    if (screenResult) {
      if (screenResult.cancelled) {
        ui.notify("Setup cancelled.", "info");
        return;
      }
      writeConfig(screenResult.partial);
      ui.notify("Config saved. /reload to apply.", "info");
      return;
    }

    // Fallback for environments without custom UI support
    const dbChoice = await ui.select("Database mode", DB_MODE_OPTIONS);
    const dbMode: "local" | "cloud" = dbChoice?.startsWith("Cloud")
      ? "cloud"
      : "local";

    const dbConfig =
      dbMode === "cloud" ? await collectCloudDb(ui) : await collectLocalDb(ui);

    const pChoice = await ui.select("Embedding provider", PROVIDER_OPTIONS);
    const provider = parseProvider(pChoice ?? "");
    const embedConfig = await collectEmbedding(ui, provider);
    const extractorConfig = await collectExtractor(ui);

    const summaryLines = [
      `Database: ${dbMode}  ${dbConfig.summary}`,
      `Embedding: ${provider}  ${embedConfig.summary}`,
    ];
    if (extractorConfig) {
      summaryLines.push(`Extractor: enabled  ${extractorConfig.partial.model ?? "gpt-4o-mini"}`);
    } else {
      summaryLines.push("Extractor: disabled");
    }

    const ok = await ui.confirm("Save config?", summaryLines.join("\n"));
    if (!ok) {
      ui.notify("Setup cancelled.", "info");
      return;
    }

    writeConfig({
      db: dbConfig.partial,
      embedding: embedConfig.partial,
      ...(extractorConfig ? { extractor: extractorConfig.partial } : { extractor: { enabled: false } }),
    });
    ui.notify("Config saved. /reload to apply.", "info");
  } catch (err) {
    ui.notify(
      `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

// ---- DB collectors ----

type DbResult = {
  summary: string;
  partial: Record<string, unknown>;
};

async function collectLocalDb(ui: CtxUi): Promise<DbResult> {
  const path =
    (await ui.input("Database file path", resolveConfig().db.path)) ||
    resolveConfig().db.path;
  return {
    summary: path,
    partial: { mode: "local", path },
  };
}

async function collectCloudDb(ui: CtxUi): Promise<DbResult> {
  const url = await requireInput(
    ui,
    "Turso database URL (libsql://…)",
    'URL must start with "libsql://"',
    (v) => v.startsWith("libsql://"),
  );

  const token = await requireInput(
    ui,
    "Turso auth token",
    "Auth token is required for cloud databases",
    (v) => v.length > 0,
  );

  return {
    summary: url,
    partial: { mode: "cloud", url, authToken: token },
  };
}

// ---- Embedding collectors ----

async function collectEmbedding(
  ui: CtxUi,
  provider: string,
): Promise<{ summary: string; partial: Record<string, unknown> }> {
  switch (provider) {
    case "openai":
      return collectOpenAI(ui);
    case "lm_studio":
      return collectLMStudio(ui);
    case "ollama":
      return collectOllama(ui);
    default:
      return collectCustom(ui);
  }
}

async function collectOpenAI(
  ui: CtxUi,
): Promise<{ summary: string; partial: Record<string, unknown> }> {
  const key = await requireInput(
    ui,
    "OpenAI API key",
    "API key is required for OpenAI embeddings",
    (v) => v.length > 0,
  );
  const model =
    (await ui.input("Model name", "text-embedding-3-small")) ||
    "text-embedding-3-small";

  return {
    summary: model,
    partial: {
      provider: "openai",
      apiKey: key,
      baseUrl: "https://api.openai.com/v1",
      model,
    },
  };
}

async function collectLMStudio(
  ui: CtxUi,
): Promise<{ summary: string; partial: Record<string, unknown> }> {
  const baseUrl =
    (await ui.input("LM Studio base URL", "http://localhost:1234/v1")) ||
    "http://localhost:1234/v1";

  return {
    summary: baseUrl,
    partial: {
      provider: "lm_studio",
      apiKey: "lm-studio",
      baseUrl,
      model: "",
    },
  };
}

async function collectOllama(
  ui: CtxUi,
): Promise<{ summary: string; partial: Record<string, unknown> }> {
  const model = await requireInput(
    ui,
    "Ollama embedding model",
    "Model name is required (e.g. nomic-embed-text)",
    (v) => v.length > 0,
    "nomic-embed-text",
  );

  const baseUrl =
    (await ui.input("Ollama base URL", "http://localhost:11434/v1")) ||
    "http://localhost:11434/v1";

  return {
    summary: `${model} @ ${baseUrl}`,
    partial: {
      provider: "ollama",
      apiKey: "ollama",
      baseUrl,
      model,
    },
  };
}

async function collectCustom(
  ui: CtxUi,
): Promise<{ summary: string; partial: Record<string, unknown> }> {
  const baseUrl = await requireInput(
    ui,
    "Embedding base URL",
    "Base URL is required",
    (v) => v.length > 0,
    "https://api.openai.com/v1",
  );

  const model = await requireInput(
    ui,
    "Model name",
    "Model name is required",
    (v) => v.length > 0,
    "text-embedding-3-small",
  );

  const apiKey = (await ui.input("API key (or placeholder)", "")) || "";

  return {
    summary: `${model} @ ${baseUrl}`,
    partial: { provider: "custom", apiKey, baseUrl, model },
  };
}

// ---- Extractor collector ----

async function collectExtractor(
  ui: CtxUi,
): Promise<{ summary: string; partial: Record<string, unknown> } | null> {
  const enable = await ui.confirm(
    "Enable LLM memory extractor?",
    "Automatically identifies important facts in conversations using Pi's active model. No separate API key needed.",
  );
  if (!enable) return null;

  const modelInput = await ui.input(
    "Model ID to use (leave blank for default)",
    EXTRACTOR_DEFAULT_MODEL,
  );
  const model = modelInput?.trim() || undefined;

  const triggerInput = await ui.input("Extract every N turns (default 10)", "10");
  const triggerEvery = parseInt(triggerInput ?? "10", 10);

  return {
    summary: model ? model : "active model",
    partial: {
      enabled: true,
      ...(model ? { model } : {}),
      triggerEvery: isNaN(triggerEvery) || triggerEvery < 1 ? 10 : triggerEvery,
    },
  };
}

// ---- Review command ----

async function runReview(ui: CtxUi): Promise<void> {
  try {
    const memories = await memoryService.list();

    // Focus on auto-saved memories; show at most 10
    const autoSaved = memories
      .filter((m) => {
        const src = m.metadata.source as string | undefined;
        return src === "heuristic" || src === "repetition" || src === "llm_extracted";
      })
      .slice(0, 10);

    if (autoSaved.length === 0) {
      ui.notify("No auto-saved memories to review.", "info");
      return;
    }

    ui.notify("─── Auto-saved memories ───", "info");
    for (let i = 0; i < autoSaved.length; i++) {
      const m = autoSaved[i]!;
      const src = m.metadata.source ?? "?";
      const cat = m.category ?? m.categories[0] ?? "?";
      const conf = typeof m.metadata.confidence === "number"
        ? ` ${Math.round((m.metadata.confidence as number) * 100)}%`
        : "";
      ui.notify(`[${i + 1}] ${m.text}  (${cat}, ${src}${conf})`, "info");
    }

    const input = await ui.input(
      "Enter numbers to delete (comma-separated), or press Enter to skip",
      "",
    );

    if (!input?.trim()) {
      ui.notify("No changes made.", "info");
      return;
    }

    const indices = input
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((n) => n >= 0 && n < autoSaved.length);

    if (indices.length === 0) {
      ui.notify("No valid selections — no changes made.", "info");
      return;
    }

    const toDelete = indices.map((i) => autoSaved[i]!);
    const preview = toDelete.map((m) => `  • ${m.text}`).join("\n");
    const ok = await ui.confirm(`Delete ${toDelete.length} memories?`, preview);
    if (!ok) {
      ui.notify("Cancelled.", "info");
      return;
    }

    for (const m of toDelete) {
      if (m.id) await memoryService.delete(m.id);
    }
    ui.notify(`Deleted ${toDelete.length} memories.`, "info");
  } catch (err) {
    ui.notify(
      `Review failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireInput(
  ui: CtxUi,
  prompt: string,
  errorMsg: string,
  validate: (value: string) => boolean,
  defaultVal?: string,
): Promise<string> {
  let value = (await ui.input(prompt, defaultVal)) ?? "";
  while (!validate(value.trim())) {
    ui.notify(errorMsg, "error");
    value = (await ui.input(prompt, defaultVal)) ?? "";
  }
  return value.trim();
}

function parseProvider(choice: string): string {
  const lower = choice.toLowerCase();
  if (lower.startsWith("openai")) return "openai";
  if (lower.includes("lm") || lower.includes("studio")) return "lm_studio";
  if (lower.startsWith("ollama")) return "ollama";
  return "custom";
}

function showDbTarget(config: {
  db: { mode: string; path: string; url?: string };
}): string {
  return config.db.mode === "cloud" ? (config.db.url ?? "") : config.db.path;
}
