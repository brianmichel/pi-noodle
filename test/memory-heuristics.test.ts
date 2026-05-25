import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSignalKey,
  evaluateCandidateDecision,
  prefilterUserMessage,
  shouldBlockSensitiveMemory,
  shouldRetrieveMemories,
} from "../src/memory/policy.ts";

test("detects explicit remember requests", () => {
  const result = prefilterUserMessage("Remember that I prefer concise TypeScript examples.");

  assert.equal(result.hasCandidate, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.text, "I prefer concise TypeScript examples");
  assert.equal(result.candidates[0]?.explicit, true);
});

test("does not heuristically capture implicit preferences anymore", () => {
  const result = prefilterUserMessage("I usually prefer concise TypeScript examples.");

  assert.equal(result.hasCandidate, false);
  assert.equal(result.candidates.length, 0);
});

test("ignores temporary instructions", () => {
  const result = prefilterUserMessage("Remember that I prefer Elixir by default for this task.");

  assert.equal(result.hasCandidate, false);
  assert.equal(result.candidates.length, 0);
});

test("blocks sensitive content from becoming memory", () => {
  assert.equal(shouldBlockSensitiveMemory("My API key is sk-secret-value"), true);

  const result = prefilterUserMessage("Remember this token sk-secret-value forever");
  assert.equal(result.hasCandidate, false);
  assert.deepEqual(result.candidateReasons, ["sensitive_content_blocked"]);
});

test("buildSignalKey is stable for dedupe", () => {
  const result = prefilterUserMessage("Remember that I prefer concise replies");
  const candidate = result.candidates[0];

  assert.ok(candidate);
  assert.equal(buildSignalKey(candidate), "response_style:i prefer concise replies");
});

test("retrieval classifier skips casual chatter and matches work prompts", () => {
  assert.equal(shouldRetrieveMemories("hey there"), false);
  assert.equal(shouldRetrieveMemories("Can you refactor this backend function?"), true);
});

test("explicit remember requests still auto-save in balanced mode", () => {
  const candidate = prefilterUserMessage("Remember that I prefer concise TypeScript examples.").candidates[0];
  assert.ok(candidate);

  const decision = evaluateCandidateDecision(candidate, {
    key: buildSignalKey(candidate),
    text: candidate.text,
    normalized: candidate.normalized,
    category: candidate.category,
    durability: candidate.durability,
    source: candidate.source,
    confidence: candidate.confidence,
    explicit: candidate.explicit,
    count: 1,
    lastSeenAt: Date.now(),
    strongestConfidence: candidate.confidence,
    reasons: candidate.reasons,
    metadata: {},
  } as never, "balanced");

  assert.equal(decision.action, "save");
  assert.equal(decision.shouldPromote, true);
});
