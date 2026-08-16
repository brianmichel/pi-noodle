import { DEFAULT_AGENT_ID } from "../constants.ts";
import type { JsonObject } from "../types.ts";
import { asFiniteNumber, asStringArray, isJsonObject, parseJsonObject, parseJsonStringArray } from "../utils.ts";
import type { MemoryBackend } from "./backend.ts";
import type { Embedder } from "./embedder.ts";
import type {
  AddMemoryInput,
  ConsolidationReport,
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

function extractText(input: AddMemoryInput): string {
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
    categories: parseJsonStringArray(row.categories),
    metadata: parseJsonObject(row.metadata),
    scope,
  };

  if (typeof row.id === "string") record.id = row.id;
  if (typeof row.category === "string" && row.category.length > 0) {
    record.category = row.category as MemoryCategory;
  }
  if (typeof row.created_at === "number") record.createdAt = row.created_at;
  if (typeof row.last_retrieved === "number") record.lastRetrieved = row.last_retrieved;
  if (typeof row.retrieval_count === "number") record.retrievalCount = row.retrieval_count;

  return record;
}

function metadataMatches(recordMetadata: JsonObject, expected: JsonObject): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const current = recordMetadata[key];
    if (Array.isArray(value) || (value && typeof value === "object")) {
      return JSON.stringify(current) === JSON.stringify(value);
    }
    return current === value;
  });
}

function mergeJsonObjects(primary: JsonObject, secondary: JsonObject): JsonObject {
  const merged: JsonObject = { ...secondary, ...primary };

  const reasons = new Set<string>();
  for (const value of [primary["trigger_reasons"], secondary["trigger_reasons"]]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) reasons.add(item);
    }
  }
  if (reasons.size > 0) merged["trigger_reasons"] = Array.from(reasons);

  const signalCounts = [primary["signal_count"], secondary["signal_count"]].filter((value): value is number => typeof value === "number");
  if (signalCounts.length > 0) merged["signal_count"] = Math.max(...signalCounts);

  const confidences = [primary["confidence"], secondary["confidence"]].filter((value): value is number => typeof value === "number");
  if (confidences.length > 0) merged["confidence"] = Math.max(...confidences);

  const consolidatedFrom = new Set<string>();
  for (const value of [primary["consolidated_from"], secondary["consolidated_from"]]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) consolidatedFrom.add(item);
    }
  }
  if (consolidatedFrom.size > 0) merged["consolidated_from"] = Array.from(consolidatedFrom);

  return merged;
}

function applySearchFilters(records: Array<MemoryRecord & { _score: number }>, filters?: JsonObject): Array<MemoryRecord & { _score: number }> {
  if (!filters) return records;

  const sourceFilter = asStringArray(filters["source"]);
  const autoSaved = typeof filters["auto_saved"] === "boolean" ? filters["auto_saved"] : undefined;
  const createdAfter = asFiniteNumber(filters["createdAfter"]);
  const createdBefore = asFiniteNumber(filters["createdBefore"]);
  const lastRetrievedAfter = asFiniteNumber(filters["lastRetrievedAfter"]);
  const lastRetrievedBefore = asFiniteNumber(filters["lastRetrievedBefore"]);
  const minRetrievalCount = asFiniteNumber(filters["minRetrievalCount"]);
  const maxRetrievalCount = asFiniteNumber(filters["maxRetrievalCount"]);
  const minConfidence = asFiniteNumber(filters["minConfidence"]);
  const metadataFilter = isJsonObject(filters["metadata"])
    ? filters["metadata"] as JsonObject
    : undefined;

  return records.filter((record) => {
    if (sourceFilter.length > 0) {
      const source = typeof record.metadata.source === "string" ? record.metadata.source : undefined;
      if (!source || !sourceFilter.includes(source)) return false;
    }

    if (autoSaved !== undefined) {
      if (record.metadata.auto_saved !== autoSaved) return false;
    }

    if (createdAfter !== undefined && (record.createdAt ?? 0) < createdAfter) return false;
    if (createdBefore !== undefined && (record.createdAt ?? Number.MAX_SAFE_INTEGER) > createdBefore) return false;
    if (lastRetrievedAfter !== undefined && (record.lastRetrieved ?? 0) < lastRetrievedAfter) return false;
    if (lastRetrievedBefore !== undefined && (record.lastRetrieved ?? Number.MAX_SAFE_INTEGER) > lastRetrievedBefore) return false;
    if (minRetrievalCount !== undefined && (record.retrievalCount ?? 0) < minRetrievalCount) return false;
    if (maxRetrievalCount !== undefined && (record.retrievalCount ?? 0) > maxRetrievalCount) return false;
    if (minConfidence !== undefined) {
      const confidence = typeof record.metadata.confidence === "number" ? record.metadata.confidence : undefined;
      if (confidence === undefined || confidence < minConfidence) return false;
    }
    if (metadataFilter && !metadataMatches(record.metadata, metadataFilter)) return false;

    return true;
  });
}

// ---------------------------------------------------------------------------
// TursoBackend
// ---------------------------------------------------------------------------

/**
 * SQLite/Turso-backed memory store with vector search.
 *
 * Requires an `Embedder` (OpenAI, LM Studio, etc.) injected at construction.
 * The backing `db` is a libSQL-client-compatible surface (`execute` /
 * `executeMultiple`): `@tursodatabase/serverless/compat` directly, or a
 * `@tursodatabase/database`/`@tursodatabase/sync` `Database` wrapped by
 * `libsqlCompat` in {@link turso-client.ts}. Works in Node, Bun, and edge.
 */
export class TursoBackend implements MemoryBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any; // libSQL-client-compatible (execute/executeMultiple)
  private readonly embedder: Embedder;
  private readonly embeddingSignature: string;
  private initialized = false;
  private resolvedDimensions?: number;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(db: any, embedder: Embedder, options?: { provider?: string; model?: string; baseUrl?: string }) {
    this.db = db;
    this.embedder = embedder;
    this.embeddingSignature = JSON.stringify({
      provider: options?.provider ?? "unknown",
      model: options?.model ?? "",
      baseUrl: options?.baseUrl ?? "",
    });
  }

  // ---- schema ----

  private async ensureSchema(observedDimensions?: number): Promise<void> {
    if (this.initialized) return;

    const dimensions = this.resolveDimensions(observedDimensions);
    await this.db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id               TEXT PRIMARY KEY,
        text             TEXT NOT NULL,
        embedding        F32_BLOB(${dimensions}),
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
      CREATE TABLE IF NOT EXISTS noodle_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    await this.assertEmbeddingCompatibility(dimensions);
    this.initialized = true;
  }

  // ===================================================================
  // MemoryBackend implementation
  // ===================================================================

  async add(input: AddMemoryInput): Promise<void> {
    const text = extractText(input);
    const embedding = await this.embedChecked(text);
    await this.ensureSchema(embedding.length);
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
    const queryEmbedding = await this.embedChecked(input.query);
    await this.ensureSchema(queryEmbedding.length);
    const scope = normalizeScope(input.scope);
    const scopeFilter = buildScopeFilter(scope);
    const limit = Math.max(1, input.limit ?? 5);
    const candidateLimit = Math.max(limit * 5, 25);

    // Build parameterised async. Positional: vector JSON, then scope args, then limit.
    const args: unknown[] = [toVectorJson(queryEmbedding)];
    if (scopeFilter.args.length > 0) args.push(...scopeFilter.args);
    args.push(candidateLimit);

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
                   metadata, created_at, last_retrieved, retrieval_count,
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
      // cosine-distance ∈ [0, 2]; map to score ∈ [1, 0]. vector_distance_cos is
      // native to the Turso engine and always returns a number.
      const distance = typeof raw.distance === "number" ? raw.distance : 2;
      record._score = 1 - Math.max(0, Math.min(1, distance / 2));
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
    records = applySearchFilters(records, input.filters);

    const finalRecords = records
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    await this.recordRetrievals(finalRecords.map((record) => record.id).filter((id): id is string => typeof id === "string"));

    return finalRecords.map(({ _score: score, ...rec }) => ({ ...rec, score }));
  }

  async recordRetrievals(ids: string[]): Promise<void> {
    await this.ensureSchema();
    if (ids.length === 0) return;

    const now = Date.now();
    for (const id of ids) {
      await this.db.execute({
        sql: `UPDATE memories
              SET retrieval_count = COALESCE(retrieval_count, 0) + 1,
                  last_retrieved = ?
              WHERE id = ?`,
        args: [now, id],
      });
    }
  }

  async list(input?: MemoryListInput): Promise<MemoryRecord[]> {
    await this.ensureSchema();

    const scope = normalizeScope(input?.scope);
    const { clause, args } = buildScopeFilter(scope);

    const result = await this.db.execute({
      sql: `SELECT id, text, category, categories,
                   user_id, assistant_id, session_id, metadata,
                   created_at, last_retrieved, retrieval_count
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
                   user_id, assistant_id, session_id, metadata,
                   created_at, last_retrieved, retrieval_count
            FROM memories
            WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0] as Record<string, unknown>);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    let nextEmbedding: Float32Array | undefined;
    if (input.text !== undefined) {
      nextEmbedding = await this.embedChecked(input.text);
      await this.ensureSchema(nextEmbedding.length);
    } else {
      await this.ensureSchema();
    }

    if (!input.text && !input.metadata) {
      throw new Error("Provide text or metadata for the update.");
    }

    const sets: string[] = [];
    const args: unknown[] = [];

    if (input.text !== undefined) {
      sets.push("text = ?");
      sets.push("embedding = vector32(?)");
      args.push(input.text);
      args.push(toVectorJson(nextEmbedding!));
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
               a.category AS category_a,
               b.category AS category_b,
               a.categories AS categories_a,
               b.categories AS categories_b,
               a.metadata AS metadata_a,
               b.metadata AS metadata_b,
               a.created_at AS created_a,
               b.created_at AS created_b,
               a.last_retrieved AS last_retrieved_a,
               b.last_retrieved AS last_retrieved_b,
               a.retrieval_count AS retrieval_count_a,
               b.retrieval_count AS retrieval_count_b,
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

        const retrievalA = typeof raw.retrieval_count_a === "number" ? raw.retrieval_count_a : 0;
        const retrievalB = typeof raw.retrieval_count_b === "number" ? raw.retrieval_count_b : 0;
        const createdA = raw.created_a as number;
        const createdB = raw.created_b as number;

        const keepA = retrievalA > retrievalB || (retrievalA === retrievalB && createdA >= createdB);
        const keepId = keepA ? idA : idB;
        const dropId = keepA ? idB : idA;
        const keepCategory = keepA ? raw.category_a : raw.category_b;
        const keepCategories = keepA ? raw.categories_a : raw.categories_b;
        const keepMetadata = keepA ? raw.metadata_a : raw.metadata_b;
        const keepLastRetrieved = keepA ? raw.last_retrieved_a : raw.last_retrieved_b;
        const keepRetrievalCount = keepA ? retrievalA : retrievalB;
        const dropText = keepA ? raw.text_b : raw.text_a;
        const dropCategory = keepA ? raw.category_b : raw.category_a;
        const dropCategories = keepA ? raw.categories_b : raw.categories_a;
        const dropMetadata = keepA ? raw.metadata_b : raw.metadata_a;
        const dropLastRetrieved = keepA ? raw.last_retrieved_b : raw.last_retrieved_a;
        const dropRetrievalCount = keepA ? retrievalB : retrievalA;

        const mergedCategories = Array.from(new Set([
          ...parseJsonStringArray(keepCategories),
          ...parseJsonStringArray(dropCategories),
          ...(typeof keepCategory === "string" && keepCategory.length > 0 ? [keepCategory] : []),
          ...(typeof dropCategory === "string" && dropCategory.length > 0 ? [dropCategory] : []),
        ]));

        const mergedMetadata = {
          ...mergeJsonObjects(
            parseJsonObject(keepMetadata),
            {
              ...parseJsonObject(dropMetadata),
              consolidated_into: keepId,
              consolidated_from: [dropId, dropText],
            },
          ),
          source: "consolidated",
        };

        await this.db.execute({
          sql: `UPDATE memories
                SET category = ?,
                    categories = ?,
                    metadata = ?,
                    retrieval_count = ?,
                    last_retrieved = ?
                WHERE id = ?`,
          args: [
            typeof keepCategory === "string" && keepCategory.length > 0
              ? keepCategory
              : (typeof dropCategory === "string" && dropCategory.length > 0 ? dropCategory : null),
            JSON.stringify(mergedCategories),
            JSON.stringify(mergedMetadata),
            keepRetrievalCount + dropRetrievalCount,
            Math.max(
              typeof keepLastRetrieved === "number" ? keepLastRetrieved : 0,
              typeof dropLastRetrieved === "number" ? dropLastRetrieved : 0,
            ) || null,
            keepId,
          ],
        });

        await this.db.execute({
          sql: `UPDATE memories
                SET metadata = json_patch(metadata, ?)
                WHERE id = ?`,
          args: [JSON.stringify({ consolidated_into: keepId }), dropId],
        });

        toDelete.add(dropId);
        report.merged++;
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

  private resolveDimensions(observedDimensions?: number): number {
    const configured = this.embedder.dimensions;
    const resolved = observedDimensions ?? configured ?? this.resolvedDimensions;

    if (!resolved || !Number.isFinite(resolved) || resolved < 1) {
      throw new Error(
        "Embedding dimensions are unknown for the configured provider/model. Set noodle embedding.dimensions in config.json or EMBEDDING_DIMENSIONS in the environment.",
      );
    }
    if (configured && observedDimensions && configured !== observedDimensions) {
      throw new Error(
        `Embedding dimension mismatch: config/provider expected ${configured}, but the provider returned ${observedDimensions}. Update noodle embedding.dimensions or switch to a matching model/provider.`,
      );
    }

    this.resolvedDimensions = resolved;
    return resolved;
  }

  private async assertEmbeddingCompatibility(dimensions: number): Promise<void> {
    const existingDimensions = await this.readMeta("embedding_dimensions");
    const existingSignature = await this.readMeta("embedding_signature");

    if (existingDimensions && parseInt(existingDimensions, 10) !== dimensions) {
      throw new Error(
        `Noodle DB was created with embedding dimension ${existingDimensions}, but the current provider/model uses ${dimensions}. Use a fresh DB or switch back to the original embedding configuration.`,
      );
    }
    if (existingSignature && existingSignature !== this.embeddingSignature) {
      throw new Error(
        "Noodle DB was created with a different embedding provider/model/base URL. Use a fresh DB or switch back to the original embedding configuration to avoid mixed-vector search corruption.",
      );
    }

    if (!existingDimensions) {
      await this.writeMeta("embedding_dimensions", String(dimensions));
    }
    if (!existingSignature) {
      await this.writeMeta("embedding_signature", this.embeddingSignature);
    }
  }

  private async readMeta(key: string): Promise<string | null> {
    const result = await this.db.execute({
      sql: "SELECT value FROM noodle_meta WHERE key = ?",
      args: [key],
    });
    if (result.rows.length === 0) return null;
    const value = (result.rows[0] as Record<string, unknown>).value;
    return typeof value === "string" ? value : null;
  }

  private async writeMeta(key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO noodle_meta(key, value) VALUES(?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    });
  }

  private async embedChecked(text: string): Promise<Float32Array> {
    const embedding = await this.embedder.embed(text);
    this.resolveDimensions(embedding.length);
    return embedding;
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
