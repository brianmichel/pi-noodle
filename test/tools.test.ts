import test from "node:test";
import assert from "node:assert/strict";

import { memoryTools } from "../src/tools.ts";

test("public memory tools are provider-agnostic", () => {
  const names = memoryTools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "memory_add",
    "memory_delete",
    "memory_get",
    "memory_list",
    "memory_search",
    "memory_update",
  ]);
  assert.equal(names.some((name) => name.startsWith("mem0_")), false);
});
