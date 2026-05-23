import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfig, resolveConfigPath, writeConfig } from "./config.ts";
import { maskSecret } from "./utils.ts";

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
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("noodle", {
    description:
      "Noodle memory config — /noodle | /noodle setup | /noodle init",
    handler: async (args, ctx) => {
      const sub = args.trim();

      if (sub === "setup") {
        await runSetup(ctx.ui as unknown as CtxUi);
        return;
      }

      if (sub === "init") {
        const path = resolveConfigPath();
        writeConfig({});
        ctx.ui.notify(
          `Created config at ${path}. Run /noodle setup to configure.`,
          "info",
        );
        return;
      }

      // Default: show status
      const config = resolveConfig();
      ctx.ui.notify("─── Noodle Memory ───", "info");
      ctx.ui.notify(`Config: ${resolveConfigPath()}`, "info");
      ctx.ui.notify(
        `Database: ${config.db.mode}  ${showDbTarget(config)}`,
        "info",
      );
      if (config.db.mode === "cloud" && config.db.authToken) {
        ctx.ui.notify(
          `Auth token: ${maskSecret(config.db.authToken)}`,
          "info",
        );
      }
      ctx.ui.notify(
        `Embedding: ${config.embedding.provider}  ${config.embedding.model}`,
        "info",
      );
      ctx.ui.notify(`Endpoint: ${config.embedding.baseUrl}`, "info");
      ctx.ui.notify(
        `API key: ${maskSecret(config.embedding.apiKey)}`,
        "info",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

async function runSetup(ui: CtxUi): Promise<void> {
  try {
    ui.notify(`Config will be saved to: ${resolveConfigPath()}`, "info");

    // 1. Database mode
    const dbChoice = await ui.select("Database mode", DB_MODE_OPTIONS);
    const dbMode: "local" | "cloud" =
      dbChoice?.startsWith("Cloud") ? "cloud" : "local";

    const dbConfig = dbMode === "cloud"
      ? await collectCloudDb(ui)
      : await collectLocalDb(ui);

    // 2. Embedding provider
    const pChoice = await ui.select("Embedding provider", PROVIDER_OPTIONS);
    const provider = parseProvider(pChoice ?? "");

    const embedConfig = await collectEmbedding(ui, provider);

    // 3. Confirm
    const summary = [
      `Database: ${dbMode}  ${dbConfig.summary}`,
      `Embedding: ${provider}  ${embedConfig.summary}`,
    ].join("\n");

    const ok = await ui.confirm("Save config?", summary);
    if (!ok) {
      ui.notify("Setup cancelled.", "info");
      return;
    }

    writeConfig({ db: dbConfig.partial, embedding: embedConfig.partial });
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

  const apiKey =
    (await ui.input("API key (or placeholder)", "")) || "";

  return {
    summary: `${model} @ ${baseUrl}`,
    partial: { provider: "custom", apiKey, baseUrl, model },
  };
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

function showDbTarget(config: { db: { mode: string; path: string; url?: string } }): string {
  return config.db.mode === "cloud" ? (config.db.url ?? "") : config.db.path;
}
