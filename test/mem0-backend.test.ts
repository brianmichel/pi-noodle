import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMem0SearchPayload,
  extractMem0Records,
  normalizeMem0Record,
} from "../src/memory/mem0-backend.ts";

test("normalizeMem0Record maps Mem0 payloads into generic records", () => {
  const record = normalizeMem0Record({
    id: "abc",
    memory: "Call user small dog",
    metadata: {
      category: "identity",
      categories: ["identity"],
      durability: "durable",
    },
  });

  assert.deepEqual(record, {
    id: "abc",
    text: "Call user small dog",
    category: "identity",
    categories: ["identity"],
    metadata: {
      category: "identity",
      categories: ["identity"],
      durability: "durable",
    },
  });
});

test("extractMem0Records handles results arrays", () => {
  const records = extractMem0Records({
    results: [
      { id: "1", memory: "User prefers concise responses", metadata: { category: "response_style" } },
      { id: "2", text: "Default to Elixir", metadata: { categories: ["coding_pref"] } },
    ],
  });

  assert.equal(records.length, 2);
  assert.equal(records[0]?.text, "User prefers concise responses");
  assert.equal(records[1]?.categories[0], "coding_pref");
});

test("buildMem0SearchPayload maps generic scope and categories to Mem0 filters", () => {
  const payload = buildMem0SearchPayload({
    query: "preferred language",
    limit: 3,
    threshold: 0.75,
    categories: ["coding_pref"],
    scope: {
      userId: "u1",
      assistantId: "pi",
      sessionId: "s1",
    },
    filters: { importance: "high" },
  });

  assert.deepEqual(payload, {
    query: "preferred language",
    top_k: 3,
    threshold: 0.75,
    filters: {
      user_id: "u1",
      agent_id: "pi",
      run_id: "s1",
      importance: "high",
      categories: ["coding_pref"],
    },
  });
});
