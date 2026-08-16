import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryClient } from "../src/memory/turso-client.ts";

import { flushPendingWrites } from "../src/queue.ts";
import { MemoryService } from "../src/memory/service.ts";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { MemoryCaptureEvent, MemoryRecord } from "../src/memory/types.ts";
import { fakeSemanticEmbedder } from "./helpers/fake-embedder.ts";

type MemoryEvalCase = {
  name: string;
  messages: string[];
  expectedSaved?: string[];
  expectedNotSaved?: string[];
  expectedMetadata?: Array<{ textIncludes: string; key: string; value: unknown }>;
  queries?: Array<{
    query: string;
    shouldRetrieve: string[];
    shouldNotRetrieve?: string[];
  }>;
};

async function createService(): Promise<{ service: MemoryService; close: () => void }> {
  const db = await createMemoryClient();
  const backend = new TursoBackend(db, fakeSemanticEmbedder);
  return {
    service: new MemoryService(backend),
    close: () => db.close(),
  };
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

async function captureMessages(service: MemoryService, messages: string[]): Promise<void> {
  for (const message of messages) {
    await service.capture(createInputEvent(message));
    await flushPendingWrites();
  }
}

function texts(records: MemoryRecord[]): string[] {
  return records.map((record) => record.text);
}

const CASES: MemoryEvalCase[] = [
  {
    name: "captures explicit remember requests and retrieves them later",
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
    name: "does not heuristically capture implicit preferences anymore",
    messages: ["I usually prefer concise TypeScript examples."],
    expectedNotSaved: ["concise TypeScript examples"],
  },
  {
    name: "classifies broad explicit preferences as user-applicable",
    messages: ["Remember that I prefer concise TypeScript examples."],
    expectedSaved: ["I prefer concise TypeScript examples"],
    expectedMetadata: [
      { textIncludes: "concise TypeScript examples", key: "applicability", value: "user" },
    ],
  },
  {
    name: "does not capture temporary instructions even when phrased as remember",
    messages: ["Remember that for this task, be extra verbose."],
    expectedNotSaved: ["extra verbose"],
  },
  {
    name: "does not capture sensitive content",
    messages: ["Remember this API key sk-abc123"],
    expectedNotSaved: ["sk-abc123", "API key"],
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

      for (const expected of evalCase.expectedMetadata ?? []) {
        const record = saved.find((entry) => entry.text.toLowerCase().includes(expected.textIncludes.toLowerCase()));
        assert.ok(record, `expected saved memory containing ${expected.textIncludes}`);
        assert.deepEqual(record.metadata[expected.key], expected.value);
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
    } finally {
      close();
    }
  });
}
