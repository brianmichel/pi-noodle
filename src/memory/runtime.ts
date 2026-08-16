import { DEFAULT_EXTRACTOR_MODE, defaultExtractorTriggerEvery, resolveConfig } from "../config.ts";
import type { NoodleConfig } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import { createOpenAIEmbedder } from "./embedders/openai.ts";
import { connectTurso, LazyMemoryBackend, type SyncCapable } from "./turso-client.ts";
import { MemoryService } from "./service.ts";
import { SyncManager } from "./sync-manager.ts";

// ---------------------------------------------------------------------------
// Runtime wiring
//
// Config is resolved from:
//   1. Defaults         — local DB at ~/.pi/noodle/memories.db, OpenAI embedder
//   2. ~/.pi/noodle/config.json  — persisted by /noodle settings
//   3. Environment variables  — NOODLE_DB_PATH, NOODLE_DB_URL, etc.
//
// Use /noodle in Pi to view the current config.
// Use /noodle settings to configure interactively.
// ---------------------------------------------------------------------------

/** Default push/pull interval for `sync` db mode (5 minutes). */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 300;

function createEmbedder(config: NoodleConfig) {
  return createOpenAIEmbedder({
    apiKey: config.embedding.apiKey,
    baseUrl: config.embedding.baseUrl,
    ...(config.embedding.model ? { model: config.embedding.model } : {}),
    ...(config.embedding.dimensions ? { dimensions: config.embedding.dimensions } : {}),
  });
}

const config = resolveConfig();

// Turso connect() is async for local/sync modes; MemoryService is constructed
// synchronously at module load. Defer the connection until first use so merely
// importing this module never opens a database (matching the old lazy libSQL
// client, and keeping tests from locking the user's real DB).
let resolvedSyncDb: SyncCapable | undefined;
let connectPromise: Promise<MemoryBackend> | undefined;

function ensureConnected(): Promise<MemoryBackend> {
  if (!connectPromise) {
    connectPromise = connectTurso(config, createEmbedder(config), {
      provider: config.embedding.provider,
      model: config.embedding.model,
      baseUrl: config.embedding.baseUrl,
    }).then((result) => {
      resolvedSyncDb = result.syncDb;
      return result.backend;
    });
  }
  return connectPromise;
}

export const memoryService = new MemoryService(new LazyMemoryBackend(ensureConnected), {
  extractorMode: config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE,
  extractorTriggerEvery: config.extractor?.triggerEvery ?? defaultExtractorTriggerEvery((config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE) === "off" ? DEFAULT_EXTRACTOR_MODE : (config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE)),
});

export const syncManager = new SyncManager({
  syncMode: config.db.mode === "sync",
  ensureConnected: () => ensureConnected().then(() => undefined),
  getDb: () => resolvedSyncDb,
  ...(config.db.mode === "sync"
    ? { intervalSeconds: config.db.syncIntervalSeconds ?? DEFAULT_SYNC_INTERVAL_SECONDS }
    : {}),
});

/** Behavior profile for proactive extraction. */
export const extractorMode = config.extractor?.mode ?? DEFAULT_EXTRACTOR_MODE;
/** Model ID to use for extraction. Extraction is skipped when unset. */
export const extractorModelId = config.extractor?.model ?? undefined;
/** How many user turns trigger an extraction pass. */
export const extractorTriggerEvery = config.extractor?.triggerEvery ?? defaultExtractorTriggerEvery(extractorMode === "off" ? DEFAULT_EXTRACTOR_MODE : extractorMode);
/** Whether to show the extractor debug widget in Pi. */
export const extractorDebug = config.extractor?.debug ?? false;