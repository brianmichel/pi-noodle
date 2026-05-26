import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NoodleConfig, NoodleConfigPartial, NoodleExtractorMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Paths — user-level, not project-level (memories travel with the user)
// ---------------------------------------------------------------------------

const NOODLE_DIR = join(homedir(), ".pi", "noodle");

export function resolveConfigPath(): string {
  return process.env["NOODLE_CONFIG_PATH"] ?? join(NOODLE_DIR, "config.json");
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_EXTRACTOR_MODE: NoodleExtractorMode = "balanced";
export const DISABLED_EXTRACTOR_MODE: NoodleExtractorMode = "off";

export function defaultExtractorTriggerEvery(mode: NoodleExtractorMode = DEFAULT_EXTRACTOR_MODE): number {
  switch (mode) {
    case "conservative":
      return 20;
    case "proactive":
      return 5;
    case "off":
    case "balanced":
    default:
      return 10;
  }
}

const DEFAULTS: NoodleConfig = {
  db: {
    mode: "local",
    path: join(NOODLE_DIR, "memories.db"),
  },
  embedding: {
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  },
  extractor: {
    mode: DISABLED_EXTRACTOR_MODE,
    triggerEvery: defaultExtractorTriggerEvery(DEFAULT_EXTRACTOR_MODE),
    debug: false,
  },
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function resolveConfig(): NoodleConfig {
  const config = structuredClone(DEFAULTS);

  // File overlays defaults
  const filePath = resolveConfigPath();
  if (existsSync(filePath)) {
    try {
      mergeInto(config, JSON.parse(readFileSync(filePath, "utf-8")));
    } catch {
      // corrupt file — skip to env
    }
  }

  // Environment variables take highest priority
  const env = process.env;
  if (env["NOODLE_DB_PATH"]) config.db.path = env["NOODLE_DB_PATH"];
  if (env["NOODLE_DB_URL"]) {
    config.db.url = env["NOODLE_DB_URL"];
    config.db.mode = "cloud";
  }
  if (env["NOODLE_DB_TOKEN"]) config.db.authToken = env["NOODLE_DB_TOKEN"];
  if (env["OPENAI_API_KEY"]) config.embedding.apiKey = env["OPENAI_API_KEY"];
  if (env["EMBEDDING_BASE_URL"]) config.embedding.baseUrl = env["EMBEDDING_BASE_URL"];
  if (env["EMBEDDING_MODEL"]) config.embedding.model = env["EMBEDDING_MODEL"];
  if (env["EMBEDDING_DIMENSIONS"]) {
    const n = parseInt(env["EMBEDDING_DIMENSIONS"], 10);
    if (!isNaN(n) && n > 0) config.embedding.dimensions = n;
  }

  // Extractor env overrides
  if (env["NOODLE_EXTRACTOR_MODE"]) {
    const mode = env["NOODLE_EXTRACTOR_MODE"];
    if (mode === "off" || mode === "conservative" || mode === "balanced" || mode === "proactive") {
      if (!config.extractor) config.extractor = {};
      config.extractor.mode = mode;
      if (!config.extractor.triggerEvery || config.extractor.triggerEvery < 1) {
        config.extractor.triggerEvery = defaultExtractorTriggerEvery(mode === "off" ? DEFAULT_EXTRACTOR_MODE : mode);
      }
    }
  }
  if (env["NOODLE_EXTRACTOR_MODEL"]) {
    if (!config.extractor) config.extractor = {};
    config.extractor.model = env["NOODLE_EXTRACTOR_MODEL"];
    config.extractor.mode ??= DEFAULT_EXTRACTOR_MODE;
  }
  if (env["NOODLE_EXTRACTOR_TRIGGER_EVERY"]) {
    const n = parseInt(env["NOODLE_EXTRACTOR_TRIGGER_EVERY"], 10);
    if (!isNaN(n) && n > 0) {
      if (!config.extractor) config.extractor = {};
      config.extractor.triggerEvery = n;
    }
  }
  if (env["NOODLE_EXTRACTOR_DEBUG"]) {
    if (!config.extractor) config.extractor = {};
    config.extractor.debug = ["1", "true", "yes", "on"].includes(env["NOODLE_EXTRACTOR_DEBUG"].toLowerCase());
  }

  if (config.extractor) {
    config.extractor.mode ??= DISABLED_EXTRACTOR_MODE;
    config.extractor.triggerEvery = config.extractor.triggerEvery && config.extractor.triggerEvery > 0
      ? config.extractor.triggerEvery
      : defaultExtractorTriggerEvery(config.extractor.mode === "off" ? DEFAULT_EXTRACTOR_MODE : config.extractor.mode);
    config.extractor.debug ??= false;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeConfig(partial: NoodleConfigPartial): void {
  const config = resolveConfig();
  mergeInto(config, partial);

  const filePath = resolveConfigPath();
  mkdirSync(NOODLE_DIR, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeInto(target: PlainObject, source: PlainObject): void {
  for (const key of Object.keys(source)) {
    const src = source[key];
    const dst = target[key];
    if (isPlainObject(src) && isPlainObject(dst)) {
      mergeInto(dst, src);
    } else {
      target[key] = src;
    }
  }
}
