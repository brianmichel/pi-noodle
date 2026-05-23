import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSignalKey,
  classifyPromptForRetrieval,
  prefilterUserMessage,
  shouldBlockSensitiveMemory,
} from "../src/memory-heuristics.ts";

test("detects durable identity memories", () => {
  const result = prefilterUserMessage("Please call me small dog.");

  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.category, "identity");
  assert.equal(result.candidates[0]?.durability, "durable");
  assert.equal(result.candidates[0]?.text, "Call user small dog");
});

test("ignores temporary instructions", () => {
  const result = prefilterUserMessage("Use Elixir by default for this task.");

  assert.equal(result.hasCandidate, false);
  assert.equal(result.candidates.length, 0);
});

test("blocks sensitive content from becoming memory", () => {
  assert.equal(shouldBlockSensitiveMemory("My API key is sk-secret-value"), true);

  const result = prefilterUserMessage("Remember this token sk-secret-value forever");
  assert.equal(result.hasCandidate, false);
  assert.deepEqual(result.candidateReasons, ["sensitive_content_blocked"]);
});

test("marks coding preferences as retrievable and canonicalizes them without hardcoded language rules", () => {
  const result = prefilterUserMessage("Use Elixir by default for backend code.");

  assert.equal(result.hasCandidate, true);
  assert.equal(result.shouldRetrieve, true);
  assert.equal(result.candidates[0]?.category, "coding_pref");
  assert.equal(result.candidates[0]?.text, "Default to Elixir");
});

test("buildSignalKey is stable for dedupe", () => {
  const result = prefilterUserMessage("Call me small dog");
  const candidate = result.candidates[0];

  assert.ok(candidate);
  assert.equal(buildSignalKey(candidate), "identity:call user small dog");
});

test("retrieval classifier skips casual chatter and matches work prompts", () => {
  assert.equal(classifyPromptForRetrieval("hey there"), false);
  assert.equal(classifyPromptForRetrieval("Can you refactor this backend function?"), true);
});
