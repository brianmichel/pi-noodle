import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryClient } from "../src/memory/turso-client.ts";

import { flushPendingWrites } from "../src/queue.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { MemoryCaptureEvent, MemoryRecord } from "../src/memory/types.ts";
import { fakeSemanticEmbedder } from "./helpers/fake-embedder.ts";

async function createService(): Promise<{ service: MemoryService; close: () => void }> {
  const db = await createMemoryClient();
  const backend = new TursoBackend(db, fakeSemanticEmbedder);
  return {
    service: new MemoryService(backend),
    close: () => db.close(),
  };
}

function recordTexts(records: MemoryRecord[]): string[] {
  return records.map((record) => record.text);
}

function createInputEvent(text: string): MemoryCaptureEvent {
  return {
    type: "user_input",
    text,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      }],
      getSessionFile: () => "session.jsonl",
      getLeafId: () => "leaf-1",
    },
  };
}

test("quality eval: remembers explicit durable requests and ignores temporary/sensitive details", async () => {
  const { service, close } = await createService();

  try {
    assert.equal((await service.capture(createInputEvent("Remember that my name is Brian."))).automaticCaptureQueued, true);
    await flushPendingWrites();

    assert.equal((await service.capture(createInputEvent("Remember that for this task, be extra verbose."))).automaticCaptureQueued, false);
    assert.equal((await service.capture(createInputEvent("Remember this API key sk-secret-value"))).automaticCaptureQueued, false);

    const saved = await service.list();
    const texts = recordTexts(saved);

    assert.ok(texts.includes("my name is Brian"));
    assert.ok(texts.every((text) => !/verbose|sk-secret-value|api key/i.test(text)));
  } finally {
    close();
  }
});

test("quality eval: retrieves relevant memories and avoids unrelated injection with the real backend", async () => {
  const { service, close } = await createService();

  try {
    assert.equal((await service.capture(createInputEvent("Remember that I prefer TypeScript for backend code."))).automaticCaptureQueued, true);
    await flushPendingWrites();

    const coding = await service.findRelevantMemories("How should I implement this backend function?", 3);
    assert.ok(coding.some((record) => /TypeScript/i.test(record.text)));

    const generic = await service.findRelevantMemories("What is the capital of France?", 3);
    assert.deepEqual(generic, []);
  } finally {
    close();
  }
});

test("quality eval: respects explicit forget and update against stored records", async () => {
  const { service, close } = await createService();

  try {
    await service.capture(createInputEvent("Remember that I prefer Go for daemon code."));
    await flushPendingWrites();

    const before = await service.findRelevantMemories("What language should I use for daemon code?", 5);
    const go = before.find((record) => /prefer Go/i.test(record.text));
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

test("quality eval: implicit preferences are ignored until an extractor produces candidates", async () => {
  const { service, close } = await createService();

  try {
    await service.capture(createInputEvent("I usually prefer concise TypeScript examples."));
    await flushPendingWrites();

    const saved = await service.list();
    const pending = service.listPendingCandidates();
    const retrieved = await service.findRelevantMemories("Can you show a TypeScript example?", 5);

    assert.equal(saved.length, 0);
    assert.equal(pending.length, 0);
    assert.deepEqual(retrieved, []);
  } finally {
    close();
  }
});

test("quality eval: project memories only retrieve for the matching project key", async () => {
  const db = await createMemoryClient();
  const backend = new TursoBackend(db, fakeSemanticEmbedder);
  const service = new MemoryService(backend, { projectKeyResolver: () => "github.com/acme/pi-noodle" });

  try {
    await service.add({
      text: "Use plain TypeScript modules for the web viewer refactor",
      category: "coding_pref",
      categories: ["coding_pref"],
      metadata: { applicability: "project", project_key: "github.com/acme/pi-noodle" },
    });
    await service.add({
      text: "Use Vue for the dashboard refresh",
      category: "coding_pref",
      categories: ["coding_pref"],
      metadata: { applicability: "project", project_key: "github.com/acme/other-app" },
    });
    await service.add({
      text: "User prefers concise responses",
      category: "response_style",
      categories: ["response_style"],
      metadata: { applicability: "user" },
    });

    const retrieved = await service.findRelevantMemories("How should I refactor this frontend component?", 5);
    const texts = recordTexts(retrieved);

    assert.ok(texts.some((text) => /plain TypeScript modules/i.test(text)));
    assert.ok(texts.some((text) => /concise responses/i.test(text)));
    assert.ok(texts.every((text) => !/Use Vue for the dashboard refresh/i.test(text)));
  } finally {
    db.close();
  }
});

test("quality eval: memory retrieval stays isolated across assistant, user, and session scopes", async () => {
  const db = await createMemoryClient();
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
