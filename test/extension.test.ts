import test from "node:test";
import assert from "node:assert/strict";

import type { Api, Model } from "@earendil-works/pi-ai";

import { createMemoryExtension, type MemoryExtensionDeps } from "../src/extension.ts";
import type { MemoryRecord } from "../src/memory/types.ts";
import type { NotificationTarget, SessionManagerLike } from "../src/types.ts";

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
    queueAutomaticCapture: [] as string[],
    queueLLMExtraction: [] as Array<{ model: Model<Api> | undefined; target?: NotificationTarget }>,
    captureSessionConversation: [] as string[],
    queueConsolidation: 0,
    flushPendingWrites: 0,
  };

  const memories = overrides?.memories ?? [];

  const deps: MemoryExtensionDeps = {
    memoryService: {
      queueAutomaticCapture(text) {
        calls.queueAutomaticCapture.push(text);
        return true;
      },
      queueLLMExtraction(_sessionManager, model, target, _extractionOptions) {
        calls.queueLLMExtraction.push(target ? { model, target } : { model });
        return true;
      },
      queueConsolidation() {
        calls.queueConsolidation += 1;
      },
      async captureSessionConversation(_sessionManager, reason) {
        calls.captureSessionConversation.push(reason);
        return true;
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

test("memory extension queues automatic capture and extractor on the configured turn cadence", async () => {
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
  await handler!({ source: "user", text: "My name is Brian." }, ctx);

  assert.deepEqual(calls.queueAutomaticCapture, [
    "Remember that I prefer concise replies.",
    "My name is Brian.",
  ]);
  assert.equal(calls.queueLLMExtraction.length, 1);
  assert.equal((calls.queueLLMExtraction[0]?.model as { id: string }).id, "extractor-model");
});

test("memory extension skips extraction when model id not found in registry", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({
    extractorMode: "balanced",
    extractorModelId: "nonexistent-model",
    extractorTriggerEvery: 2,
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  const ctx = createCtx();
  await handler!({ source: "user", text: "Remember this." }, ctx);
  await handler!({ source: "user", text: "And this." }, ctx);

  // Automatic capture should fire, but LLM extraction should not
  assert.equal(calls.queueAutomaticCapture.length, 2);
  assert.equal(calls.queueLLMExtraction.length, 0);
});

test("memory extension skips extraction when no extractor model is configured", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({
    extractorMode: "balanced",
    // extractorModelId left undefined
    extractorTriggerEvery: 2,
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  const ctx = createCtx();
  await handler!({ source: "user", text: "Remember this." }, ctx);
  await handler!({ source: "user", text: "And this." }, ctx);

  assert.equal(calls.queueLLMExtraction.length, 0);
});

test("memory extension can run extractor every turn in proactive setups", async () => {
  const pi = createFakePi();
  const { deps, calls } = createDeps({
    extractorMode: "proactive",
    extractorModelId: "extractor-model",
    extractorTriggerEvery: 1,
  });

  createMemoryExtension(deps)(pi as never);

  const handler = pi.hooks.get("input");
  assert.ok(handler);

  const ctx = createCtx();
  await handler!({ source: "user", text: "I usually prefer concise examples." }, ctx);
  await handler!({ source: "user", text: "Use TypeScript by default." }, ctx);

  assert.equal(calls.queueLLMExtraction.length, 2);
});

test("memory extension captures session transitions and flushes writes on shutdown", async () => {
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

  assert.deepEqual(calls.captureSessionConversation, [
    "before_compact",
    "before_switch:branch",
    "shutdown:exit",
  ]);
  assert.equal(calls.queueConsolidation, 1);
  assert.equal(calls.flushPendingWrites, 1);
  assert.equal(calls.queueLLMExtraction.length, 1);
});
