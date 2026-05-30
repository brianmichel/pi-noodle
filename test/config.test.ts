import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_EXTRACTOR_MODE, defaultExtractorTriggerEvery, resolveConfig } from "../src/config.ts";

test("defaultExtractorTriggerEvery follows extractor mode defaults", () => {
  assert.equal(DEFAULT_EXTRACTOR_MODE, "balanced");
  assert.equal(defaultExtractorTriggerEvery("conservative"), 20);
  assert.equal(defaultExtractorTriggerEvery("balanced"), 10);
  assert.equal(defaultExtractorTriggerEvery("proactive"), 5);
});

test("resolveConfig fills extractor mode defaults when extractor config omits cadence", () => {
  const dir = mkdtempSync(join(tmpdir(), "noodle-config-"));
  const path = join(dir, "config.json");
  const previous = {
    NOODLE_CONFIG_PATH: process.env["NOODLE_CONFIG_PATH"],
  };

  try {
    writeFileSync(path, JSON.stringify({ extractor: { mode: "balanced" } }), "utf-8");
    process.env["NOODLE_CONFIG_PATH"] = path;

    const config = resolveConfig();
    assert.equal(config.extractor?.mode, "balanced");
    assert.equal(config.extractor?.triggerEvery, 10);
  } finally {
    if (previous.NOODLE_CONFIG_PATH === undefined) {
      delete process.env["NOODLE_CONFIG_PATH"];
    } else {
      process.env["NOODLE_CONFIG_PATH"] = previous.NOODLE_CONFIG_PATH;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig allows extractor mode env override and backfills cadence from that mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "noodle-config-"));
  const path = join(dir, "config.json");
  const previous = {
    NOODLE_CONFIG_PATH: process.env["NOODLE_CONFIG_PATH"],
    NOODLE_EXTRACTOR_MODE: process.env["NOODLE_EXTRACTOR_MODE"],
    NOODLE_EXTRACTOR_TRIGGER_EVERY: process.env["NOODLE_EXTRACTOR_TRIGGER_EVERY"],
  };

  try {
    writeFileSync(path, JSON.stringify({ extractor: { mode: "balanced", triggerEvery: 0 } }), "utf-8");
    process.env["NOODLE_CONFIG_PATH"] = path;
    process.env["NOODLE_EXTRACTOR_MODE"] = "proactive";
    delete process.env["NOODLE_EXTRACTOR_TRIGGER_EVERY"];

    const config = resolveConfig();
    assert.equal(config.extractor?.mode, "proactive");
    assert.equal(config.extractor?.triggerEvery, 5);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
