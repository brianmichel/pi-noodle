export type Mem0Config = {
  baseUrl: string;
  apiKey: string;
  userId?: string;
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
