import { DEFAULT_EXTRACTOR_MODE, DISABLED_EXTRACTOR_MODE, defaultExtractorTriggerEvery } from "../config.ts";
import type {
  NoodleConfig,
  NoodleConfigPartial,
  NoodleDbMode,
  NoodleEmbeddingProvider,
  NoodleExtractorMode,
} from "../types.ts";

export const EMBEDDING_PROVIDERS = ["openai", "lm_studio", "ollama", "custom"] as const;

export const FIELD = {
  DB_MODE: "dbMode",
  DB_PATH: "dbPath",
  DB_URL: "dbUrl",
  DB_AUTH_TOKEN: "dbAuthToken",
  EMBEDDING_PROVIDER: "embeddingProvider",
  EMBEDDING_API_KEY: "embeddingApiKey",
  EMBEDDING_BASE_URL: "embeddingBaseUrl",
  EMBEDDING_MODEL: "embeddingModel",
  EXTRACTOR_MODE: "extractorMode",
  EXTRACTOR_MODEL: "extractorModel",
  EXTRACTOR_TRIGGER_EVERY: "extractorTriggerEvery",
  EXTRACTOR_DEBUG: "extractorDebug",
} as const;

export type ConfigFieldId = (typeof FIELD)[keyof typeof FIELD];

export type DraftConfig = {
  dbMode: NoodleDbMode;
  dbPath: string;
  dbUrl: string;
  dbAuthToken: string;
  embeddingProvider: NoodleEmbeddingProvider;
  embeddingApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  extractorMode: NoodleExtractorMode;
  extractorModel: string;
  extractorTriggerEvery: string;
  extractorDebug: boolean;
};

export function createDraft(config: NoodleConfig): DraftConfig {
  return applyDraftDefaults({
    dbMode: config.db.mode,
    dbPath: config.db.path,
    dbUrl: config.db.url ?? "libsql://",
    dbAuthToken: config.db.authToken ?? "",
    embeddingProvider: normalizeEmbeddingProvider(config.embedding.provider),
    embeddingApiKey: config.embedding.apiKey,
    embeddingBaseUrl: config.embedding.baseUrl,
    embeddingModel: config.embedding.model,
    extractorMode: config.extractor?.mode ?? DISABLED_EXTRACTOR_MODE,
    extractorModel: config.extractor?.model ?? "",
    extractorTriggerEvery: String(
      config.extractor?.triggerEvery ??
        defaultExtractorTriggerEvery(config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE),
    ),
    extractorDebug: config.extractor?.debug ?? false,
  });
}

export function applyDraftDefaults(draft: DraftConfig): DraftConfig {
  draft.embeddingProvider = normalizeEmbeddingProvider(draft.embeddingProvider);

  if (!draft.dbUrl) draft.dbUrl = "libsql://";
  if (!draft.extractorModel) draft.extractorModel = "";
  if (!draft.extractorTriggerEvery) {
    draft.extractorTriggerEvery = String(defaultExtractorTriggerEvery(activeExtractorMode(draft.extractorMode)));
  }

  switch (draft.embeddingProvider) {
    case "openai":
      draft.embeddingBaseUrl = "https://api.openai.com/v1";
      if (!draft.embeddingModel) draft.embeddingModel = "text-embedding-3-small";
      break;
    case "lm_studio":
      if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "http://localhost:1234/v1";
      draft.embeddingApiKey = "lm-studio";
      draft.embeddingModel = "";
      break;
    case "ollama":
      if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "http://localhost:11434/v1";
      draft.embeddingApiKey = "ollama";
      if (!draft.embeddingModel) draft.embeddingModel = "nomic-embed-text";
      break;
    case "custom":
      if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "https://api.openai.com/v1";
      if (!draft.embeddingModel) draft.embeddingModel = "text-embedding-3-small";
      break;
  }

  return draft;
}

export function validateDraft(draft: DraftConfig): string[] {
  const errors: string[] = [];

  if (draft.dbMode === "local" && !draft.dbPath.trim()) {
    errors.push("Database file path is required for local mode.");
  }
  if (draft.dbMode === "cloud") {
    if (!draft.dbUrl.trim().startsWith("libsql://")) {
      errors.push('Turso database URL must start with "libsql://".');
    }
    if (!draft.dbAuthToken.trim()) {
      errors.push("Turso auth token is required for cloud mode.");
    }
  }

  switch (draft.embeddingProvider) {
    case "openai":
      if (!draft.embeddingApiKey.trim()) errors.push("OpenAI API key is required.");
      if (!draft.embeddingModel.trim()) errors.push("Model name is required.");
      break;
    case "lm_studio":
      if (!draft.embeddingBaseUrl.trim()) errors.push("LM Studio base URL is required.");
      break;
    case "ollama":
      if (!draft.embeddingModel.trim()) errors.push("Ollama embedding model is required.");
      if (!draft.embeddingBaseUrl.trim()) errors.push("Ollama base URL is required.");
      break;
    case "custom":
      if (!draft.embeddingBaseUrl.trim()) errors.push("Embedding base URL is required.");
      if (!draft.embeddingModel.trim()) errors.push("Model name is required.");
      break;
  }

  if (draft.extractorMode !== "off") {
    const turns = parseInt(draft.extractorTriggerEvery.trim(), 10);
    if (Number.isNaN(turns) || turns < 1) {
      errors.push("Extract every N turns must be a positive integer.");
    }
  }

  return errors;
}

export function toPartialConfig(draft: DraftConfig): NoodleConfigPartial {
  const partial: NoodleConfigPartial = {
    db: {
      mode: draft.dbMode,
      path: draft.dbPath.trim(),
      ...(draft.dbMode === "cloud"
        ? { url: draft.dbUrl.trim(), authToken: draft.dbAuthToken.trim() }
        : {}),
    },
    embedding: {
      provider: draft.embeddingProvider,
      apiKey: draft.embeddingApiKey,
      baseUrl: draft.embeddingBaseUrl.trim(),
      model: draft.embeddingModel.trim(),
    },
    extractor: draft.extractorMode !== "off"
      ? {
          mode: draft.extractorMode,
          ...(draft.extractorModel.trim() ? { model: draft.extractorModel.trim() } : {}),
          triggerEvery:
            parseInt(draft.extractorTriggerEvery.trim(), 10) ||
            defaultExtractorTriggerEvery(activeExtractorMode(draft.extractorMode)),
          debug: draft.extractorDebug,
        }
      : { mode: "off" },
  };

  if (draft.embeddingProvider === "lm_studio") {
    partial.embedding!.apiKey = "lm-studio";
    partial.embedding!.model = "";
  }
  if (draft.embeddingProvider === "ollama") {
    partial.embedding!.apiKey = "ollama";
  }
  if (draft.embeddingProvider === "openai") {
    partial.embedding!.baseUrl = "https://api.openai.com/v1";
  }

  return partial;
}

export function summarizeDraft(draft: DraftConfig): string[] {
  return [
    `Database: ${draft.dbMode}  ${draft.dbMode === "cloud" ? draft.dbUrl.trim() : draft.dbPath.trim()}`,
    `Embedding: ${draft.embeddingProvider}  ${draft.embeddingModel.trim() || draft.embeddingBaseUrl.trim()}`,
    draft.extractorMode !== "off" && draft.extractorModel.trim()
      ? `Memory mode: ${draft.extractorMode}  ${draft.extractorModel.trim()}  every ${parseInt(draft.extractorTriggerEvery.trim(), 10) || defaultExtractorTriggerEvery(activeExtractorMode(draft.extractorMode))} turns  debug ${draft.extractorDebug ? "on" : "off"}`
      : "Memory mode: off",
  ];
}

export function labelForField(id: ConfigFieldId): string {
  switch (id) {
    case FIELD.DB_MODE:
      return "Database mode";
    case FIELD.DB_PATH:
      return "Database file path";
    case FIELD.DB_URL:
      return "Turso database URL";
    case FIELD.DB_AUTH_TOKEN:
      return "Turso auth token";
    case FIELD.EMBEDDING_PROVIDER:
      return "Embedding provider";
    case FIELD.EMBEDDING_API_KEY:
      return "API key";
    case FIELD.EMBEDDING_BASE_URL:
      return "Embedding base URL";
    case FIELD.EMBEDDING_MODEL:
      return "Model name";
    case FIELD.EXTRACTOR_MODE:
      return "Memory mode";
    case FIELD.EXTRACTOR_MODEL:
      return "Extractor model ID";
    case FIELD.EXTRACTOR_TRIGGER_EVERY:
      return "Extract every N turns";
    case FIELD.EXTRACTOR_DEBUG:
      return "Extractor debug widget";
  }
}

export function normalizeEmbeddingProvider(value: string): NoodleEmbeddingProvider {
  if (value === "openai" || value === "lm_studio" || value === "ollama" || value === "custom") {
    return value;
  }
  return "custom";
}

export function parseExtractorMode(value: string): NoodleExtractorMode {
  if (value === "off" || value === "conservative" || value === "proactive") return value;
  return "balanced";
}

export function activeExtractorMode(mode: NoodleExtractorMode): Exclude<NoodleExtractorMode, "off"> {
  return mode === "off" ? "balanced" : mode;
}
