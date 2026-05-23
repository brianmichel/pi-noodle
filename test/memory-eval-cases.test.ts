import test from "node:test";
import assert from "node:assert/strict";

import { prefilterUserMessage } from "../src/memory/policy.ts";

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

function runCapture(messages: string[]): string[] {
  return messages.flatMap((message) => prefilterUserMessage(message).candidates.map((candidate) => candidate.text));
}

const CAPTURE_CASES: MemoryEvalCase[] = [
  {
    name: "captures explicit preference",
    messages: ["Remember that I prefer concise TypeScript examples."],
    expectedSaved: ["User prefers concise TypeScript examples"],
  },
  {
    name: "captures identity",
    messages: ["My name is Brian."],
    expectedSaved: ["Call user Brian"],
  },
  {
    name: "captures project decision",
    messages: ["We're using Turso for our vector search."],
    expectedSaved: ["Team uses Turso"],
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
];

for (const evalCase of CAPTURE_CASES) {
  test(`memory eval capture: ${evalCase.name}`, () => {
    const captured = runCapture(evalCase.messages);

    for (const expected of evalCase.expectedSaved ?? []) {
      assert.ok(captured.some((text) => text.toLowerCase().includes(expected.toLowerCase())));
    }

    for (const blocked of evalCase.expectedNotSaved ?? []) {
      assert.ok(captured.every((text) => !text.toLowerCase().includes(blocked.toLowerCase())));
    }
  });
}

test("memory eval update/forget shape remains supported", () => {
  const evalCase: MemoryEvalCase = {
    name: "forget preference",
    messages: ["I usually prefer Go for small daemons."],
    forget: [
      {
        command: "Forget that I prefer Go.",
        laterQuery: "What language should I use for this daemon?",
        shouldNotRetrieve: ["Go"],
      },
    ],
  };

  assert.equal(evalCase.forget?.[0]?.command, "Forget that I prefer Go.");
  assert.deepEqual(evalCase.forget?.[0]?.shouldNotRetrieve, ["Go"]);
});
