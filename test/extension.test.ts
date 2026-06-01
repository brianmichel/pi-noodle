import test from "node:test";
import assert from "node:assert/strict";

import type { Api, Model } from "@earendil-works/pi-ai";

import { createMemoryExtension, type MemoryExtensionDeps } from "../src/extension.ts";
import type {
  MemoryCaptureEvent,
  MemoryCaptureResult,
  MemoryExtractorResolution,
  MemoryRecord,
} from "../src/memory/types.ts";
import type { SessionManagerLike } from "../src/types.ts";

type HookHandler = (...args: any[]) => unknown;

type FakePi = {
  hooks: Map<string, HookHandler>;
  tools: unknown[];
  commands: string[];
  on: (name: string, handler: HookHandler) => void;
  registerTool: (tool: unknown) => void;
  registerCommand: (name: string) => void;
};

function createFakePi(): FakePi {
  const hooks = new Map<string, HookHandler>();
  const tools: unknown[] = [];
  const commands: string[] = [];

  return {
    hooks,
    tools,
    commands,
    on(name, handler) {
      hooks.set(name, handler);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name) {
      commands.push(name);
    },
  };
}

function createFakeSessionManager(): SessionManagerLike {
  return {
    getBranch: () => [],
    getSessionFile: () => "session.jsonl",
    getLeafId: () => "leaf-1",
  };
}

function createDeps(overrides?: (Partial<MemoryExtensionDeps> & {
  memories?: MemoryRecord[];
})) {
  const calls = {
    captures: [] as MemoryCaptureEvent[],
    extractorResolutions: [] as Array<MemoryExtractorResolution | null>,
    flushPendingWrites: 0,
  };

  const memories = overrides?.memories ?? [];

  const deps: MemoryExtensionDeps = {
    memoryService: {
      async capture(event) {
        calls.captures.push(event);
        const resolution = event.extractor ? await event.extractor.resolve() : null;
        calls.extractorResolutions.push(resolution);
        return {
          plan: {
            runHeuristics: event.type === "user_input",
            runLlmExtraction: !!event.extractor,
            captureConversation: event.type !== "user_input",
            consolidate: event.type === "session_shutdown" && event.reason !== "reload",
          },
          automaticCaptureQueued: event.type === "user_input",
          llmExtractionQueued: !!resolution,
          conversationCaptureQueued: event.type !== "user_input",
          consolidationQueued: event.type === "session_shutdown" && event.reason !== "reload",
        } satisfies MemoryCaptureResult;
      },
      async findRelevantMemories() {
        return memories;
      },
    },
    extractorMode: "off",
    extractorTriggerEvery: 2,
    async flushPendingWrites() {
      calls.flushPendingWrites += 1;
    },
    memoryTools: [{ name: "memory_add" } as never],
    registerCommands(pi) {
      pi.registerCommand("noodle", {} as never);
    },
  };

  return {
    calls,
    deps: {
      ...deps,
      ...overrides,
      memoryService: overrides?.memoryService ?? deps.memoryService,
    },
  };
}

function createCtx() {
  const model = { id: "active-model" } as Model<Api>;
  return {
    ui: { notify: () => undefined },
    model,
    modelRegistry: {
      getAll: () => [model, { id: "extractor-model" } as Model<Api>],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test", headers: {} }),
    },
    sessionManager: createFakeSessionManager(),
  };
}

test("memory extension injects relevant memories into the agent prompt", async () => {
  const pi = createFakePi();
  const { deps } = createDeps({
    memories: [{ text: "Team uses Turso", categories: ["project"], metadata: {} }],
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("before_agent_start");
  assert.ok(handler);

  const result = await handler!({ prompt: "How should I implement memory search?", systemPrompt: "Base system prompt" });
  assert.match((result as { systemPrompt: string }).systemPrompt, /Relevant user memory:/);
  assert.match((result as { systemPrompt: string }).systemPrompt, /Team uses Turso/);
});

test("memory extension forwards user input as one capture event with extractor context", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({
    extractorMode: "balanced",
    extractorModelId: "extractor-model",
    extractorTriggerEvery: 2,
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  const ctx = createCtx();
  await handler!({ source: "user", text: "Remember that I prefer concise replies." }, ctx);

  assert.equal(calls.captures.length, 1);
  assert.deepEqual(calls.captures[0]?.type, "user_input");
  assert.equal((calls.captures[0] as Extract<MemoryCaptureEvent, { type: "user_input" }>).text, "Remember that I prefer concise replies.");
  assert.equal(calls.extractorResolutions.length, 1);
  assert.equal(calls.extractorResolutions[0]?.model.id, "extractor-model");
});

test("memory extension skips extractor resolution when extractor mode is off", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({ extractorMode: "off" });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  await handler!({ source: "user", text: "Remember this." }, createCtx());

  assert.equal(calls.captures.length, 1);
  assert.equal(calls.captures[0]?.extractor, undefined);
  assert.deepEqual(calls.extractorResolutions, [null]);
});

test("memory extension passes unresolved extractor when model id is not found in registry", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({
    extractorMode: "balanced",
    extractorModelId: "missing-model",
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  await handler!({ source: "user", text: "Remember this." }, createCtx());

  assert.equal(calls.captures.length, 1);
  assert.equal(calls.extractorResolutions.length, 1);
  assert.equal(calls.extractorResolutions[0], null);
});

test("memory extension forwards session lifecycle events through the same capture seam", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({ extractorMode: "balanced", extractorModelId: "extractor-model" });

  createMemoryExtension(deps)(pi as never);

  const compact = pi.hooks.get("session_before_compact");
  const switchHook = pi.hooks.get("session_before_switch");
  const shutdown = pi.hooks.get("session_shutdown");
  assert.ok(compact && switchHook && shutdown);

  const ctx = createCtx();
  await compact!({}, ctx);
  await switchHook!({ reason: "branch" }, ctx);
  await shutdown!({ reason: "exit" }, ctx);

  assert.deepEqual(calls.captures.map((event) => event.type), [
    "session_before_compact",
    "session_before_switch",
    "session_shutdown",
  ]);
  assert.deepEqual(
    calls.captures.map((event) => event.type === "session_before_switch" || event.type === "session_shutdown" ? event.reason : null),
    [null, "branch", "exit"],
  );
  assert.equal(calls.flushPendingWrites, 1);
});

test("memory extension still flushes writes on reload shutdown", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({ extractorMode: "balanced", extractorModelId: "extractor-model" });

  createMemoryExtension(deps)(pi as never);

  const shutdown = pi.hooks.get("session_shutdown");
  assert.ok(shutdown);

  await shutdown!({ reason: "reload" }, createCtx());

  assert.equal(calls.captures.length, 1);
  assert.equal(calls.captures[0]?.type, "session_shutdown");
  assert.equal((calls.captures[0] as Extract<MemoryCaptureEvent, { type: "session_shutdown" }>).reason, "reload");
  assert.equal(calls.flushPendingWrites, 1);
});
