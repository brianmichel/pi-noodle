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
  const result = prefilterUserMessage("Never add comments to code");
  assert.equal(result.hasCandidate, true);
  assert.match(result.candidates[0]?.text ?? "", /avoid|never add comments/i);
});

test("captures softer habitual preferences", () => {
  const result = prefilterUserMessage("I usually prefer concise TypeScript examples.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "response_style");
  assert.match(result.candidates[0]?.text ?? "", /concise TypeScript examples/i);
});

test("captures tends-to preferences", () => {
  const result = prefilterUserMessage("I tend to prefer markdown summaries.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "response_style");
  assert.match(result.candidates[0]?.text ?? "", /markdown summaries/i);
});

test("captures workflow defaults", () => {
  const result = prefilterUserMessage("I normally use bun for small scripts.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "workflow");
  assert.match(result.candidates[0]?.text ?? "", /normally uses bun/i);
});

test("captures project defaults", () => {
  const result = prefilterUserMessage("For most projects, I prefer Go for small daemons.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "coding_pref");
  assert.match(result.candidates[0]?.text ?? "", /Default to Go/i);
});

test("captures negative preferences", () => {
  const result = prefilterUserMessage("Please don't use heavy frameworks for small daemons.");
  assert.equal(result.hasCandidate, true);
  assert.match(result.candidates[0]?.text ?? "", /avoids heavy frameworks/i);
});

test("captures project standards", () => {
  const result = prefilterUserMessage("We standardize on TypeScript for backend services.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "project");
  assert.match(result.candidates[0]?.text ?? "", /Team uses TypeScript/i);
});

test("captures explicit stack descriptions", () => {
  const result = prefilterUserMessage("Our stack is Postgres, Bun, and TypeScript.");
  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates[0]?.category, "project");
  assert.match(result.candidates[0]?.text ?? "", /Team uses Postgres, Bun, and TypeScript/i);
});

test("still ignores temporary soft preferences", () => {
  const result = prefilterUserMessage("For this task, I usually prefer very verbose explanations.");
  assert.equal(result.hasCandidate, false);
});
