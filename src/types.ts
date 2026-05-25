export type NoodleDbMode = "local" | "cloud";

export type NoodleExtractorMode = "off" | "conservative" | "balanced" | "proactive";

export type NoodleExtractorConfig = {
  /**
   * Behavior profile for proactive extraction.
   * off = disable extractor
   * conservative = fewer runs, higher save threshold
   * balanced = default tradeoff
   * proactive = more candidate discovery, more review load
   */
  mode?: NoodleExtractorMode;
  /**
   * Model ID to use for extraction (e.g. "claude-haiku-4-5-20251001").
   * Must be a model already configured in Pi. Defaults to Pi's configured
   * extractor default when unset.
   */
  model?: string;
  /** Number of user turns between automatic extraction runs. Defaults by mode when unset. */
  triggerEvery?: number;
};

export type NoodleConfig = {
  db: {
    mode: NoodleDbMode;
    /** File path for local mode */
    path: string;
    /** Turso URL for cloud mode (e.g. libsql://my-db.turso.io) */
    url?: string;
    /** Turso auth token for cloud mode */
    authToken?: string;
  };
  embedding: {
    /** Human-readable provider label (openai, lm_studio, ollama, custom) */
    provider: string;
    /** API key or placeholder */
    apiKey: string;
    /** Base URL for the /v1/embeddings endpoint */
    baseUrl: string;
    /** Model name */
    model: string;
    /** Optional explicit embedding dimension override for custom/nonstandard providers. */
    dimensions?: number;
  };
  extractor?: NoodleExtractorConfig;
};

export type NoodleConfigPartial = {
  db?: Partial<NoodleConfig["db"]> & { mode?: NoodleDbMode };
  embedding?: Partial<NoodleConfig["embedding"]>;
  extractor?: Partial<NoodleExtractorConfig>;
};

export type JsonObject = Record<string, unknown>;

export type NotifyLevel = "info" | "error";

export type NotificationTarget = {
  ui: {
    notify: (message: string, level: NotifyLevel) => void;
  };
};

export type SessionManagerLike = {
  getBranch: () => unknown[];
  getSessionFile?: () => string | null | undefined;
  getLeafId?: () => string | null | undefined;
};

export type SessionEntryLike = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};
