import test from "node:test";
import assert from "node:assert/strict";

import { flushPendingWrites } from "../src/queue.ts";
import type { MemoryBackend } from "../src/memory/backend.ts";
import { MemoryService } from "../src/memory/service.ts";
import type {
  AddMemoryInput,
  ConversationCaptureInput,
  MemoryListInput,
  MemoryRecord,
  MemorySearchInput,
  UpdateMemoryInput,
} from "../src/memory/types.ts";

class FakeMemoryBackend implements MemoryBackend {
  public readonly added: AddMemoryInput[] = [];
  public readonly updated: Array<{ id: string; input: UpdateMemoryInput }> = [];
  public readonly deleted: string[] = [];
  public readonly conversationCaptures: ConversationCaptureInput[] = [];
  public records: MemoryRecord[] = [];

  async add(input: AddMemoryInput): Promise<void> {
    this.added.push(input);
    const text = input.text || input.messages?.map((message) => message.content).join("\n") || "";
    this.records.push({
      id: String(this.records.length + 1),
      text,
      categories: input.categories ?? (input.category ? [input.category] : []),
      metadata: input.metadata ?? {},
      ...(input.category ? { category: input.category } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });
  }

  async search(_input: MemorySearchInput): Promise<MemoryRecord[]> {
    return this.records;
  }

  async list(_input?: MemoryListInput): Promise<MemoryRecord[]> {
    return this.records;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    this.updated.push({ id, input });
  }

  async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }

  async captureConversation(input: ConversationCaptureInput): Promise<void> {
    this.conversationCaptures.push(input);
  }

  public readonly recordedRetrievals: string[][] = [];

  async recordRetrievals(ids: string[]): Promise<void> {
    this.recordedRetrievals.push(ids);
  }
}

test("MemoryService dedupes novel candidates before writing", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend);

  backend.records = [
    {
      id: "1",
      text: "Call user small dog",
      categories: ["identity"],
      metadata: { confidence: 0.5, trigger_reasons: ["first_pass"] },
      category: "identity",
    },
  ];

  const skipped = await service.addCandidateIfNovel("Call user small dog", "call user small dog", {
    category: "identity",
    confidence: 0.9,
    signal_count: 3,
    trigger_reasons: ["repeat_signal"],
  });
  const saved = await service.addCandidateIfNovel("User prefers concise responses", "user prefers concise responses", {
    category: "response_style",
    categories: ["response_style"],
  });

  assert.equal(skipped, "merged");
  assert.equal(saved, "saved");
  assert.equal(backend.added.length, 1);
  assert.equal(backend.added[0]?.text, "User prefers concise responses");
  assert.equal(backend.updated.length, 1);
  assert.deepEqual(backend.updated[0]?.id, "1");
  assert.equal(backend.updated[0]?.input.metadata?.["confidence"], 0.9);
  assert.equal(backend.updated[0]?.input.metadata?.["signal_count"], 3);
  assert.deepEqual(backend.updated[0]?.input.metadata?.["trigger_reasons"], ["first_pass", "repeat_signal"]);
});

test("MemoryService retrieval ranks relevant memories and skips chatter", async () => {
  const backend = new FakeMemoryBackend();
  backend.records = [
    {
      id: "1",
      text: "Default to Elixir",
      categories: ["coding_pref"],
      metadata: { durability: "durable" },
      category: "coding_pref",
    },
    {
      id: "2",
      text: "User prefers concise responses",
      categories: ["response_style"],
      metadata: { durability: "durable" },
      category: "response_style",
    },
  ];

  const service = new MemoryService(backend);
  const coding = await service.findRelevantMemories("Please refactor this backend function", 3);
  const chatter = await service.findRelevantMemories("hey there", 3);

  assert.equal(coding.length > 0, true);
  assert.equal(coding[0]?.text, "Default to Elixir");
  assert.deepEqual(chatter, []);
  assert.equal(backend.recordedRetrievals.length, 0);
});

test("MemoryService automatic capture saves explicit remember requests immediately", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend, { extractorMode: "balanced" });

  const queued = service.queueAutomaticCapture("Remember that I prefer concise TypeScript examples.");
  await flushPendingWrites();

  assert.equal(queued, true);
  assert.equal(backend.added.length, 1);
  assert.equal(backend.added[0]?.text, "I prefer concise TypeScript examples");
  assert.equal(service.listPendingCandidates().length, 0);
});

test("MemoryService no longer heuristically captures implicit preferences", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend, { extractorMode: "balanced" });

  const queued = service.queueAutomaticCapture("I usually prefer concise TypeScript examples.");
  await flushPendingWrites();

  assert.equal(queued, false);
  assert.equal(service.listPendingCandidates().length, 0);
  assert.equal(backend.added.length, 0);
});

test("MemoryService forwards generic get, update, and delete operations", async () => {
  const backend = new FakeMemoryBackend();
  backend.records = [
    {
      id: "1",
      text: "Call user small dog",
      categories: ["identity"],
      metadata: {},
      category: "identity",
    },
  ];
  const service = new MemoryService(backend);

  const record = await service.get("1");
  await service.update("1", { text: "Call user tiny wolf" });
  await service.delete("1");

  assert.equal(record?.text, "Call user small dog");
  assert.equal(backend.updated.length, 1);
  assert.equal(backend.updated[0]?.input.text, "Call user tiny wolf");
  assert.deepEqual(backend.deleted, ["1"]);
});

test("MemoryService captures session conversations through the backend", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend);
  const savedSignatures = new Set<string>();

  const sessionManager = {
    getBranch: () => [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Please remember that I prefer concise responses for code review replies." }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Understood, I will keep code review replies concise." }] },
      },
    ],
    getSessionFile: () => "session.jsonl",
    getLeafId: () => "leaf-1",
  };

  const saved = await service.captureSessionConversation(sessionManager, "before_compact", savedSignatures);
  await flushPendingWrites();

  assert.equal(saved, true);
  assert.equal(backend.conversationCaptures.length, 1);
  assert.equal(backend.conversationCaptures[0]?.messages.length, 2);
});
