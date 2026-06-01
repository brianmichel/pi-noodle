import test from "node:test";
import assert from "node:assert/strict";

import { parseExtractedCandidates } from "../src/memory/extractor.ts";
import { deriveProjectKey, normalizeGitRemote } from "../src/memory/project-identity.ts";

test("parseExtractedCandidates normalizes applicability fields", () => {
  const parsed = parseExtractedCandidates(JSON.stringify([
    {
      text: "User prefers concise TypeScript examples",
      category: "response_style",
      durability: "semi_durable",
      confidence: 0.88,
      reason: "explicit_statement",
      stability: "stable",
      sensitivity: "safe",
      suggestedAction: "save",
      applicability: "user",
      applicabilityConfidence: 0.86,
      applicabilityReason: "Broad preference stated as a default.",
    },
  ]));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.applicability, "user");
  assert.equal(parsed[0]?.applicabilityConfidence, 0.86);
  assert.equal(parsed[0]?.applicabilityReason, "Broad preference stated as a default.");
});

test("parseExtractedCandidates falls back to unknown applicability for invalid values", () => {
  const parsed = parseExtractedCandidates(JSON.stringify([
    {
      text: "Use plain TypeScript modules for the web viewer refactor",
      category: "coding_pref",
      durability: "semi_durable",
      confidence: 0.9,
      applicability: "repo-local",
    },
  ]));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.applicability, "unknown");
});

test("normalizeGitRemote handles ssh and https remotes", () => {
  assert.equal(normalizeGitRemote("git@github.com:earendil-works/pi-noodle.git"), "github.com/earendil-works/pi-noodle");
  assert.equal(normalizeGitRemote("https://github.com/earendil-works/pi-noodle.git"), "github.com/earendil-works/pi-noodle");
});

test("deriveProjectKey falls back to cwd when not in a git repo", () => {
  const key = deriveProjectKey("/");
  assert.ok(key);
  assert.match(key!, /^cwd:/);
});
