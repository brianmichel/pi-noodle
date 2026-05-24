import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@libsql/client";

import { flushPendingWrites } from "../src/queue.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { MemoryRecord } from "../src/memory/types.ts";
import { fakeSemanticEmbedder } from "./helpers/fake-embedder.ts";

async function createService(): Promise<{ service: MemoryService; close: () => void }> {
  const db = createClient({ url: ":memory:" });
  const backend = new TursoBackend(db, fakeSemanticEmbedder);
  return {
    service: new MemoryService(backend),
    close: () => db.close(),
  };
}

function recordTexts(records: MemoryRecord[]): string[] {
  return records.map((record) => record.text);
}

test("quality eval: remembers durable facts and ignores temporary/sensitive details", async () => {
  const { service, close } = await createService();

  try {
    assert.equal(service.queueAutomaticCapture("My name is Brian."), true);
    await flushPendingWrites();

    assert.equal(service.queueAutomaticCapture("For this task, be extra verbose."), false);
    assert.equal(service.queueAutomaticCapture("My API key is sk-secret-value"), false);

    const saved = await service.list();
    const texts = recordTexts(saved);

    assert.ok(texts.includes("Call user Brian"));
    assert.ok(texts.every((text) => !/verbose|sk-secret-value|api key/i.test(text)));
  } finally {
    close();
  }
});

test("quality eval: retrieves relevant memories and avoids unrelated injection with the real backend", async () => {
  const { service, close } = await createService();

  try {
    for (let i = 0; i < 3; i += 1) {
      service.queueAutomaticCapture("Use TypeScript by default for backend code.");
      await flushPendingWrites();
    }

    assert.equal(service.queueAutomaticCapture("My name is Brian."), true);
    await flushPendingWrites();

    const coding = await service.findRelevantMemories("How should I implement this backend function?", 3);
    assert.ok(coding.some((record) => /Default to TypeScript/i.test(record.text)));

    const generic = await service.findRelevantMemories("What is the capital of France?", 3);
    assert.deepEqual(generic, []);
  } finally {
    close();
  }
});

test("quality eval: respects explicit forget and update against stored records", async () => {
  const { service, close } = await createService();

  try {
    for (let i = 0; i < 3; i += 1) {
      service.queueAutomaticCapture("Use Go by default for daemon code.");
      await flushPendingWrites();
    }

    const before = await service.findRelevantMemories("What language should I use for daemon code?", 5);
    const go = before.find((record) => /Default to Go/i.test(record.text));
    assert.ok(go?.id);

    await service.delete(go!.id!);
    const afterForget = await service.findRelevantMemories("What language should I use for daemon code?", 5);
    assert.ok(afterForget.every((record) => !/Default to Go/i.test(record.text)));

    await service.add({ text: "Default to Rust", category: "coding_pref", categories: ["coding_pref"], metadata: {} });
    const rustRecord = (await service.findRelevantMemories("What language should I use for daemon code?", 5)).find((record) =>
      /Default to Rust/i.test(record.text),
    );
    assert.ok(rustRecord?.id);

    await service.update(rustRecord!.id!, { text: "Default to Zig" });
    const afterUpdate = await service.findRelevantMemories("What language should I use for daemon code?", 5);
    assert.ok(afterUpdate.some((record) => /Default to Zig/i.test(record.text)));
    assert.ok(afterUpdate.every((record) => !/Default to Rust/i.test(record.text)));
  } finally {
    close();
  }
});

test("quality eval: promotes softer preferences after reinforcement while blocking temporary soft prompts", async () => {
  const { service, close } = await createService();

  try {
    service.queueAutomaticCapture("I usually prefer concise TypeScript examples.");
    await flushPendingWrites();
    service.queueAutomaticCapture("I usually prefer concise TypeScript examples.");
    await flushPendingWrites();

    service.queueAutomaticCapture("For this task, I usually prefer very verbose explanations.");
    await flushPendingWrites();

    const saved = await service.list();
    const texts = recordTexts(saved);
    assert.ok(texts.some((text) => /concise TypeScript examples/i.test(text)));
    assert.ok(texts.every((text) => !/very verbose explanations/i.test(text)));
  } finally {
    close();
  }
});

test("quality eval: memory retrieval stays isolated across assistant, user, and session scopes", async () => {
  const db = createClient({ url: ":memory:" });
  const backend = new TursoBackend(db, fakeSemanticEmbedder);

  try {
    await backend.add({
      text: "Team uses Turso",
      categories: ["project"],
      scope: { assistantId: "assistant-a", userId: "user-1", sessionId: "session-1" },
      metadata: {},
    });
    await backend.add({
      text: "Team uses Postgres",
      categories: ["project"],
      scope: { assistantId: "assistant-b", userId: "user-2", sessionId: "session-2" },
      metadata: {},
    });

    const sameScope = await backend.search({
      query: "How do we implement storage for this project?",
      scope: { assistantId: "assistant-a", userId: "user-1", sessionId: "session-1" },
      categories: ["project"],
      limit: 5,
    });
    const wrongAssistant = await backend.search({
      query: "How do we implement storage for this project?",
      scope: { assistantId: "assistant-b", userId: "user-1", sessionId: "session-1" },
      categories: ["project"],
      limit: 5,
    });

    assert.ok(sameScope.some((record) => /Turso/i.test(record.text)));
    assert.ok(wrongAssistant.every((record) => !/Turso/i.test(record.text)));
  } finally {
    db.close();
  }
});
