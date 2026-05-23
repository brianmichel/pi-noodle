import test from "node:test";
import assert from "node:assert/strict";

import { buildCandidateBaseUrls } from "../src/api.ts";

test("buildCandidateBaseUrls keeps root and strips common accidental suffixes", () => {
  assert.deepEqual(buildCandidateBaseUrls("http://memory-api.example.com"), ["http://memory-api.example.com"]);
  assert.deepEqual(buildCandidateBaseUrls("http://memory-api.example.com/api"), [
    "http://memory-api.example.com/api",
    "http://memory-api.example.com",
  ]);
  assert.deepEqual(buildCandidateBaseUrls("http://memory-api.example.com/v1"), [
    "http://memory-api.example.com/v1",
    "http://memory-api.example.com",
  ]);
});
