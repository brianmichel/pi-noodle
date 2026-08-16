import { createMemoryClient } from "../src/memory/turso-client.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { Embedder } from "../src/memory/embedder.ts";
import type { MemoryRecord } from "../src/memory/types.ts";

// ---------------------------------------------------------------------------
// Fake embedder — returns deterministic vectors (all ones)
// ---------------------------------------------------------------------------

const DIM = 8;

const fakeEmbedder: Embedder = {
  dimensions: DIM,
  embed: async (text: string): Promise<Float32Array> => {
    // Simple hash-based embedding so different inputs give different vectors
    const vec = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) {
      vec[i] = (text.charCodeAt(i % text.length) / 255) * 2 - 1;
    }
    return vec;
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TursoBackend", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let backend: TursoBackend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  before(async () => {
    db = await createMemoryClient();
    backend = new TursoBackend(db, fakeEmbedder);
  });

  after(() => {
    db.close();
  });

  it("adds and retrieves a memory", async () => {
    await backend.add({
      text: "User prefers TypeScript over JavaScript",
      category: "coding_pref",
      categories: ["coding_pref"],
      metadata: { source: "test" },
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.text, "User prefers TypeScript over JavaScript");
    assert.equal(list[0]!.category, "coding_pref");
    assert.deepEqual(list[0]!.categories, ["coding_pref"]);
  });

  it("retrieves a memory by id", async () => {
    await backend.add({
      text: "Project uses ESM with bundler resolution",
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    const found = list.find(
      (m) => m.text === "Project uses ESM with bundler resolution",
    );
    assert.ok(found?.id);

    const record = await backend.get(found!.id!);
    assert.ok(record);
    assert.equal(record.text, "Project uses ESM with bundler resolution");
  });

  it("returns null for unknown id", async () => {
    const record = await backend.get("nonexistent-id");
    assert.equal(record, null);
  });

  it("searches by vector similarity", async () => {
    await backend.add({
      text: "Brian loves writing Rust",
      scope: { assistantId: "agent-1" },
    });
    await backend.add({
      text: "The team prefers tabs over spaces",
      scope: { assistantId: "agent-1" },
    });
    await backend.add({
      text: "A different agent memory",
      scope: { assistantId: "agent-2" },
    });

    const results = await backend.search({
      query: "programming language preference Rust",
      scope: { assistantId: "agent-1" },
      limit: 5,
    });

    assert.ok(results.length > 0);
    // "Brian loves writing Rust" should be the top result
    assert.ok(results[0]!.text.includes("Rust"));
    assert.ok(results[0]!.score !== undefined);
  });

  it("respects search limit", async () => {
    const results = await backend.search({
      query: "test query",
      limit: 1,
    });
    assert.ok(results.length <= 1);
  });

  it("respects threshold", async () => {
    await backend.add({
      text: "Memory for threshold test",
      scope: { assistantId: "agent-1" },
    });

    const all = await backend.search({
      query: "threshold test memory",
      scope: { assistantId: "agent-1" },
      limit: 10,
    });

    const highThreshold = await backend.search({
      query: "threshold test memory",
      scope: { assistantId: "agent-1" },
      threshold: 0.99,
      limit: 10,
    });

    assert.ok(highThreshold.length <= all.length);
  });

  it("tracks retrieval count and timestamp for returned memories", async () => {
    await backend.add({
      text: "Track retrieval usage for this memory",
      scope: { assistantId: "agent-1" },
    });

    const created = (await backend.list({ scope: { assistantId: "agent-1" } }))
      .find((m: MemoryRecord) => m.text === "Track retrieval usage for this memory");
    assert.ok(created?.id);
    assert.equal(created?.retrievalCount ?? 0, 0);
    assert.equal(created?.lastRetrieved, undefined);

    const first = await backend.search({
      query: "retrieval usage memory",
      scope: { assistantId: "agent-1" },
      limit: 5,
    });
    assert.ok(first.some((m) => m.id === created!.id));

    const afterFirst = await backend.get(created!.id!);
    assert.equal(afterFirst?.retrievalCount, 1);
    assert.ok(typeof afterFirst?.lastRetrieved === "number");

    await backend.search({
      query: "retrieval usage memory",
      scope: { assistantId: "agent-1" },
      limit: 5,
    });
    const afterSecond = await backend.get(created!.id!);
    assert.equal(afterSecond?.retrievalCount, 2);
    assert.ok((afterSecond?.lastRetrieved ?? 0) >= (afterFirst?.lastRetrieved ?? 0));
  });

  it("filters by categories in search", async () => {
    await backend.add({
      text: "Code formatting preference: Prettier",
      categories: ["coding_pref"],
      scope: { assistantId: "agent-1" },
    });
    await backend.add({
      text: "Identity: full-stack engineer",
      categories: ["identity"],
      scope: { assistantId: "agent-1" },
    });

    const results = await backend.search({
      query: "preferences and identity",
      scope: { assistantId: "agent-1" },
      categories: ["coding_pref"],
      limit: 10,
    });

    for (const r of results) {
      assert.ok(r.categories.includes("coding_pref"));
    }
  });

  it("applies backend search filters for metadata, timestamps, and retrieval counts", async () => {
    await backend.add({
      text: "Auto-saved TypeScript preference",
      categories: ["coding_pref"],
      metadata: { source: "heuristic", auto_saved: true, confidence: 0.91, tag: "keep" },
      scope: { assistantId: "agent-filters" },
    });
    await backend.add({
      text: "Manual TypeScript preference",
      categories: ["coding_pref"],
      metadata: { source: "manual_command", auto_saved: false, confidence: 0.4, tag: "drop" },
      scope: { assistantId: "agent-filters" },
    });

    const seeded = await backend.list({ scope: { assistantId: "agent-filters" } });
    const auto = seeded.find((m) => m.text === "Auto-saved TypeScript preference");
    const manual = seeded.find((m) => m.text === "Manual TypeScript preference");
    assert.ok(auto?.id && manual?.id);

    await backend.recordRetrievals([auto!.id!, auto!.id!]);

    const filtered = await backend.search({
      query: "TypeScript preference",
      scope: { assistantId: "agent-filters" },
      limit: 10,
      filters: {
        source: ["heuristic"],
        auto_saved: true,
        minConfidence: 0.8,
        minRetrievalCount: 2,
        metadata: { tag: "keep" },
        createdAfter: Math.max(0, (auto?.createdAt ?? 0) - 1),
      },
    });

    assert.ok(filtered.some((m) => m.id === auto!.id));
    assert.ok(filtered.every((m) => m.id !== manual!.id));
  });

  it("scopes lists by assistantId", async () => {
    await backend.add({
      text: "Memory for agent-1",
      scope: { assistantId: "agent-1" },
    });
    await backend.add({
      text: "Memory for agent-2",
      scope: { assistantId: "agent-2" },
    });

    const list1 = await backend.list({ scope: { assistantId: "agent-1" } });
    const list2 = await backend.list({ scope: { assistantId: "agent-2" } });

    for (const r of list1) assert.ok(r.scope?.assistantId === "agent-1" || !r.scope?.assistantId);
    for (const r of list2) assert.ok(r.scope?.assistantId === "agent-2" || !r.scope?.assistantId);
  });

  it("updates a memory", async () => {
    await backend.add({
      text: "Original text",
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    const original = list.find((m: MemoryRecord) => m.text === "Original text");
    assert.ok(original?.id);

    await backend.update(original!.id!, { text: "Updated text" });

    const updated = await backend.get(original!.id!);
    assert.ok(updated);
    assert.equal(updated.text, "Updated text");
  });

  it("updates metadata without changing text", async () => {
    await backend.add({
      text: "Metadata update test",
      metadata: { version: 1 },
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    const record = list.find((m: MemoryRecord) => m.text === "Metadata update test");
    assert.ok(record?.id);

    await backend.update(record!.id!, { metadata: { version: 2 } });

    const updated = await backend.get(record!.id!);
    assert.ok(updated);
    assert.equal(updated.metadata["version"], 2);
  });

  it("deletes a memory", async () => {
    await backend.add({
      text: "To be deleted",
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    const toDelete = list.find((m: MemoryRecord) => m.text === "To be deleted");
    assert.ok(toDelete?.id);

    await backend.delete(toDelete!.id!);
    const gone = await backend.get(toDelete!.id!);
    assert.equal(gone, null);
  });

  it("scopeless memories fall back to the default agent", async () => {
    await backend.add({
      text: "Unscoped memory goes to default agent",
    });

    // Should be visible when querying the default agent
    const list = await backend.list();
    const found = list.some(
      (r) => r.text === "Unscoped memory goes to default agent",
    );
    assert.ok(found);
  });

  it("rejects add with no text or messages", async () => {
    await assert.rejects(
      () =>
        backend.add({
          scope: { assistantId: "agent-1" },
        }),
      /Provide text or messages/,
    );
  });

  it("rejects update with no text or metadata", async () => {
    await assert.rejects(
      () => backend.update("some-id", {}),
      /Provide text or metadata/,
    );
  });

  it("rejects embedding dimension drift across providers or model config", async () => {
    const db2 = await createMemoryClient();
    try {
      const backendA = new TursoBackend(db2, {
        dimensions: 8,
        embed: async () => new Float32Array(8).fill(1),
      }, { provider: "openai", model: "model-a", baseUrl: "https://example.test/v1" });
      await backendA.add({ text: "seed memory", scope: { assistantId: "agent-drift" } });

      const backendB = new TursoBackend(db2, {
        dimensions: 16,
        embed: async () => new Float32Array(16).fill(1),
      }, { provider: "openai", model: "model-b", baseUrl: "https://example.test/v1" });

      await assert.rejects(
        () => backendB.search({ query: "seed", scope: { assistantId: "agent-drift" }, limit: 5 }),
        /different embedding provider\/model\/base URL|embedding dimension/i,
      );
    } finally {
      db2.close();
    }
  });

  it("increments retrieval_count and last_retrieved", async () => {
    await backend.add({
      text: "Retrieval counter test memory",
      scope: { assistantId: "agent-retrieval" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-retrieval" } });
    const record = list.find((m) => m.text === "Retrieval counter test memory");
    assert.ok(record?.id);

    await backend.recordRetrievals([record!.id!]);
    await backend.recordRetrievals([record!.id!]);

    const result = await db.execute({
      sql: "SELECT retrieval_count, last_retrieved FROM memories WHERE id = ?",
      args: [record!.id!],
    });
    const row = result.rows[0] as { retrieval_count: number; last_retrieved: number };
    assert.equal(row.retrieval_count, 2);
    assert.ok(row.last_retrieved);
  });

  it("consolidates duplicate memories by merging metadata, categories, and retrieval stats", async () => {
    const isolateDb = await createMemoryClient();
    const isolateBackend = new TursoBackend(isolateDb, fakeEmbedder);
    const scope = { assistantId: "agent-consolidate", userId: "user-consolidate" };

    try {
      await isolateBackend.add({
        text: "Default to TypeScript",
        category: "coding_pref",
        categories: ["coding_pref"],
        metadata: { source: "heuristic", confidence: 0.7, trigger_reasons: ["stated_preference"] },
        scope,
      });
      await isolateBackend.add({
        text: "Default to TypeScript",
        category: "project",
        categories: ["project"],
        metadata: { source: "llm_extracted", confidence: 0.95, trigger_reasons: ["repeated_pattern"] },
        scope,
      });

      const before = (await isolateBackend.list({ scope }))
        .filter((record) => record.text === "Default to TypeScript");
      const ids = before.map((record) => record.id!).filter(Boolean);
      assert.equal(ids.length, 2);

      await isolateBackend.recordRetrievals([ids[0]!, ids[0]!, ids[1]!]);

      const report = await isolateBackend.consolidate();
      assert.equal(report.merged, 1);
      assert.equal(report.deleted, 1);

      const after = (await isolateBackend.list({ scope }))
        .filter((record) => record.text === "Default to TypeScript");
      assert.equal(after.length, 1);
      const merged = after[0]!;
      assert.ok(merged.categories.includes("coding_pref"));
      assert.ok(merged.categories.includes("project"));
      assert.equal(merged.retrievalCount, 3);
      assert.equal(merged.metadata["source"], "consolidated");
      assert.equal(merged.metadata["confidence"], 0.95);
      assert.deepEqual([...(merged.metadata["trigger_reasons"] as string[])].sort(), ["repeated_pattern", "stated_preference"]);
      assert.ok(Array.isArray(merged.metadata["consolidated_from"]));
    } finally {
      isolateDb.close();
    }
  });
});
