import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createClient } from "@libsql/client";
import { resolveConfig } from "../config.ts";
import type { MemoryBackend } from "./backend.ts";
import { createOpenAIEmbedder } from "./embedders/openai.ts";
import { MemoryService } from "./service.ts";
import { TursoBackend } from "./turso-backend.ts";

// ---------------------------------------------------------------------------
// Runtime wiring
//
// Config is resolved from:
//   1. Defaults         — local DB at ~/.pi/noodle/memories.db, OpenAI embedder
//   2. ~/.pi/noodle/config.json  — persisted by /noodle setup
//   3. Environment variables  — NOODLE_DB_PATH, OPENAI_API_KEY, etc.
//
// Use /noodle in Pi to view the current config.
// Use /noodle setup to configure interactively.
// ---------------------------------------------------------------------------

function createBackend(): MemoryBackend {
  const config = resolveConfig();

  // Ensure parent directory exists for local mode
  if (config.db.mode === "local") {
    mkdirSync(dirname(config.db.path), { recursive: true });
  }

  // Build the libSQL client URL
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
  });

  const dbOptions: Record<string, unknown> = { url: dbUrl };
  if (config.db.mode === "cloud" && config.db.authToken) {
    dbOptions.authToken = config.db.authToken;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createClient(dbOptions as any);
  return new TursoBackend(db, embedder);
}

export const memoryService = new MemoryService(createBackend());
