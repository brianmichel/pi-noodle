import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { NoodleConfig } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import type { Embedder } from "./embedder.ts";
import { TursoBackend } from "./turso-backend.ts";
import type {
  AddMemoryInput,
  ConsolidationReport,
  MemoryListInput,
  MemoryRecord,
  MemorySearchInput,
  UpdateMemoryInput,
} from "./types.ts";
// Types
/**
 * The libSQL-client-compatible surface that {@link TursoBackend} expects.
 *
 * `@tursodatabase/serverless/compat` already exposes this exact shape, so for
 * `cloud` mode we use that client directly. For `local`/`sync` modes we adapt
 * a Turso `Database` ({@link libsqlCompat}) to this shape.
 */
export type LibsqlRow = Record<string, unknown>;

export interface LibsqlResultSet {
  columns: string[];
  columnTypes: string[];
  rows: LibsqlRow[];
  rowsAffected: number;
  lastInsertRowid?: bigint | number;
}

export type LibsqlStatement = string | { sql: string; args?: unknown[] };

export interface LibsqlClient {
  execute(stmt: LibsqlStatement): Promise<LibsqlResultSet>;
  executeMultiple(sql: string): Promise<void>;
  close(): Promise<void> | void;
}

/** Subset of a Turso sync `Database` needed to drive background sync. */
export interface SyncCapable {
  push(): Promise<void>;
  pull(): Promise<boolean>;
  checkpoint?(): Promise<void>;
}

export interface TursoBackendOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface TursoConnectResult {
  backend: MemoryBackend;
  /** Present only for `sync` mode — the handle used to push/pull. */
  syncDb?: SyncCapable;
}
// Adapter: Turso Database (@tursodatabase/database | @tursodatabase/sync) → libSQL client
/**
 * Wrap a Turso `Database` (which exposes `batch`/`exec`/`run`/`all`) so it
 * looks like a `@libsql/client` `Client` to {@link TursoBackend}.
 *
 * `Database.batch([{sql, args}])` returns a libSQL-shaped `ResultSet` with
 * object-keyed rows by default — exactly what the backend reads. We run a
 * single-statement batch per `execute`, and map `executeMultiple` to `exec`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function libsqlCompat(db: any): LibsqlClient {
  return {
    async execute(stmt: LibsqlStatement): Promise<LibsqlResultSet> {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      const args = typeof stmt === "string" ? [] : (stmt.args ?? []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = await db.batch([{ sql, args }]);
      const rs = results[0];
      if (!rs) throw new Error("Turso batch returned no result set");
      return rs as LibsqlResultSet;
    },
    async executeMultiple(sql: string): Promise<void> {
      await db.exec(sql);
    },
    close(): Promise<void> | void {
      return db.close();
    },
  };
}
// Engine picker
function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function requireUrl(config: NoodleConfig): string {
  if (!config.db.url) {
    throw new Error("Turso database URL is required for cloud/sync mode. Set db.url or NOODLE_DB_URL.");
  }
  return config.db.url;
}

/**
 * Connect to the right Turso engine for the configured `db.mode` and build a
 * {@link TursoBackend} (wrapped for local/sync since their `connect()` is async).
 *
 * - `local` → `@tursodatabase/database` (embedded Turso engine, MVCC)
 * - `cloud` → `@tursodatabase/serverless/compat` (drop-in libSQL client, fetch-only)
 * - `sync`  → `@tursodatabase/sync` (local-first + push/pull to Turso Cloud)
 */
export async function connectTurso(
  config: NoodleConfig,
  embedder: Embedder,
  options: TursoBackendOptions,
): Promise<TursoConnectResult> {
  const backendOptions = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };

  if (config.db.mode === "cloud") {
    const { createClient } = await import("@tursodatabase/serverless/compat");
    const client = createClient({
      url: requireUrl(config),
      ...(config.db.authToken ? { authToken: config.db.authToken } : {}),
    });
    return { backend: new TursoBackend(client, embedder, backendOptions) };
  }

  if (config.db.mode === "sync") {
    ensureDir(config.db.path);
    const { connect } = await import("@tursodatabase/sync");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = await connect({
      path: config.db.path,
      ...(config.db.url ? { url: config.db.url } : {}),
      ...(config.db.authToken ? { authToken: config.db.authToken } : {}),
    });
    const syncDb: SyncCapable = {
      push: () => db.push(),
      pull: () => db.pull(),
      ...(typeof db.checkpoint === "function" ? { checkpoint: () => db.checkpoint() } : {}),
    };
    return { backend: new TursoBackend(libsqlCompat(db), embedder, backendOptions), syncDb };
  }

  // local
  ensureDir(config.db.path);
  const { connect } = await import("@tursodatabase/database");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = await connect(config.db.path);
  return { backend: new TursoBackend(libsqlCompat(db), embedder, backendOptions) };
}
// Lazy backend
/**
 * A {@link MemoryBackend} that delegates to a backend resolved asynchronously.
 *
 * `@tursodatabase/database` and `@tursodatabase/sync` expose an async
 * `connect()`, but {@link MemoryService} is constructed synchronously at
 * module load. This wrapper defers the (async) connection until the first
 * backend method actually runs (every method is already async, so the first
 * call absorbs the connection cost) — merely importing this module never
 * opens a database.
 */
export class LazyMemoryBackend implements MemoryBackend {
  private readonly factory: () => Promise<MemoryBackend>;
  private ready: Promise<MemoryBackend> | undefined;

  /**
   * @param factory called once, on first use. Connection (which is async for
   * local/sync modes) is deferred until the first backend method actually
   * runs — so merely importing this module never opens a database.
   */
  constructor(factory: () => Promise<MemoryBackend>) {
    this.factory = factory;
  }

  private init(): Promise<MemoryBackend> {
    if (!this.ready) this.ready = this.factory();
    return this.ready;
  }

  add(input: AddMemoryInput): Promise<void> {
    return this.init().then((backend) => backend.add(input));
  }
  search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    return this.init().then((backend) => backend.search(input));
  }
  list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.init().then((backend) => backend.list(input));
  }
  get(id: string): Promise<MemoryRecord | null> {
    return this.init().then((backend) => backend.get(id));
  }
  update(id: string, input: UpdateMemoryInput): Promise<void> {
    return this.init().then((backend) => backend.update(id, input));
  }
  delete(id: string): Promise<void> {
    return this.init().then((backend) => backend.delete(id));
  }
  async recordRetrievals(ids: string[]): Promise<void> {
    const backend = await this.init();
    await backend.recordRetrievals?.(ids);
  }
  async consolidate(): Promise<ConsolidationReport> {
    const backend = await this.init();
    return backend.consolidate?.() ?? { merged: 0, deleted: 0 };
  }
}
// Test helper
/**
 * Build a libSQL-compatible in-memory client backed by the Turso engine.
 * Used by tests so they don't depend on `@libsql/client`.
 */
export async function createMemoryClient(): Promise<LibsqlClient> {
  const { connect } = await import("@tursodatabase/database");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = await connect(":memory:");
  return libsqlCompat(db);
}