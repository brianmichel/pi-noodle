import { resolveConfig, resolveConfigPath, writeConfig } from "../config.ts";
import { runConfigScreen } from "../config-screen.ts";
import {
  applyDraftDefaults,
  createDraft,
  type DraftConfig,
  summarizeDraft,
  toPartialConfig,
  validateDraft,
} from "../config/schema.ts";
import { describeError } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

const DB_MODE_OPTIONS = [
  "Local   — SQLite file on disk (default)",
  "Cloud   — Turso hosted libSQL (sync everywhere)",
  "Sync    — local-first embedded replica that pushes/pulls to Turso Cloud",
];

const PROVIDER_OPTIONS = [
  "OpenAI     — text-embedding-3-small (needs API key)",
  "LM Studio  — local at http://localhost:1234/v1",
  "Ollama     — local at http://localhost:11434/v1",
  "Custom     — any /v1/embeddings endpoint",
];

const EXTRACTOR_MODE_OPTIONS = [
  "Off — disable proactive extraction",
  "Balanced — default tradeoff",
  "Conservative — lower cost, higher precision",
  "Proactive — more discovery, more review",
];

export async function runSetup(ui: CtxUi): Promise<void> {
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

    const draft = await collectDraftFromPrompts(ui, createDraft(current));
    const errors = validateDraft(draft);
    if (errors.length > 0) {
      ui.notify(`Setup failed: ${errors[0]}`, "error");
      return;
    }

    const ok = await ui.confirm("Save config?", summarizeDraft(draft).join("\n"));
    if (!ok) {
      ui.notify("Setup cancelled.", "info");
      return;
    }

    writeConfig(toPartialConfig(draft));
    ui.notify("Config saved. /reload to apply.", "info");
  } catch (error) {
    ui.notify(`Setup failed: ${describeError(error)}`, "error");
  }
}

async function collectDraftFromPrompts(ui: CtxUi, draft: DraftConfig): Promise<DraftConfig> {
  const dbChoice = await ui.select("Database mode", DB_MODE_OPTIONS);
  draft.dbMode = dbChoice?.startsWith("Cloud") ? "cloud" : dbChoice?.startsWith("Sync") ? "sync" : "local";

  if (draft.dbMode === "local") {
    draft.dbPath = (await ui.input("Database file path", draft.dbPath)) || draft.dbPath;
  } else {
    const isSync = draft.dbMode === "sync";
    draft.dbUrl = await requireInput(
      ui,
      isSync ? "Turso database URL (libsql:// or turso://…)" : "Turso database URL (libsql://…)",
      isSync ? 'URL must start with "libsql://" or "turso://"' : 'URL must start with "libsql://"',
      (value) => isSync ? value.startsWith("libsql://") || value.startsWith("turso://") : value.startsWith("libsql://"),
      draft.dbUrl,
    );
    draft.dbAuthToken = await requireInput(
      ui,
      "Turso auth token",
      "Auth token is required for cloud/sync databases",
      (value) => value.length > 0,
      draft.dbAuthToken,
    );
    if (isSync) {
      draft.dbSyncInterval = (await ui.input("Sync interval in seconds (0 = manual only, default 300)", draft.dbSyncInterval)) || draft.dbSyncInterval;
    }
  }

  const providerChoice = await ui.select("Embedding provider", PROVIDER_OPTIONS);
  draft.embeddingProvider = parseProviderChoice(providerChoice ?? "");
  applyDraftDefaults(draft);

  switch (draft.embeddingProvider) {
    case "openai":
      draft.embeddingApiKey = await requireInput(
        ui,
        "OpenAI API key",
        "API key is required for OpenAI embeddings",
        (value) => value.length > 0,
        draft.embeddingApiKey,
      );
      draft.embeddingModel = (await ui.input("Model name", draft.embeddingModel)) || draft.embeddingModel;
      break;
    case "lm_studio":
      draft.embeddingBaseUrl = (await ui.input("LM Studio base URL", draft.embeddingBaseUrl)) || draft.embeddingBaseUrl;
      break;
    case "ollama":
      draft.embeddingModel = await requireInput(
        ui,
        "Ollama embedding model",
        "Model name is required (e.g. nomic-embed-text)",
        (value) => value.length > 0,
        draft.embeddingModel,
      );
      draft.embeddingBaseUrl = (await ui.input("Ollama base URL", draft.embeddingBaseUrl)) || draft.embeddingBaseUrl;
      break;
    case "custom":
      draft.embeddingBaseUrl = await requireInput(
        ui,
        "Embedding base URL",
        "Base URL is required",
        (value) => value.length > 0,
        draft.embeddingBaseUrl,
      );
      draft.embeddingModel = await requireInput(
        ui,
        "Model name",
        "Model name is required",
        (value) => value.length > 0,
        draft.embeddingModel,
      );
      draft.embeddingApiKey = (await ui.input("API key (or placeholder)", draft.embeddingApiKey)) || draft.embeddingApiKey;
      break;
  }

  const modeChoice = await ui.select("Memory mode", EXTRACTOR_MODE_OPTIONS);
  draft.extractorMode = parseExtractorModeChoice(modeChoice ?? "");
  applyDraftDefaults(draft);

  if (draft.extractorMode !== "off") {
    draft.extractorModel = (await ui.input(
      "Model ID to use for extraction (leave blank to disable extraction)",
      draft.extractorModel,
    )) || draft.extractorModel;
    draft.extractorTriggerEvery = (await ui.input(
      `Extract every N turns (default ${draft.extractorTriggerEvery})`,
      draft.extractorTriggerEvery,
    )) || draft.extractorTriggerEvery;
    draft.extractorDebug = await ui.confirm(
      "Show extractor debug widget?",
      "Enable the live extractor debug widget while developing.",
    );
  }

  return applyDraftDefaults(draft);
}

async function requireInput(
  ui: CtxUi,
  prompt: string,
  errorMessage: string,
  validate: (value: string) => boolean,
  defaultValue?: string,
): Promise<string> {
  let value = (await ui.input(prompt, defaultValue)) ?? "";
  while (!validate(value.trim())) {
    ui.notify(errorMessage, "error");
    value = (await ui.input(prompt, defaultValue)) ?? "";
  }
  return value.trim();
}

function parseProviderChoice(choice: string): DraftConfig["embeddingProvider"] {
  const lower = choice.toLowerCase();
  if (lower.startsWith("openai")) return "openai";
  if (lower.includes("lm") || lower.includes("studio")) return "lm_studio";
  if (lower.startsWith("ollama")) return "ollama";
  return "custom";
}

function parseExtractorModeChoice(choice: string): DraftConfig["extractorMode"] {
  if (choice.startsWith("Off")) return "off";
  if (choice.startsWith("Conservative")) return "conservative";
  if (choice.startsWith("Proactive")) return "proactive";
  return "balanced";
}
