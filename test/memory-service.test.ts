import test from "node:test";
import assert from "node:assert/strict";

import { flushPendingWrites } from "../src/queue.ts";
import type { MemoryBackend } from "../src/memory/backend.ts";
import { MemoryService, planMemoryCaptureEvent } from "../src/memory/service.ts";
import type {
  AddMemoryInput,
  ExtractionCandidate,
  MemoryCaptureEvent,
  MemoryListInput,
  MemoryRecord,
  MemorySearchInput,
  UpdateMemoryInput,
} from "../src/memory/types.ts";

class FakeMemoryBackend implements MemoryBackend {
  public readonly added: AddMemoryInput[] = [];
  public readonly updated: Array<{ id: string; input: UpdateMemoryInput }> = [];
  public readonly deleted: string[] = [];
  public readonly consolidations: number[] = [];
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

  async consolidate() {
    this.consolidations.push(Date.now());
    return { merged: 0, deleted: 0 };
  }

  public readonly recordedRetrievals: string[][] = [];

  async recordRetrievals(ids: string[]): Promise<void> {
    this.recordedRetrievals.push(ids);
  }
}

function createSessionManager(messages: Array<{ role: "user" | "assistant"; content: string }>) {
  return {
    getBranch: () => messages.map((message) => ({
      type: "message",
      message: {
        role: message.role,
        content: [{ type: "text", text: message.content }],
      },
    })),
    getSessionFile: () => "session.jsonl",
    getLeafId: () => "leaf-1",
  };
}

function createExtractor(candidates: ExtractionCandidate[]) {
  return {
    resolve: async () => ({
      model: { id: "extractor-model" } as never,
      apiKey: "sk-test",
      headers: {},
    }),
    candidates,
  };
}

test("capture planner runs heuristics every user turn and extraction on automatic-capture turns", () => {
  const event: MemoryCaptureEvent = {
    type: "user_input",
    text: "Remember that I prefer concise TypeScript examples.",
    sessionManager: createSessionManager([]),
    extractor: createExtractor([]),
  };

  const plan = planMemoryCaptureEvent(event, {
    extractorMode: "balanced",
    extractorTriggerEvery: 10,
    sessionTurnCount: 1,
    hasHeuristicCandidates: true,
  });

  assert.deepEqual(plan, {
    runHeuristics: true,
    runLlmExtraction: true,
    consolidate: false,
    extractionReason: "automatic_capture",
  });
});

test("capture planner runs scheduled extraction on cadence turns without heuristic candidates", () => {
  const event: MemoryCaptureEvent = {
    type: "user_input",
    text: "Hello there",
    sessionManager: createSessionManager([]),
    extractor: createExtractor([]),
  };

  const plan = planMemoryCaptureEvent(event, {
    extractorMode: "balanced",
    extractorTriggerEvery: 2,
    sessionTurnCount: 2,
    hasHeuristicCandidates: false,
  });

  assert.equal(plan.runHeuristics, true);
  assert.equal(plan.runLlmExtraction, true);
  assert.equal(plan.extractionReason, "scheduled");
});

test("capture planner maps shutdown events to extraction and consolidation without raw conversation capture", () => {
  const event: MemoryCaptureEvent = {
    type: "session_shutdown",
    reason: "exit",
    sessionManager: createSessionManager([]),
    extractor: createExtractor([]),
  };

  const plan = planMemoryCaptureEvent(event, {
    extractorMode: "balanced",
    extractorTriggerEvery: 10,
    sessionTurnCount: 4,
    hasHeuristicCandidates: false,
  });

  assert.deepEqual(plan, {
    runHeuristics: false,
    runLlmExtraction: true,
    consolidate: true,
    extractionReason: "shutdown:exit",
  });
});

test("capture planner skips shutdown capture work on reload", () => {
  const event: MemoryCaptureEvent = {
    type: "session_shutdown",
    reason: "reload",
    sessionManager: createSessionManager([]),
    extractor: createExtractor([]),
  };

  const plan = planMemoryCaptureEvent(event, {
    extractorMode: "balanced",
    extractorTriggerEvery: 10,
    sessionTurnCount: 4,
    hasHeuristicCandidates: false,
  });

  assert.deepEqual(plan, {
    runHeuristics: false,
    runLlmExtraction: false,
    consolidate: false,
  });
});

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

test("MemoryService capture can queue heuristic and LLM extraction work from one user-input event", async () => {
  const backend = new FakeMemoryBackend();
  const extractor = createExtractor([
    {
      text: "User prefers concise TypeScript examples",
      category: "response_style",
      durability: "semi_durable",
      confidence: 0.92,
      reason: "explicit_statement",
      stability: "stable",
      sensitivity: "safe",
      suggestedAction: "save",
      applicability: "user",
    },
  ]);
  const service = new MemoryService(backend, {
    extractorMode: "balanced",
    extractorTriggerEvery: 10,
    extractMemoriesFromMessages: async () => extractor.candidates,
  });

  const result = await service.capture({
    type: "user_input",
    text: "Remember that I prefer concise TypeScript examples.",
    sessionManager: createSessionManager([
      { role: "user", content: "Remember that I prefer concise TypeScript examples." },
      { role: "assistant", content: "Got it, I will keep TypeScript examples concise." },
      { role: "user", content: "I usually want examples without long explanations." },
      { role: "assistant", content: "Understood. I will optimize for concise examples." },
    ]),
    extractor: { resolve: extractor.resolve },
  });
  await flushPendingWrites();

  assert.equal(result.plan.runHeuristics, true);
  assert.equal(result.plan.runLlmExtraction, true);
  assert.equal(result.automaticCaptureQueued, true);
  assert.equal(result.llmExtractionQueued, true);
  assert.ok(backend.added.some((input) => input.text === "I prefer concise TypeScript examples"));
});

test("MemoryService keeps explicit project memories pending when no project identity can be derived", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend, {
    extractorMode: "balanced",
    projectKeyResolver: () => null,
  });

  const result = await service.capture({
    type: "user_input",
    text: "Remember that I prefer plain TypeScript modules for the web viewer refactor.",
    sessionManager: createSessionManager([{ role: "user", content: "Remember that I prefer plain TypeScript modules for the web viewer refactor." }]),
  });
  await flushPendingWrites();

  assert.equal(result.automaticCaptureQueued, false);
  assert.equal(result.llmExtractionQueued, false);
  assert.equal(backend.added.length, 0);
  assert.equal(service.listPendingCandidates().length, 1);
  assert.equal(service.listPendingCandidates()[0]?.metadata?.["applicability"], "project");
});

test("MemoryService capture skips extraction when context is too small", async () => {
  const backend = new FakeMemoryBackend();
  const service = new MemoryService(backend, {
    extractorMode: "balanced",
    extractMemoriesFromMessages: async () => [],
  });

  const result = await service.capture({
    type: "user_input",
    text: "Remember that I prefer concise replies.",
    sessionManager: createSessionManager([{ role: "user", content: "Remember that I prefer concise replies." }]),
    extractor: { resolve: createExtractor([]).resolve },
  });
  await flushPendingWrites();

  assert.equal(result.automaticCaptureQueued, true);
  assert.equal(result.llmExtractionQueued, false);
  assert.equal(backend.added.length, 1);
});

test("MemoryService filters project memories to the active project key", async () => {
  const backend = new FakeMemoryBackend();
  backend.records = [
    {
      id: "1",
      text: "User prefers concise responses",
      categories: ["response_style"],
      metadata: { applicability: "user" },
      category: "response_style",
    },
    {
      id: "2",
      text: "Use plain TypeScript modules for the web viewer refactor",
      categories: ["coding_pref"],
      metadata: { applicability: "project", project_key: "github.com/acme/pi-noodle" },
      category: "coding_pref",
    },
    {
      id: "3",
      text: "Use Vue for the dashboard refresh",
      categories: ["coding_pref"],
      metadata: { applicability: "project", project_key: "github.com/acme/other-app" },
      category: "coding_pref",
    },
  ];

  const service = new MemoryService(backend, {
    projectKeyResolver: () => "github.com/acme/pi-noodle",
  });
  const results = await service.findRelevantMemories("How should I refactor this frontend view?", 5);

  assert.ok(results.some((record) => record.text === "User prefers concise responses"));
  assert.ok(results.some((record) => record.text === "Use plain TypeScript modules for the web viewer refactor"));
  assert.ok(results.every((record) => record.text !== "Use Vue for the dashboard refresh"));
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

test("MemoryService capture avoids raw conversation persistence and still triggers extraction on shutdown-style events", async () => {
  const backend = new FakeMemoryBackend();
  const extractor = createExtractor([
    {
      text: "Project standardizes on concise memory summaries",
      category: "project",
      durability: "semi_durable",
      confidence: 0.88,
      reason: "repeated_pattern",
      stability: "likely_stable",
      sensitivity: "safe",
      suggestedAction: "save",
      applicability: "project",
      applicabilityConfidence: 0.91,
      applicabilityReason: "Tied to current codebase conventions",
    },
  ]);
  const service = new MemoryService(backend, {
    extractorMode: "balanced",
    extractMemoriesFromMessages: async () => extractor.candidates,
    projectKeyResolver: () => "github.com/acme/pi-noodle",
  });

  const result = await service.capture({
    type: "session_shutdown",
    reason: "exit",
    sessionManager: createSessionManager([
      { role: "user", content: "We are standardizing on concise memory summaries for this project." },
      { role: "assistant", content: "Understood, I will use concise memory summaries." },
      { role: "user", content: "This should apply across the current repo only." },
      { role: "assistant", content: "That sounds project-specific and stable enough to remember." },
    ]),
    extractor: { resolve: extractor.resolve },
  });
  await flushPendingWrites();

  assert.equal(result.llmExtractionQueued, true);
  assert.equal(result.consolidationQueued, true);
  assert.equal(backend.consolidations.length, 1);
  assert.ok(backend.added.length > 0 || service.listPendingCandidates().length > 0);
});
