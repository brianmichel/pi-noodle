import test from "node:test";
import assert from "node:assert/strict";

import { runReview } from "../src/commands/review.ts";
import type { MemoryRecord } from "../src/memory/types.ts";
import type { CtxUi } from "../src/commands/ui.ts";

function createUi(options?: {
  selects?: Array<string | undefined>;
  confirms?: boolean[];
}) {
  const notifications: Array<{ message: string; level: "info" | "error" }> = [];
  const selects = [...(options?.selects ?? [])];
  const confirms = [...(options?.confirms ?? [])];

  const ui: CtxUi = {
    async select() {
      return selects.shift();
    },
    async input() {
      return undefined;
    },
    async confirm() {
      return confirms.shift() ?? false;
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
  };

  return { ui, notifications };
}

type PendingCandidate = {
  key: string;
  text: string;
  score: number;
  count: number;
  strongestConfidence: number;
  lastSeenAt: number;
  normalized: string;
  category: "workflow";
  durability: "semi_durable";
  source: "llm_extracted";
  explicit: false;
  reasons: string[];
  metadata: Record<string, unknown>;
  lastDecisionAction: "pending";
  promotionReasons: string[];
};

function createService(options?: {
  autoSaved?: MemoryRecord[];
  pending?: PendingCandidate[];
}) {
  const deleted: string[] = [];
  const dismissed: string[] = [];
  const promoted: string[] = [];
  const autoSaved = options?.autoSaved ?? [];
  let pending = options?.pending ?? [];

  return {
    service: {
      async list() {
        return autoSaved;
      },
      async delete(id: string) {
        deleted.push(id);
      },
      listPendingCandidates() {
        return pending;
      },
      dismissPendingCandidate(key: string) {
        dismissed.push(key);
        pending = pending.filter((candidate) => candidate.key !== key);
        return true;
      },
      async promotePendingCandidate(key: string) {
        const exists = pending.some((candidate) => candidate.key === key);
        if (exists) {
          promoted.push(key);
          pending = pending.filter((candidate) => candidate.key !== key);
        }
        return exists;
      },
    },
    deleted,
    dismissed,
    promoted,
  };
}

function pendingCandidate(): PendingCandidate {
  return {
    key: "p1",
    text: "Prefer plain TypeScript modules",
    score: 0.7,
    count: 2,
    strongestConfidence: 0.88,
    lastSeenAt: Date.now(),
    normalized: "prefer plain typescript modules",
    category: "workflow",
    durability: "semi_durable",
    source: "llm_extracted",
    explicit: false,
    reasons: ["explicit_statement"],
    metadata: {},
    lastDecisionAction: "pending",
    promotionReasons: ["project-scoped"],
  };
}

test("runReview exits cleanly when there is nothing to review", async () => {
  const { ui, notifications } = createUi();
  const { service } = createService();

  await runReview(ui, service);

  assert.equal(notifications[0]?.message, "No auto-saved or pending memory candidates to review.");
});

test("runReview lets the user delete one auto-saved memory through item selection", async () => {
  const { ui, notifications } = createUi({
    selects: ["[s1] User prefers concise replies (response_style, heuristic 91%)", "Delete this saved memory", "Exit review"],
    confirms: [true],
  });
  const { service, deleted } = createService({
    autoSaved: [{
      id: "m1",
      text: "User prefers concise replies",
      category: "response_style",
      categories: ["response_style"],
      metadata: { source: "heuristic", confidence: 0.91 },
    }],
  });

  await runReview(ui, service);

  assert.deepEqual(deleted, ["m1"]);
  assert.ok(notifications.some((entry) => entry.message.includes("Deleted saved memory: User prefers concise replies")));
  assert.ok(notifications.some((entry) => entry.message.includes("Review updated: saved 0, removed 1 saved, and deleted 0 pending candidates.")));
});

test("runReview lets the user delete one pending candidate through item selection", async () => {
  const { ui, notifications } = createUi({
    selects: ["[p1] Prefer plain TypeScript modules (score 0.7, seen 2×, 88%)", "Delete this pending candidate", "Exit review"],
    confirms: [true],
  });
  const { service, dismissed } = createService({
    pending: [pendingCandidate()],
  });

  await runReview(ui, service);

  assert.deepEqual(dismissed, ["p1"]);
  assert.ok(notifications.some((entry) => entry.message.includes("Deleted pending candidate: Prefer plain TypeScript modules")));
  assert.ok(notifications.some((entry) => entry.message.includes("Review updated: saved 0, removed 0 saved, and deleted 1 pending candidates.")));
});

test("runReview lets the user save one pending candidate individually", async () => {
  const { ui, notifications } = createUi({
    selects: ["[p1] Prefer plain TypeScript modules (score 0.7, seen 2×, 88%)", "Save this pending candidate", "Exit review"],
    confirms: [true],
  });
  const { service, promoted } = createService({
    pending: [pendingCandidate()],
  });

  await runReview(ui, service);

  assert.deepEqual(promoted, ["p1"]);
  assert.ok(notifications.some((entry) => entry.message.includes("Saved pending candidate: Prefer plain TypeScript modules")));
  assert.ok(notifications.some((entry) => entry.message.includes("Review updated: saved 1, removed 0 saved, and deleted 0 pending candidates.")));
});

test("runReview supports save-all from the bottom actions", async () => {
  const { ui, notifications } = createUi({
    selects: ["Save all pending candidates", "Exit review"],
    confirms: [true],
  });
  const { service, promoted } = createService({
    pending: [pendingCandidate()],
  });

  await runReview(ui, service);

  assert.deepEqual(promoted, ["p1"]);
  assert.ok(notifications.some((entry) => entry.message.includes("Review updated: saved 1, removed 0 saved, and deleted 0 pending candidates.")));
});

test("runReview supports delete-all from the bottom actions", async () => {
  const { ui, notifications } = createUi({
    selects: ["Delete all listed items"],
    confirms: [true],
  });
  const { service, deleted, dismissed } = createService({
    autoSaved: [{
      id: "m1",
      text: "User prefers concise replies",
      category: "response_style",
      categories: ["response_style"],
      metadata: { source: "heuristic", confidence: 0.91 },
    }],
    pending: [pendingCandidate()],
  });

  await runReview(ui, service);

  assert.deepEqual(deleted, ["m1"]);
  assert.deepEqual(dismissed, ["p1"]);
  assert.ok(notifications.some((entry) => entry.message.includes("Deleted 1 saved memory and 1 pending candidate.")));
});
