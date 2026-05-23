import { DEFAULT_AGENT_ID } from "../constants.ts";
import type { JsonObject } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import type { Embedder } from "./embedder.ts";
import type {
  AddMemoryInput,
  ConsolidationReport,
  ConversationCaptureInput,
  MemoryCategory,
  MemoryListInput,
  MemoryRecord,
  MemoryScope,
  MemorySearchInput,
  UpdateMemoryInput,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonString(value: unknown, fallback: JsonObject = {}): JsonObject {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value: unknown, fallback: string[] = []): string[] {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeScope(scope?: MemoryScope): MemoryScope {
  return {
    ...(scope?.userId ? { userId: scope.userId } : {}),
    assistantId: scope?.assistantId ?? DEFAULT_AGENT_ID,
    ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
  };
}

/** Build WHERE clause + positional args for scope filtering. */
function buildScopeFilter(scope?: MemoryScope): {
  clause?: string;
  args: string[];
} {
  const parts: string[] = [];
  const args: string[] = [];

  if (scope?.assistantId) {
    parts.push("(assistant_id = ? OR assistant_id IS NULL)");
    args.push(scope.assistantId);
  }
  if (scope?.userId) {
    parts.push("(user_id = ? OR user_id IS NULL)");
    args.push(scope.userId);
  }
  if (scope?.sessionId) {
    parts.push("session_id = ?");
    args.push(scope.sessionId);
  }

  return parts.length > 0 ? { clause: parts.join(" AND "), args } : { args };
}

function extractText(
  input: AddMemoryInput | ConversationCaptureInput,
): string {
  if (input.messages && input.messages.length > 0) {
    return input.messages.map((m) => m.content).join("\n");
  }
  const addInput = input as Partial<AddMemoryInput>;
  if (addInput.text) return addInput.text;
  throw new Error("Provide text or messages.");
}

/** Serialize a Float32Array into a JSON number array string for libSQL vector32(). */
function toVectorJson(vec: Float32Array): string {
  return JSON.stringify(Array.from(vec));
}

// ---------------------------------------------------------------------------
// SQLite row → MemoryRecord
// ---------------------------------------------------------------------------

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  const scope: MemoryScope = {};
  if (typeof row.user_id === "string") scope.userId = row.user_id;
  if (typeof row.assistant_id === "string") scope.assistantId = row.assistant_id;
  if (typeof row.session_id === "string") scope.sessionId = row.session_id;

  const record: MemoryRecord = {
    text: typeof row.text === "string" ? row.text : "",
    categories: parseJsonArray(row.categories),
    metadata: parseJsonString(row.metadata),
    scope,
  };

  if (typeof row.id === "string") record.id = row.id;
  if (typeof row.category === "string" && row.category.length > 0) {
    record.category = row.category as MemoryCategory;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Fallback: cosine similarity in pure JS
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// TursoBackend
// ---------------------------------------------------------------------------

/**
 * SQLite/libSQL-backed memory store with vector search.
 *
 * Requires an `Embedder` (OpenAI, LM Studio, etc.) injected at construction.
 * The `@libsql/client` WASM build has no native deps — works in Node, Bun, and
 * edge runtimes.
 */
export class TursoBackend implements MemoryBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any; // @libsql/client Client
  private readonly embedder: Embedder;
  private initialized = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db: any, embedder: Embedder) {
    this.db = db;
    this.embedder = embedder;
  }

  // ---- schema ----

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id               TEXT PRIMARY KEY,
        text             TEXT NOT NULL,
        embedding        F32_BLOB(${this.embedder.dimensions}),
        category         TEXT,
        categories       TEXT DEFAULT '[]',
        user_id          TEXT,
        assistant_id     TEXT,
        session_id       TEXT,
        metadata         TEXT DEFAULT '{}',
        created_at       INTEGER NOT NULL,
        last_retrieved   INTEGER,
        retrieval_count  INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(assistant_id, user_id);
    `);
    this.initialized = true;
  }

  // ===================================================================
  // MemoryBackend implementation
  // ===================================================================

  async add(input: AddMemoryInput): Promise<void> {
    await this.ensureSchema();

    const text = extractText(input);
    const embedding = await this.embedder.embed(text);
    const scope = normalizeScope(input.scope);

    const categories = [
      ...(input.categories ?? []),
      ...(input.category ? [input.category] : []),
    ];

    await this.db.execute({
      sql: `INSERT INTO memories
              (id, text, embedding, category, categories,
               user_id, assistant_id, session_id, metadata, created_at)
            VALUES (?, ?, vector32(?), ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        text,
        toVectorJson(embedding),
        input.category ?? null,
        JSON.stringify([...new Set(categories)]),
        scope.userId ?? null,
        scope.assistantId ?? null,
        scope.sessionId ?? null,
        JSON.stringify(input.metadata ?? {}),
        Date.now(),
      ],
    });
  }

  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    await this.ensureSchema();

    const queryEmbedding = await this.embedder.embed(input.query);
    const scope = normalizeScope(input.scope);
    const scopeFilter = buildScopeFilter(scope);
    const limit = Math.max(1, input.limit ?? 5);

    // Build parameterised async. Positional: vector JSON, then scope args, then limit.
    const args: unknown[] = [toVectorJson(queryEmbedding)];
    if (scopeFilter.args.length > 0) args.push(...scopeFilter.args);
    args.push(limit);

    const whereClause = scopeFilter.clause
      ? ` WHERE embedding IS NOT NULL AND ${scopeFilter.clause}`
      : "";

    // Query spatial plan --------------------------------------------------
    // We embed fresh memories as F32_BLOB so that libSQL family operates natively.
    // If the runtime supplies vector_distance_cos (libSQL / Turso) we use it;
    // otherwise we fall back to loading embeddings as raw blobs and computing
    // cosine similarity in JavaScript (which is fine for < 10K memories).
    const result = await this.db.execute({
      sql: `SELECT id, text, category, categories,
                   user_id, assistant_id, session_id,
                   metadata,
                   vector_distance_cos(embedding, vector32(?1)) AS distance
            FROM memories${whereClause}
            ORDER BY distance
            LIMIT ?${scopeFilter.args.length > 0 ? scopeFilter.args.length + 2 : 2}`,
      args,
    });
    // ------------------------------------------------------------------

    let records: Array<MemoryRecord & { _score: number }> = [];

    for (const raw of result.rows as Record<string, unknown>[]) {
      const record = rowToRecord(raw) as MemoryRecord & { _score: number };
      if (typeof raw.distance === "number") {
        // cosine-distance ∈ [0, 2]; map to score ∈ [1, 0]
        record._score = 1 - Math.max(0, Math.min(1, raw.distance / 2));
      } else {
        // Fallback: compute in JS from the raw blob (libSQL encodes length-prefixed F32_BLOB)
        const vec = await this.readEmbedding(
          typeof raw.id === "string" ? raw.id : "",
        );
        record._score = vec ? cosineSimilarity(queryEmbedding, vec) : 0;
      }
      records.push(record);
    }

    // Post-filter ----------------------------------------------------------
    if (input.threshold !== undefined) {
      records = records.filter((r) => r._score >= input.threshold!);
    }
    if (input.categories?.length) {
      const catSet = new Set(input.categories);
      records = records.filter((r) =>
        r.categories.some((c) => catSet.has(c)),
      );
    }

    return records
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score: score, ...rec }) => ({ ...rec, score }));
  }

  async list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    await this.ensureSchema();

    const scope = normalizeScope(input?.scope);
    const { clause, args } = buildScopeFilter(scope);

    const result = await this.db.execute({
      sql: `SELECT id, text, category, categories,
                   user_id, assistant_id, session_id, metadata
            FROM memories
            ${clause ? `WHERE ${clause}` : ""}
            ORDER BY created_at DESC`,
      args,
    });

    return (result.rows as Record<string, unknown>[]).map(rowToRecord);
  }

  async get(id: string): Promise<MemoryRecord | null> {
    await this.ensureSchema();

    const result = await this.db.execute({
      sql: `SELECT id, text, category, categories,
                   user_id, assistant_id, session_id, metadata
            FROM memories
            WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0] as Record<string, unknown>);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    await this.ensureSchema();

    if (!input.text && !input.metadata) {
      throw new Error("Provide text or metadata for the update.");
    }

    const sets: string[] = [];
    const args: unknown[] = [];

    if (input.text !== undefined) {
      sets.push("text = ?");
      sets.push("embedding = vector32(?)");
      args.push(input.text);
      args.push(toVectorJson(await this.embedder.embed(input.text)));
    }

    if (input.metadata !== undefined) {
      sets.push("metadata = ?");
      args.push(JSON.stringify(input.metadata));
    }

    args.push(id);

    await this.db.execute({
      sql: `UPDATE memories SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    await this.db.execute({
      sql: "DELETE FROM memories WHERE id = ?",
      args: [id],
    });
  }

  async captureConversation(input: ConversationCaptureInput): Promise<void> {
    await this.ensureSchema();

    const text = extractText(input);
    const embedding = await this.embedder.embed(text);
    const scope = normalizeScope(input.scope);

    await this.db.execute({
      sql: `INSERT INTO memories
              (id, text, embedding, category, categories,
               user_id, assistant_id, session_id, metadata, created_at)
            VALUES (?, ?, vector32(?), NULL, '[]', ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        text,
        toVectorJson(embedding),
        scope.userId ?? null,
        scope.assistantId ?? null,
        scope.sessionId ?? null,
        JSON.stringify(input.metadata ?? {}),
        Date.now(),
      ],
    });
  }

  async consolidate(): Promise<ConsolidationReport> {
    await this.ensureSchema();

    const report: ConsolidationReport = { merged: 0, deleted: 0 };

    try {
      // Find near-duplicate pairs using a vector self-join.
      // Distance < 0.04 (cosine) is effectively the same memory.
      // We only scan the 500 most recent memories to bound query time.
      const result = await this.db.execute(`
        SELECT a.id     AS id_a,
               b.id     AS id_b,
               a.text   AS text_a,
               b.text   AS text_b,
               a.created_at AS created_a,
               b.created_at AS created_b,
               vector_distance_cos(a.embedding, b.embedding) AS dist
        FROM (SELECT * FROM memories ORDER BY created_at DESC LIMIT 500) a
        JOIN (SELECT * FROM memories ORDER BY created_at DESC LIMIT 500) b
          ON a.id < b.id
        WHERE a.embedding IS NOT NULL
          AND b.embedding IS NOT NULL
          AND vector_distance_cos(a.embedding, b.embedding) < 0.04
        ORDER BY dist
        LIMIT 50
      `);

      const toDelete = new Set<string>();

      for (const raw of result.rows as Record<string, unknown>[]) {
        const idA = raw.id_a as string;
        const idB = raw.id_b as string;
        if (toDelete.has(idA) || toDelete.has(idB)) continue;

        // Keep the newer memory; soft-delete the older one by marking metadata
        const createdA = raw.created_a as number;
        const createdB = raw.created_b as number;
        const [keepId, dropId] = createdA >= createdB ? [idA, idB] : [idB, idA];

        // Mark the dropped record as consolidated before removing it
        await this.db.execute({
          sql: `UPDATE memories
                SET metadata = json_patch(metadata, ?)
                WHERE id = ?`,
          args: [JSON.stringify({ consolidated_into: keepId }), dropId],
        });

        toDelete.add(dropId);
        report.deleted++;
      }

      for (const id of toDelete) {
        await this.db.execute({
          sql: "DELETE FROM memories WHERE id = ?",
          args: [id],
        });
      }
    } catch {
      // vector_distance_cos in self-join may not be available in all libSQL builds;
      // fail silently so consolidation never crashes the extension.
    }

    return report;
  }

  // ---- internals --------------------------------------------------------

  /** Read stored embedding as Float32Array. Returns null on missing row. */
  private async readEmbedding(id: string): Promise<Float32Array | null> {
    const result = await this.db.execute({
      sql: "SELECT embedding FROM memories WHERE id = ?",
      args: [id],
    });
    if (result.rows.length === 0) return null;
    const blob: unknown = (result.rows[0] as Record<string, unknown>).embedding;
    if (blob instanceof Uint8Array) {
      // Assumption: F32_BLOB is stored with 4 bytes per f32, little-endian.
      return new Float32Array(
        new Uint8Array(blob).buffer.slice(
          blob.byteOffset,
          blob.byteOffset + blob.byteLength,
        ),
      );
    }
    return null;
  }
}

/**
 * Convenience factory. Creates a TursoBackend wired to a libSQL client and
 * the given embedding function.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTursoBackend(db: any, embedder: Embedder): TursoBackend {
  return new TursoBackend(db, embedder);
}
