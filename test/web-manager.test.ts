import test from "node:test";
import assert from "node:assert/strict";

import { buildExplorerUrl } from "../src/web/manager.ts";

test("buildExplorerUrl binds loopback and includes token", () => {
  assert.equal(
    buildExplorerUrl(3000, "abc 123"),
    "http://127.0.0.1:3000/?token=abc%20123",
  );
});
