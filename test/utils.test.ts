import test from "node:test";
import assert from "node:assert/strict";

import {
  asFiniteNumber,
  asStringArray,
  isJsonObject,
  parseJsonObject,
  parseJsonStringArray,
} from "../src/utils.ts";

test("asStringArray accepts a string or string array and drops non-strings", () => {
  assert.deepEqual(asStringArray("one"), ["one"]);
  assert.deepEqual(asStringArray(["one", 2, "three", null]), ["one", "three"]);
  assert.deepEqual(asStringArray({ nope: true }), []);
});

test("asFiniteNumber only returns finite numbers", () => {
  assert.equal(asFiniteNumber(42), 42);
  assert.equal(asFiniteNumber(Number.POSITIVE_INFINITY), undefined);
  assert.equal(asFiniteNumber("42"), undefined);
});

test("isJsonObject rejects arrays and null", () => {
  assert.equal(isJsonObject({ ok: true }), true);
  assert.equal(isJsonObject(["nope"]), false);
  assert.equal(isJsonObject(null), false);
});

test("parseJsonObject parses plain objects and falls back otherwise", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('[1,2,3]', { fallback: true }), { fallback: true });
  assert.deepEqual(parseJsonObject('bad json', { fallback: true }), { fallback: true });
});

test("parseJsonStringArray parses arrays and filters to strings", () => {
  assert.deepEqual(parseJsonStringArray('["a",2,"b"]'), ["a", "b"]);
  assert.deepEqual(parseJsonStringArray('"solo"'), ["solo"]);
  assert.deepEqual(parseJsonStringArray('{"nope":true}', ["fallback"]), ["fallback"]);
});
