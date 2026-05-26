import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createClient } from "@libsql/client";
import { DEFAULT_EXTRACTOR_MODE, defaultExtractorTriggerEvery, resolveConfig } from "../config.ts";
import type { NoodleConfig } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import { createOpenAIEmbedder } from "./embedders/openai.ts";
import { MemoryService } from "./service.ts";
import { TursoBackend } from "./turso-backend.ts";

// ---------------------------------------------------------------------------
// Runtime wiring
//
// Config is resolved from:
//   1. Defaults         — local DB at ~/.pi/noodle/memories.db, OpenAI embedder
//   2. ~/.pi/noodle/config.json  — persisted by /noodle settings
//   3. Environment variables  — NOODLE_DB_PATH, OPENAI_API_KEY, etc.
//
// Use /noodle in Pi to view the current config.
// Use /noodle settings to configure interactively.
// ---------------------------------------------------------------------------

function createBackend(config: NoodleConfig): MemoryBackend {
  if (config.db.mode === "local") {
    mkdirSync(dirname(config.db.path), { recursive: true });
  }

  let dbUrl: string;
  if (config.db.mode === "cloud") {
    dbUrl = config.db.url ?? "libsql://";
  } else {
    dbUrl = `file:${config.db.path}`;
  }

  const embedder = createOpenAIEmbedder({
    apiKey: config.embedding.apiKey,
    baseUrl: config.embedding.baseUrl,
    ...(config.embedding.model ? { model: config.embedding.model } : {}),
    ...(config.embedding.dimensions ? { dimensions: config.embedding.dimensions } : {}),
  });

  const dbOptions: Record<string, unknown> = { url: dbUrl };
  if (config.db.mode === "cloud" && config.db.authToken) {
    dbOptions.authToken = config.db.authToken;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(dbOptions as any);
  return new TursoBackend(db, embedder, {
    provider: config.embedding.provider,
    model: config.embedding.model,
    baseUrl: config.embedding.baseUrl,
  });
}

const config = resolveConfig();
export const memoryService = new MemoryService(createBackend(config), {
  extractorMode: config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE,
});

/** Behavior profile for proactive extraction. */
export const extractorMode = config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE;
/** Model ID to use for extraction. Extraction is skipped when unset. */
export const extractorModelId = config.extractor?.model ?? undefined;
/** How many user turns trigger an extraction pass. */
export const extractorTriggerEvery = config.extractor?.triggerEvery ?? defaultExtractorTriggerEvery(extractorMode === "off" ? DEFAULT_EXTRACTOR_MODE : extractorMode);
/** Whether to show the extractor debug widget in Pi. */
export const extractorDebug = config.extractor?.debug ?? false;
