import { createClient } from "@libsql/client";
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
    db = createClient({ url: ":memory:" });
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

  it("captures a conversation", async () => {
    await backend.captureConversation?.({
      messages: [
        { role: "user", content: "What is your name?" },
        { role: "assistant", content: "I am Pi." },
      ],
      metadata: { source: "convo-test" },
      scope: { assistantId: "agent-1" },
    });

    const list = await backend.list({ scope: { assistantId: "agent-1" } });
    const captured = list.find((m: MemoryRecord) =>
      m.text.includes("What is your name"),
    );
    assert.ok(captured);
    assert.equal(captured.metadata["source"], "convo-test");
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
});
