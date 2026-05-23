import test from "node:test";
import assert from "node:assert/strict";

import { createClient } from "@libsql/client";

import { flushPendingWrites } from "../src/queue.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { MemoryRecord } from "../src/memory/types.ts";
import { fakeSemanticEmbedder } from "./helpers/fake-embedder.ts";

type MemoryEvalCase = {
  name: string;
  messages: string[];
  expectedSaved?: string[];
  expectedNotSaved?: string[];
  queries?: Array<{
    query: string;
    shouldRetrieve: string[];
    shouldNotRetrieve?: string[];
  }>;
  forget?: Array<{
    command: string;
    laterQuery: string;
    shouldNotRetrieve: string[];
  }>;
};

async function createService(): Promise<{ service: MemoryService; close: () => void }> {
  const db = createClient({ url: ":memory:" });
  const backend = new TursoBackend(db, fakeSemanticEmbedder);
  return {
    service: new MemoryService(backend),
    close: () => db.close(),
  };
}

async function captureMessages(service: MemoryService, messages: string[]): Promise<void> {
  for (const message of messages) {
    service.queueAutomaticCapture(message);
    await flushPendingWrites();
  }
}

function texts(records: MemoryRecord[]): string[] {
  return records.map((record) => record.text);
}

const CASES: MemoryEvalCase[] = [
  {
    name: "captures explicit preference and retrieves it later",
    messages: ["Remember that I prefer concise TypeScript examples."],
    expectedSaved: ["I prefer concise TypeScript examples"],
    queries: [
      {
        query: "How should you format code examples for me?",
        shouldRetrieve: ["concise TypeScript examples"],
      },
    ],
  },
  {
    name: "captures identity and retrieves it later",
    messages: ["My name is Brian."],
    expectedSaved: ["Call user Brian"],
    queries: [
      {
        query: "What should you call me?",
        shouldRetrieve: ["Brian"],
      },
    ],
  },
  {
    name: "captures project decisions and retrieves them for repo questions",
    messages: [
      "We're using Turso for our vector search.",
      "We're using Turso for our vector search.",
      "We're using Turso for our vector search.",
    ],
    expectedSaved: ["Team uses Turso"],
    queries: [
      {
        query: "How should I implement memory search in this repo?",
        shouldRetrieve: ["Turso"],
      },
      {
        query: "What is the capital of France?",
        shouldNotRetrieve: ["Turso"],
        shouldRetrieve: [],
      },
    ],
  },
  {
    name: "does not capture temporary instructions",
    messages: ["For this task, be extra verbose."],
    expectedNotSaved: ["extra verbose"],
  },
  {
    name: "does not capture sensitive content",
    messages: ["My API key is sk-abc123"],
    expectedNotSaved: ["sk-abc123", "API key"],
  },
  {
    name: "promotes repeated implicit preferences and supports forgetting them",
    messages: [
      "Use Go by default for small daemons.",
      "Use Go by default for small daemons.",
      "Use Go by default for small daemons.",
    ],
    expectedSaved: ["Default to Go"],
    queries: [
      {
        query: "What language should I use for daemon code?",
        shouldRetrieve: ["Go"],
      },
    ],
    forget: [
      {
        command: "Forget that I prefer Go.",
        laterQuery: "What language should I use for daemon code?",
        shouldNotRetrieve: ["Go"],
      },
    ],
  },
];

for (const evalCase of CASES) {
  test(`memory eval: ${evalCase.name}`, async () => {
    const { service, close } = await createService();

    try {
      await captureMessages(service, evalCase.messages);
      const saved = await service.list();
      const savedTexts = texts(saved);

      for (const expected of evalCase.expectedSaved ?? []) {
        assert.ok(savedTexts.some((text) => text.toLowerCase().includes(expected.toLowerCase())));
      }

      for (const blocked of evalCase.expectedNotSaved ?? []) {
        assert.ok(savedTexts.every((text) => !text.toLowerCase().includes(blocked.toLowerCase())));
      }

      for (const queryCase of evalCase.queries ?? []) {
        const retrieved = await service.findRelevantMemories(queryCase.query, 5);
        const retrievedTexts = texts(retrieved);

        for (const expected of queryCase.shouldRetrieve) {
          assert.ok(
            retrievedTexts.some((text) => text.toLowerCase().includes(expected.toLowerCase())),
            `expected query to retrieve ${expected}, got: ${retrievedTexts.join(" | ")}`,
          );
        }

        for (const blocked of queryCase.shouldNotRetrieve ?? []) {
          assert.ok(
            retrievedTexts.every((text) => !text.toLowerCase().includes(blocked.toLowerCase())),
            `expected query not to retrieve ${blocked}, got: ${retrievedTexts.join(" | ")}`,
          );
        }
      }

      for (const forgetCase of evalCase.forget ?? []) {
        const beforeForget = await service.findRelevantMemories(forgetCase.laterQuery, 5);
        const target = beforeForget.find((record) =>
          forgetCase.shouldNotRetrieve.some((blocked) => record.text.toLowerCase().includes(blocked.toLowerCase())),
        );

        assert.ok(target?.id, `expected a deletable memory for command: ${forgetCase.command}`);
        await service.delete(target!.id!);

        const afterForget = await service.findRelevantMemories(forgetCase.laterQuery, 5);
        const afterTexts = texts(afterForget);
        for (const blocked of forgetCase.shouldNotRetrieve) {
          assert.ok(afterTexts.every((text) => !text.toLowerCase().includes(blocked.toLowerCase())));
        }
      }
    } finally {
      close();
    }
  });
}
