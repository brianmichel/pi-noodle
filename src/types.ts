export type NoodleDbMode = "local" | "cloud";

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
  };
};

export type NoodleConfigPartial = {
  db?: Partial<NoodleConfig["db"]> & { mode?: NoodleDbMode };
  embedding?: Partial<NoodleConfig["embedding"]>;
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
