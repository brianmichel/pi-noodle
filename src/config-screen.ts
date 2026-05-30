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
import {
  applyDraftDefaults,
  createDraft,
  type ConfigFieldId,
  type DraftConfig,
  EMBEDDING_PROVIDERS,
  FIELD,
  labelForField,
  parseExtractorMode,
  summarizeDraft,
  toPartialConfig,
  validateDraft,
} from "./config/schema.ts";
import type { NoodleConfig, NoodleConfigPartial, NoodleEmbeddingProvider } from "./types.ts";
import { maskSecret } from "./utils.ts";

type DoneFn<T> = (result: T) => void;
type TuiLike = TUI;
type ComponentLike = Component;

type ThemeLike = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

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

type ConfigScreenResult =
  | { cancelled: true }
  | { cancelled: false; partial: NoodleConfigPartial };

type TextFieldSpec = {
  id: ConfigFieldId;
  label: string;
  description: string;
  value: string;
  rawValue?: string;
};

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
      const items = buildItems(draft, tui, theme, applyChange);
      return new SettingsList(
        items,
        Math.min(items.length + 4, 16),
        getSettingsListTheme(),
        applyChange,
        () => done({ cancelled: true }),
        { enableSearch: true },
      );
    }

    function applyChange(id: string, value: string): void {
      applyDraftChange(draft, id as ConfigFieldId, value);
      rebuild(`Updated ${labelForField(id as ConfigFieldId)}.`);
    }

    async function save(): Promise<void> {
      const errors = validateDraft(draft);
      if (errors.length > 0) {
        rebuild(`Fix: ${errors[0]}`);
        return;
      }

      const ok = await ui.confirm("Save noodle config?", summarizeDraft(draft).join("\n"));
      if (!ok) {
        rebuild("Save cancelled.");
        return;
      }

      done({ cancelled: false, partial: toPartialConfig(draft) });
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
    choiceItem(FIELD.DB_MODE, "Database mode", draft.dbMode, ["local", "cloud"], "Where memories are stored: local SQLite file or Turso cloud libSQL."),
  ];

  if (draft.dbMode === "local") {
    items.push(textFieldItem(draft, tui, theme, applyChange, {
      id: FIELD.DB_PATH,
      label: "Database file path",
      description: "Path to the local SQLite/libSQL database file.",
      value: draft.dbPath,
    }));
  } else {
    items.push(
      textFieldItem(draft, tui, theme, applyChange, {
        id: FIELD.DB_URL,
        label: "Turso database URL",
        description: 'Hosted libSQL URL. Should start with "libsql://".',
        value: draft.dbUrl,
      }),
      textFieldItem(draft, tui, theme, applyChange, {
        id: FIELD.DB_AUTH_TOKEN,
        label: "Turso auth token",
        description: "Access token for the Turso database.",
        value: maskSecret(draft.dbAuthToken),
        rawValue: draft.dbAuthToken,
      }),
    );
  }

  items.push(choiceItem(
    FIELD.EMBEDDING_PROVIDER,
    "Embedding provider",
    draft.embeddingProvider,
    [...EMBEDDING_PROVIDERS],
    "Provider used to generate embeddings for memory search.",
  ));

  items.push(...buildEmbeddingItems(draft, tui, theme, applyChange));

  items.push(choiceItem(
    FIELD.EXTRACTOR_MODE,
    "Memory mode",
    draft.extractorMode,
    ["off", "conservative", "balanced", "proactive"],
    "Off disables extraction. Conservative saves less, proactive discovers more, balanced is the default.",
  ));

  if (draft.extractorMode !== "off") {
    items.push(
      textFieldItem(draft, tui, theme, applyChange, {
        id: FIELD.EXTRACTOR_MODEL,
        label: "Extractor model ID",
        description: "Pi model ID used for extraction. Change this to trade quality, speed, and cost.",
        value: draft.extractorModel,
      }),
      textFieldItem(draft, tui, theme, applyChange, {
        id: FIELD.EXTRACTOR_TRIGGER_EVERY,
        label: "Extract every N turns",
        description: "How often to run automatic extraction. Leave the mode default unless you want manual control.",
        value: draft.extractorTriggerEvery,
      }),
      choiceItem(
        FIELD.EXTRACTOR_DEBUG,
        "Extractor debug widget",
        draft.extractorDebug ? "on" : "off",
        ["off", "on"],
        "Show the live extractor debug widget in Pi while developing.",
      ),
    );
  }

  return items;
}

function buildEmbeddingItems(
  draft: DraftConfig,
  tui: TuiLike,
  theme: ThemeLike,
  applyChange: (id: string, value: string) => void,
): SettingItem[] {
  switch (draft.embeddingProvider) {
    case "openai":
      return [
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_API_KEY,
          label: "OpenAI API key",
          description: "Required for OpenAI embeddings.",
          value: maskSecret(draft.embeddingApiKey),
          rawValue: draft.embeddingApiKey,
        }),
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_MODEL,
          label: "Model name",
          description: "Embedding model ID, usually text-embedding-3-small.",
          value: draft.embeddingModel,
        }),
      ];
    case "lm_studio":
      return [textFieldItem(draft, tui, theme, applyChange, {
        id: FIELD.EMBEDDING_BASE_URL,
        label: "LM Studio base URL",
        description: "Local OpenAI-compatible embeddings endpoint.",
        value: draft.embeddingBaseUrl,
      })];
    case "ollama":
      return [
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_MODEL,
          label: "Ollama embedding model",
          description: "Model to call, e.g. nomic-embed-text.",
          value: draft.embeddingModel,
        }),
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_BASE_URL,
          label: "Ollama base URL",
          description: "Usually http://localhost:11434/v1.",
          value: draft.embeddingBaseUrl,
        }),
      ];
    case "custom":
      return [
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_BASE_URL,
          label: "Embedding base URL",
          description: "Any OpenAI-compatible /v1/embeddings endpoint.",
          value: draft.embeddingBaseUrl,
        }),
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_MODEL,
          label: "Model name",
          description: "Model to send to the embeddings endpoint.",
          value: draft.embeddingModel,
        }),
        textFieldItem(draft, tui, theme, applyChange, {
          id: FIELD.EMBEDDING_API_KEY,
          label: "API key",
          description: "Optional key or placeholder required by your provider.",
          value: maskSecret(draft.embeddingApiKey),
          rawValue: draft.embeddingApiKey,
        }),
      ];
  }
}

function choiceItem(
  id: string,
  label: string,
  currentValue: string,
  values: string[],
  description: string,
): SettingItem {
  return { id, label, currentValue, values, description };
}

function textFieldItem(
  _draft: DraftConfig,
  tui: TuiLike,
  theme: ThemeLike,
  applyChange: (id: string, value: string) => void,
  spec: TextFieldSpec,
): SettingItem {
  return {
    id: spec.id,
    label: spec.label,
    currentValue: spec.value,
    description: spec.description,
    submenu: (existing, done) =>
      createTextEditor(
        tui,
        theme,
        spec.label,
        spec.rawValue ?? existing,
        spec.description,
        (value) => {
          if (value !== undefined) applyChange(spec.id, value);
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
      return [
        color("accent", bold(label)),
        color("dim", description),
        "",
        ...editor.render(width),
        "",
        color("dim", "Enter to save • Esc to cancel"),
      ].map((line) => truncateToWidth(line, width));
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

function applyDraftChange(draft: DraftConfig, id: ConfigFieldId, value: string): void {
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
      draft.embeddingProvider = normalizeProviderSelection(value);
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
    case FIELD.EXTRACTOR_MODE:
      draft.extractorMode = parseExtractorMode(value);
      break;
    case FIELD.EXTRACTOR_MODEL:
      draft.extractorModel = value;
      break;
    case FIELD.EXTRACTOR_TRIGGER_EVERY:
      draft.extractorTriggerEvery = value;
      break;
    case FIELD.EXTRACTOR_DEBUG:
      draft.extractorDebug = value === "on";
      break;
  }

  applyDraftDefaults(draft);
}

function normalizeProviderSelection(value: string): NoodleEmbeddingProvider {
  if (value === "openai" || value === "lm_studio" || value === "ollama") return value;
  return "custom";
}
