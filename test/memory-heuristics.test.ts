import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSignalKey,
  prefilterUserMessage,
  shouldBlockSensitiveMemory,
  shouldRetrieveMemories,
} from "../src/memory/policy.ts";

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
  assert.equal(shouldRetrieveMemories("hey there"), false);
  assert.equal(shouldRetrieveMemories("Can you refactor this backend function?"), true);
});

test("captures role identity", () => {
  const result = prefilterUserMessage("I'm a senior engineer at Acme.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "identity");
  assert.equal(result.candidates[0]?.durability, "durable");
  assert.equal(result.candidates[0]?.text, "User is a senior engineer");
});

test("captures expertise background", () => {
  const result = prefilterUserMessage("I've been doing distributed systems for 8 years.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "identity");
  assert.equal(result.candidates[0]?.durability, "durable");
  assert.match(result.candidates[0]?.text ?? "", /experience with distributed systems/i);
});

test("captures tech stack decisions", () => {
  const result = prefilterUserMessage("We're using Postgres for our database.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "project");
  assert.equal(result.candidates[0]?.durability, "semi_durable");
  assert.match(result.candidates[0]?.text ?? "", /Team uses Postgres/i);
});

test("captures format preferences", () => {
  const result = prefilterUserMessage("Always give me bullet points.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "response_style");
  assert.match(result.candidates[0]?.text ?? "", /bullet points/i);
});

test("strong_preference extracts the full action phrase not just the keyword", () => {
  // Using a sentence without embedded punctuation so the full phrase is captured.
  // The category may be inferred as coding_pref when context words (use + code) are present.
  const result = prefilterUserMessage("Never add comments to code");
  assert.equal(result.hasCandidate, true);
  // The captured text should be the full phrase, not just "never"
  assert.match(result.candidates[0]?.text ?? "", /never add comments/i);
});
