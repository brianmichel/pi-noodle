import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type Component,
  type SettingItem,
  SettingsList,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import { resolveConfigPath } from "./config.ts";
import { EXTRACTOR_DEFAULT_MODEL } from "./memory/runtime.ts";
import type { NoodleConfig, NoodleConfigPartial } from "./types.ts";

type DoneFn<T> = (result: T) => void;

type TuiLike = TUI;

type ThemeLike = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

type ComponentLike = Component;

type CustomUi = {
  custom?: <T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: DoneFn<T>,
    ) => unknown,
  ) => Promise<T>;
  confirm: (title: string, message: string) => Promise<boolean>;
};

type DraftConfig = {
  dbMode: "local" | "cloud";
  dbPath: string;
  dbUrl: string;
  dbAuthToken: string;
  embeddingProvider: string;
  embeddingApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  extractorEnabled: boolean;
  extractorModel: string;
  extractorTriggerEvery: string;
};

type ConfigScreenResult =
  | { cancelled: true }
  | { cancelled: false; partial: NoodleConfigPartial };

const PROVIDERS = ["openai", "lm_studio", "ollama", "custom"] as const;

const FIELD = {
  DB_MODE: "dbMode",
  DB_PATH: "dbPath",
  DB_URL: "dbUrl",
  DB_AUTH_TOKEN: "dbAuthToken",
  EMBEDDING_PROVIDER: "embeddingProvider",
  EMBEDDING_API_KEY: "embeddingApiKey",
  EMBEDDING_BASE_URL: "embeddingBaseUrl",
  EMBEDDING_MODEL: "embeddingModel",
  EXTRACTOR_ENABLED: "extractorEnabled",
  EXTRACTOR_MODEL: "extractorModel",
  EXTRACTOR_TRIGGER_EVERY: "extractorTriggerEvery",
} as const;

export async function runConfigScreen(
  ui: CustomUi,
  current: NoodleConfig,
): Promise<ConfigScreenResult | null> {
  if (!ui.custom) return null;

  const draft = createDraft(current);

  return await ui.custom<ConfigScreenResult>((rawTui, rawTheme, _kb, done) => {
    const tui = rawTui as TuiLike;
    const theme = rawTheme as ThemeLike;
    let status = "Edit settings like Pi’s built-in settings. Press S to save.";
    let settingsList = createSettingsList();

    const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
    const bold = (text: string) => theme.bold?.(text) ?? text;

    function refresh(): void {
      settingsList.invalidate();
      tui.requestRender();
    }

    function rebuild(message?: string): void {
      if (message) status = message;
      settingsList = createSettingsList();
      tui.requestRender();
    }

    function createSettingsList(): SettingsList {
      const items = buildItems(draft, tui, theme, (id, value) => {
        applyChange(id, value);
      });

      return new SettingsList(
        items,
        Math.min(items.length + 4, 16),
        getSettingsListTheme(),
        (id, newValue) => {
          applyChange(id, newValue);
        },
        () => {
          done({ cancelled: true });
        },
        { enableSearch: true },
      );
    }

    function applyChange(id: string, value: string): void {
      switch (id) {
        case FIELD.DB_MODE:
          draft.dbMode = value === "cloud" ? "cloud" : "local";
          break;
        case FIELD.DB_PATH:
          draft.dbPath = value;
          break;
        case FIELD.DB_URL:
          draft.dbUrl = value;
          break;
        case FIELD.DB_AUTH_TOKEN:
          draft.dbAuthToken = value;
          break;
        case FIELD.EMBEDDING_PROVIDER:
          draft.embeddingProvider = value;
          break;
        case FIELD.EMBEDDING_API_KEY:
          draft.embeddingApiKey = value;
          break;
        case FIELD.EMBEDDING_BASE_URL:
          draft.embeddingBaseUrl = value;
          break;
        case FIELD.EMBEDDING_MODEL:
          draft.embeddingModel = value;
          break;
        case FIELD.EXTRACTOR_ENABLED:
          draft.extractorEnabled = value === "enabled";
          break;
        case FIELD.EXTRACTOR_MODEL:
          draft.extractorModel = value;
          break;
        case FIELD.EXTRACTOR_TRIGGER_EVERY:
          draft.extractorTriggerEvery = value;
          break;
      }

      applyProviderDefaults(draft);
      rebuild(`Updated ${labelForField(id)}.`);
    }

    async function save(): Promise<void> {
      const errors = validateDraft(draft);
      if (errors.length > 0) {
        rebuild(`Fix: ${errors[0]}`);
        return;
      }

      const ok = await ui.confirm(
        "Save noodle config?",
        buildSummary(draft).join("\n"),
      );
      if (!ok) {
        rebuild("Save cancelled.");
        return;
      }

      done({ cancelled: false, partial: toPartial(draft) });
    }

    return {
      render(width: number): string[] {
        const errors = validateDraft(draft);
        const lines = [
          color("accent", bold("Noodle config")),
          `File: ${resolveConfigPath()}`,
          "Env vars still override saved values.",
          color("dim", "Type to search • Enter/Space to change • S to save • Esc to cancel"),
          "",
          ...settingsList.render(width).map((line) => truncateToWidth(line, width)),
          "",
          errors.length > 0
            ? color("warning", `Validation: ${errors[0]}`)
            : color("success", "Validation: OK"),
          `Status: ${status}`,
        ];
        return lines.map((line) => truncateToWidth(line, width));
      },
      invalidate(): void {
        settingsList.invalidate();
      },
      handleInput(data: string): void {
        if (data === "s" || data === "S") {
          void save();
          return;
        }
        settingsList.handleInput(data);
        refresh();
      },
    };
  });
}

function buildItems(
  draft: DraftConfig,
  tui: TuiLike,
  theme: ThemeLike,
  applyChange: (id: string, value: string) => void,
): SettingItem[] {
  const items: SettingItem[] = [
    {
      id: FIELD.DB_MODE,
      label: "Database mode",
      currentValue: draft.dbMode,
      values: ["local", "cloud"],
      description: "Where memories are stored: local SQLite file or Turso cloud libSQL.",
    },
  ];

  if (draft.dbMode === "local") {
    items.push(textItem(
      FIELD.DB_PATH,
      "Database file path",
      draft.dbPath,
      "Path to the local SQLite/libSQL database file.",
      tui,
      theme,
      applyChange,
    ));
  } else {
    items.push(
      textItem(
        FIELD.DB_URL,
        "Turso database URL",
        draft.dbUrl,
        'Hosted libSQL URL. Should start with "libsql://".',
        tui,
        theme,
        applyChange,
      ),
      textItem(
        FIELD.DB_AUTH_TOKEN,
        "Turso auth token",
        maskSecret(draft.dbAuthToken),
        "Access token for the Turso database.",
        tui,
        theme,
        applyChange,
        draft.dbAuthToken,
      ),
    );
  }

  items.push({
    id: FIELD.EMBEDDING_PROVIDER,
    label: "Embedding provider",
    currentValue: draft.embeddingProvider,
    values: [...PROVIDERS],
    description: "Provider used to generate embeddings for memory search.",
  });

  if (draft.embeddingProvider === "openai") {
    items.push(
      textItem(
        FIELD.EMBEDDING_API_KEY,
        "OpenAI API key",
        maskSecret(draft.embeddingApiKey),
        "Required for OpenAI embeddings.",
        tui,
        theme,
        applyChange,
        draft.embeddingApiKey,
      ),
      textItem(
        FIELD.EMBEDDING_MODEL,
        "Model name",
        draft.embeddingModel,
        "Embedding model ID, usually text-embedding-3-small.",
        tui,
        theme,
        applyChange,
      ),
    );
  } else if (draft.embeddingProvider === "lm_studio") {
    items.push(textItem(
      FIELD.EMBEDDING_BASE_URL,
      "LM Studio base URL",
      draft.embeddingBaseUrl,
      "Local OpenAI-compatible embeddings endpoint.",
      tui,
      theme,
      applyChange,
    ));
  } else if (draft.embeddingProvider === "ollama") {
    items.push(
      textItem(
        FIELD.EMBEDDING_MODEL,
        "Ollama embedding model",
        draft.embeddingModel,
        "Model to call, e.g. nomic-embed-text.",
        tui,
        theme,
        applyChange,
      ),
      textItem(
        FIELD.EMBEDDING_BASE_URL,
        "Ollama base URL",
        draft.embeddingBaseUrl,
        "Usually http://localhost:11434/v1.",
        tui,
        theme,
        applyChange,
      ),
    );
  } else {
    items.push(
      textItem(
        FIELD.EMBEDDING_BASE_URL,
        "Embedding base URL",
        draft.embeddingBaseUrl,
        "Any OpenAI-compatible /v1/embeddings endpoint.",
        tui,
        theme,
        applyChange,
      ),
      textItem(
        FIELD.EMBEDDING_MODEL,
        "Model name",
        draft.embeddingModel,
        "Model to send to the embeddings endpoint.",
        tui,
        theme,
        applyChange,
      ),
      textItem(
        FIELD.EMBEDDING_API_KEY,
        "API key",
        maskSecret(draft.embeddingApiKey),
        "Optional key or placeholder required by your provider.",
        tui,
        theme,
        applyChange,
        draft.embeddingApiKey,
      ),
    );
  }

  items.push({
    id: FIELD.EXTRACTOR_ENABLED,
    label: "LLM extractor",
    currentValue: draft.extractorEnabled ? "enabled" : "disabled",
    values: ["enabled", "disabled"],
    description: "Automatically extracts durable facts from conversation turns.",
  });

  if (draft.extractorEnabled) {
    items.push(
      textItem(
        FIELD.EXTRACTOR_MODEL,
        "Extractor model ID",
        draft.extractorModel,
        "Pi model ID used for extraction. Leave default if unsure.",
        tui,
        theme,
        applyChange,
      ),
      textItem(
        FIELD.EXTRACTOR_TRIGGER_EVERY,
        "Extract every N turns",
        draft.extractorTriggerEvery,
        "How often to run automatic extraction.",
        tui,
        theme,
        applyChange,
      ),
    );
  }

  return items;
}

function textItem(
  id: string,
  label: string,
  currentValue: string,
  description: string,
  tui: TuiLike,
  theme: ThemeLike,
  applyChange: (id: string, value: string) => void,
  rawValue?: string,
): SettingItem {
  return {
    id,
    label,
    currentValue,
    description,
    submenu: (existing, done) =>
      createTextEditor(
        tui,
        theme,
        label,
        rawValue ?? existing,
        description,
        (value) => {
          if (value !== undefined) applyChange(id, value);
          done(value);
        },
      ),
  };
}

function createTextEditor(
  tui: TuiLike,
  theme: ThemeLike,
  label: string,
  initialValue: string,
  description: string,
  done: (value?: string) => void,
): ComponentLike {
  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg?.("accent", s) ?? s,
    selectList: {
      selectedPrefix: (t) => theme.fg?.("accent", t) ?? t,
      selectedText: (t) => theme.fg?.("accent", t) ?? t,
      description: (t) => theme.fg?.("muted", t) ?? t,
      scrollInfo: (t) => theme.fg?.("dim", t) ?? t,
      noMatch: (t) => theme.fg?.("warning", t) ?? t,
    },
  };
  const editor = new Editor(tui, editorTheme);
  editor.setText(initialValue);
  editor.onSubmit = (value) => done(value.trim());

  const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
  const bold = (text: string) => theme.bold?.(text) ?? text;

  return {
    render(width: number): string[] {
      const lines = [
        color("accent", bold(label)),
        color("dim", description),
        "",
        ...editor.render(width),
        "",
        color("dim", "Enter to save • Esc to cancel"),
      ];
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
        done(undefined);
        return;
      }
      editor.handleInput(data);
      tui.requestRender();
    },
  };
}

function labelForField(id: string): string {
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
    case FIELD.EXTRACTOR_ENABLED:
      return "LLM extractor";
    case FIELD.EXTRACTOR_MODEL:
      return "Extractor model ID";
    case FIELD.EXTRACTOR_TRIGGER_EVERY:
      return "Extract every N turns";
    default:
      return id;
  }
}

function createDraft(config: NoodleConfig): DraftConfig {
  return {
    dbMode: config.db.mode,
    dbPath: config.db.path,
    dbUrl: config.db.url ?? "libsql://",
    dbAuthToken: config.db.authToken ?? "",
    embeddingProvider: config.embedding.provider,
    embeddingApiKey: config.embedding.apiKey,
    embeddingBaseUrl: config.embedding.baseUrl,
    embeddingModel: config.embedding.model,
    extractorEnabled: config.extractor?.enabled ?? false,
    extractorModel: config.extractor?.model ?? EXTRACTOR_DEFAULT_MODEL,
    extractorTriggerEvery: String(config.extractor?.triggerEvery ?? 10),
  };
}

function applyProviderDefaults(draft: DraftConfig): void {
  if (!PROVIDERS.includes(draft.embeddingProvider as (typeof PROVIDERS)[number])) {
    draft.embeddingProvider = "custom";
  }

  if (draft.embeddingProvider === "openai") {
    draft.embeddingBaseUrl = "https://api.openai.com/v1";
    if (!draft.embeddingModel) draft.embeddingModel = "text-embedding-3-small";
  }
  if (draft.embeddingProvider === "lm_studio") {
    if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "http://localhost:1234/v1";
    draft.embeddingApiKey = "lm-studio";
    draft.embeddingModel = "";
  }
  if (draft.embeddingProvider === "ollama") {
    if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "http://localhost:11434/v1";
    draft.embeddingApiKey = "ollama";
    if (!draft.embeddingModel) draft.embeddingModel = "nomic-embed-text";
  }
  if (draft.embeddingProvider === "custom") {
    if (!draft.embeddingBaseUrl) draft.embeddingBaseUrl = "https://api.openai.com/v1";
    if (!draft.embeddingModel) draft.embeddingModel = "text-embedding-3-small";
  }

  if (!draft.dbUrl) draft.dbUrl = "libsql://";
  if (!draft.extractorModel) draft.extractorModel = EXTRACTOR_DEFAULT_MODEL;
  if (!draft.extractorTriggerEvery) draft.extractorTriggerEvery = "10";
}

function validateDraft(draft: DraftConfig): string[] {
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

  if (draft.embeddingProvider === "openai") {
    if (!draft.embeddingApiKey.trim()) errors.push("OpenAI API key is required.");
    if (!draft.embeddingModel.trim()) errors.push("Model name is required.");
  }
  if (draft.embeddingProvider === "lm_studio") {
    if (!draft.embeddingBaseUrl.trim()) errors.push("LM Studio base URL is required.");
  }
  if (draft.embeddingProvider === "ollama") {
    if (!draft.embeddingModel.trim()) errors.push("Ollama embedding model is required.");
    if (!draft.embeddingBaseUrl.trim()) errors.push("Ollama base URL is required.");
  }
  if (draft.embeddingProvider === "custom") {
    if (!draft.embeddingBaseUrl.trim()) errors.push("Embedding base URL is required.");
    if (!draft.embeddingModel.trim()) errors.push("Model name is required.");
  }

  if (draft.extractorEnabled) {
    const n = parseInt(draft.extractorTriggerEvery.trim(), 10);
    if (Number.isNaN(n) || n < 1) {
      errors.push("Extract every N turns must be a positive integer.");
    }
  }

  return errors;
}

function toPartial(draft: DraftConfig): NoodleConfigPartial {
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
    extractor: draft.extractorEnabled
      ? {
          enabled: true,
          model: draft.extractorModel.trim() || EXTRACTOR_DEFAULT_MODEL,
          triggerEvery: parseInt(draft.extractorTriggerEvery.trim(), 10) || 10,
        }
      : { enabled: false },
  };

  if (draft.embeddingProvider === "openai") {
    partial.embedding!.baseUrl = "https://api.openai.com/v1";
  }
  if (draft.embeddingProvider === "lm_studio") {
    partial.embedding!.apiKey = "lm-studio";
    partial.embedding!.model = "";
  }
  if (draft.embeddingProvider === "ollama") {
    partial.embedding!.apiKey = "ollama";
  }

  return partial;
}

function buildSummary(draft: DraftConfig): string[] {
  return [
    `Database: ${draft.dbMode}  ${draft.dbMode === "cloud" ? draft.dbUrl.trim() : draft.dbPath.trim()}`,
    `Embedding: ${draft.embeddingProvider}  ${draft.embeddingModel.trim() || draft.embeddingBaseUrl.trim()}`,
    draft.extractorEnabled
      ? `Extractor: enabled  ${draft.extractorModel.trim() || EXTRACTOR_DEFAULT_MODEL}  every ${parseInt(draft.extractorTriggerEvery.trim(), 10) || 10} turns`
      : "Extractor: disabled",
  ];
}

function maskSecret(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}${"*".repeat(Math.max(3, value.length - 6))}${value.slice(-3)}`;
}
