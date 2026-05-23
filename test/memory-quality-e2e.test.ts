import test from "node:test";
import assert from "node:assert/strict";

import { flushPendingWrites } from "../src/queue.ts";
import { MemoryService } from "../src/memory/service.ts";
import { categoriesForPrompt, scoreMemoryText, tokenizePrompt } from "../src/memory/policy.ts";
import type {
  AddMemoryInput,
  MemoryListInput,
  MemoryRecord,
  MemorySearchInput,
  UpdateMemoryInput,
} from "../src/memory/types.ts";
import type { MemoryBackend } from "../src/memory/backend.ts";

class QualityEvalBackend implements MemoryBackend {
  private records: MemoryRecord[] = [];
  private id = 1;

  async add(input: AddMemoryInput): Promise<void> {
    const text = input.text ?? input.messages?.map((message) => message.content).join("\n") ?? "";
    this.records.push({
      id: String(this.id++),
      text,
      categories: input.categories ?? (input.category ? [input.category] : []),
      metadata: input.metadata ?? {},
      ...(input.category ? { category: input.category } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });
  }

  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    const queryTokens = tokenizePrompt(input.query);
    const queryCategories = input.categories ?? categoriesForPrompt(input.query);
    const threshold = input.threshold ?? -Infinity;
    const limit = input.limit ?? 10;

    return this.records
      .filter((record) => {
        if (input.scope?.assistantId && record.scope?.assistantId && record.scope.assistantId !== input.scope.assistantId) return false;
        if (input.categories && input.categories.length > 0) {
          return record.categories.some((category) => input.categories?.includes(category));
        }
        return true;
      })
      .map((record) => {
        const score = scoreMemoryText(
          record.text,
          queryTokens,
          queryCategories,
          record.categories,
          record.metadata["durability"],
        );
        return { ...record, score };
      })
      .filter((record) => (record.score ?? 0) >= threshold)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  async list(_input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.records;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    this.records = this.records.map((record) => {
      if (record.id !== id) return record;
      return {
        ...record,
        text: input.text ?? record.text,
        metadata: input.metadata ? { ...record.metadata, ...input.metadata } : record.metadata,
      };
    });
  }

  async delete(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }
}

test("quality eval: remembers durable facts and ignores temporary/sensitive details", async () => {
  const backend = new QualityEvalBackend();
  const service = new MemoryService(backend);

  assert.equal(service.queueAutomaticCapture("My name is Brian."), true);
  await flushPendingWrites();

  assert.equal(service.queueAutomaticCapture("For this task, be extra verbose."), false);
  assert.equal(service.queueAutomaticCapture("My API key is sk-secret-value"), false);

  const saved = await service.list();
  const texts = saved.map((record) => record.text);

  assert.ok(texts.includes("Call user Brian"));
  assert.ok(texts.every((text) => !/verbose|sk-secret-value|api key/i.test(text)));
});

test("quality eval: retrieves relevant memories and avoids unrelated injection", async () => {
  const backend = new QualityEvalBackend();
  const service = new MemoryService(backend);

  for (let i = 0; i < 3; i += 1) {
    service.queueAutomaticCapture("Use TypeScript by default for backend code.");
  }
  await flushPendingWrites();

  assert.equal(service.queueAutomaticCapture("My name is Brian."), true);
  await flushPendingWrites();

  const coding = await service.findRelevantMemories("How should I implement this backend function?", 3);
  assert.ok(coding.some((record) => /Default to TypeScript/i.test(record.text)));

  const generic = await service.findRelevantMemories("What is the capital of France?", 3);
  assert.deepEqual(generic, []);
});

test("quality eval: respects explicit forget and update", async () => {
  const backend = new QualityEvalBackend();
  const service = new MemoryService(backend);

  for (let i = 0; i < 3; i += 1) {
    service.queueAutomaticCapture("Use Go by default for daemon code.");
  }
  await flushPendingWrites();

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
});
