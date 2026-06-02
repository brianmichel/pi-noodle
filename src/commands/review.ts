import { memoryService } from "../memory/runtime.ts";
import type { MemoryRecord } from "../memory/types.ts";
import { describeError } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

type PendingCandidate = ReturnType<typeof memoryService.listPendingCandidates>[number];

type ReviewService = {
  list: typeof memoryService.list;
  delete: typeof memoryService.delete;
  listPendingCandidates: typeof memoryService.listPendingCandidates;
  dismissPendingCandidate: typeof memoryService.dismissPendingCandidate;
  promotePendingCandidate: typeof memoryService.promotePendingCandidate;
};

const SAVED_PREFIX = "[s";
const PENDING_PREFIX = "[p";
const ACTION_SAVE_ALL = "Save all pending candidates";
const ACTION_DELETE_ALL = "Delete all listed items";
const ACTION_DONE = "Exit review";
const ACTION_BACK = "Back";

export async function runReview(ui: CtxUi, service: ReviewService = memoryService): Promise<void> {
  try {
    let autoSaved = await listAutoSaved(service);
    let pending = service.listPendingCandidates();
    let deletedSaved = 0;
    let dismissedPending = 0;
    let savedPending = 0;

    if (autoSaved.length === 0 && pending.length === 0) {
      ui.notify("No auto-saved or pending memory candidates to review.", "info");
      return;
    }

    ui.notify(
      "Select an item to review it individually. [sN] means saved memory and [pN] means pending candidate. Saved items can be deleted; pending items can be saved or deleted. Bottom actions apply to the whole list.",
      "info",
    );

    while (true) {
      const choice = await ui.select("Review memories", buildReviewOptions(autoSaved, pending));

      if (!choice || choice === ACTION_DONE) {
        notifySummary(ui, deletedSaved, dismissedPending, savedPending);
        return;
      }

      if (choice === ACTION_SAVE_ALL) {
        const count = await saveAllPendingCandidates(ui, service, pending);
        if (count === 0) continue;
        savedPending += count;
        pending = service.listPendingCandidates();
        continue;
      }

      if (choice === ACTION_DELETE_ALL) {
        const deleted = await deleteAllListedItems(ui, service, autoSaved, pending);
        if (!deleted) continue;
        deletedSaved += deleted.deletedSaved;
        dismissedPending += deleted.dismissedPending;
        autoSaved = [];
        pending = [];
        notifySummary(ui, deletedSaved, dismissedPending, savedPending);
        return;
      }

      if (choice.startsWith(SAVED_PREFIX)) {
        const selected = selectByPrefix(choice, autoSaved, SAVED_PREFIX);
        if (!selected) continue;

        const action = await ui.select(
          `Saved memory ${choice.slice(0, choice.indexOf(" "))}`,
          ["Delete this saved memory", ACTION_BACK],
        );
        if (action !== "Delete this saved memory") continue;

        const deleted = await deleteSavedMemory(ui, service, selected);
        if (!deleted) continue;
        autoSaved = autoSaved.filter((memory) => memory !== selected);
        deletedSaved += 1;
      }

      if (choice.startsWith(PENDING_PREFIX)) {
        const selected = selectByPrefix(choice, pending, PENDING_PREFIX);
        if (!selected) continue;

        const action = await ui.select(
          `Pending candidate ${choice.slice(0, choice.indexOf(" "))}`,
          ["Save this pending candidate", "Delete this pending candidate", ACTION_BACK],
        );

        if (action === "Save this pending candidate") {
          const saved = await savePendingCandidate(ui, service, selected);
          if (!saved) continue;
          pending = pending.filter((candidate) => candidate.key !== selected.key);
          savedPending += 1;
          continue;
        }

        if (action !== "Delete this pending candidate") continue;

        const dismissed = await dismissPendingCandidate(ui, service, selected);
        if (!dismissed) continue;
        pending = pending.filter((candidate) => candidate.key !== selected.key);
        dismissedPending += 1;
      }

      if (autoSaved.length === 0 && pending.length === 0) {
        notifySummary(ui, deletedSaved, dismissedPending, savedPending);
        return;
      }
    }
  } catch (error) {
    ui.notify(`Review failed: ${describeError(error)}`, "error");
  }
}

async function listAutoSaved(service: ReviewService): Promise<MemoryRecord[]> {
  const memories = await service.list();
  return memories
    .filter((memory) => {
      const source = memory.metadata.source as string | undefined;
      return source === "heuristic" || source === "repetition" || source === "llm_extracted" || source === "consolidated";
    })
    .slice(0, 10);
}

function buildReviewOptions(autoSaved: MemoryRecord[], pending: PendingCandidate[]): string[] {
  const options = [
    ...autoSaved.map((memory, index) => formatSavedOption(memory, index)),
    ...pending.map((candidate, index) => formatPendingOption(candidate, index)),
  ];

  if (pending.length > 0) options.push(ACTION_SAVE_ALL);
  if (autoSaved.length > 0 || pending.length > 0) options.push(ACTION_DELETE_ALL);
  options.push(ACTION_DONE);
  return options;
}

function selectByPrefix<T>(choice: string, items: T[], prefix: string): T | null {
  const index = parsePrefixedIndex(choice, prefix);
  return index === null ? null : (items[index] ?? null);
}

function parsePrefixedIndex(choice: string, prefix: string): number | null {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = choice.match(new RegExp(`^${escapedPrefix}(\\d+)\\]`));
  if (!match) return null;
  const value = parseInt(match[1] ?? "", 10) - 1;
  return Number.isNaN(value) || value < 0 ? null : value;
}

function formatSavedOption(memory: MemoryRecord, index: number): string {
  const source = memory.metadata.source ?? "?";
  const category = memory.category ?? memory.categories[0] ?? "?";
  const confidence = typeof memory.metadata.confidence === "number"
    ? ` ${Math.round((memory.metadata.confidence as number) * 100)}%`
    : "";
  return `[s${index + 1}] ${summarize(memory.text)} (${category}, ${source}${confidence})`;
}

function formatPendingOption(candidate: PendingCandidate, index: number): string {
  return `[p${index + 1}] ${summarize(candidate.text)} (score ${candidate.score}, seen ${candidate.count}×, ${Math.round(candidate.strongestConfidence * 100)}%)`;
}

async function savePendingCandidate(ui: CtxUi, service: ReviewService, candidate: PendingCandidate): Promise<boolean> {
  const ok = await ui.confirm(
    "Save pending candidate?",
    `${candidate.text}\n\nThis promotes it from pending review into saved memory.`,
  );
  if (!ok) {
    ui.notify("No changes made.", "info");
    return false;
  }

  const saved = await service.promotePendingCandidate(candidate.key);
  if (!saved) {
    ui.notify("Could not save that pending candidate.", "error");
    return false;
  }

  ui.notify(`Saved pending candidate: ${summarize(candidate.text)}`, "info");
  return true;
}

async function saveAllPendingCandidates(ui: CtxUi, service: ReviewService, pending: PendingCandidate[]): Promise<number> {
  const ok = await ui.confirm(
    "Save all pending candidates?",
    `${pending.length} pending candidate${pending.length === 1 ? "" : "s"} will be promoted into saved memory.`,
  );
  if (!ok) {
    ui.notify("No changes made.", "info");
    return 0;
  }

  let savedCount = 0;
  for (const candidate of pending) {
    if (await service.promotePendingCandidate(candidate.key)) {
      savedCount += 1;
    }
  }
  return savedCount;
}

async function deleteSavedMemory(ui: CtxUi, service: ReviewService, memory: MemoryRecord): Promise<boolean> {
  const ok = await ui.confirm(
    "Delete auto-saved memory?",
    `${memory.text}\n\nThis removes it from saved memories.`,
  );
  if (!ok) {
    ui.notify("No changes made.", "info");
    return false;
  }

  if (memory.id) {
    await service.delete(memory.id);
  }
  ui.notify(`Deleted saved memory: ${summarize(memory.text)}`, "info");
  return true;
}

async function deleteAllListedItems(
  ui: CtxUi,
  service: ReviewService,
  autoSaved: MemoryRecord[],
  pending: PendingCandidate[],
): Promise<{ deletedSaved: number; dismissedPending: number } | null> {
  const ok = await ui.confirm(
    "Delete all listed items?",
    `${autoSaved.length} saved memor${autoSaved.length === 1 ? "y" : "ies"} and ${pending.length} pending candidate${pending.length === 1 ? "" : "s"} will be removed from this review list.`,
  );
  if (!ok) {
    ui.notify("No changes made.", "info");
    return null;
  }

  let deletedSaved = 0;
  for (const memory of autoSaved) {
    if (memory.id) {
      await service.delete(memory.id);
      deletedSaved += 1;
    }
  }

  let dismissedPending = 0;
  for (const candidate of pending) {
    if (service.dismissPendingCandidate(candidate.key)) {
      dismissedPending += 1;
    }
  }

  ui.notify(
    `Deleted ${deletedSaved} saved memor${deletedSaved === 1 ? "y" : "ies"} and ${dismissedPending} pending candidate${dismissedPending === 1 ? "" : "s"}.`,
    "info",
  );
  return { deletedSaved, dismissedPending };
}

async function dismissPendingCandidate(ui: CtxUi, service: ReviewService, candidate: PendingCandidate): Promise<boolean> {
  const ok = await ui.confirm(
    "Delete pending candidate?",
    `${candidate.text}\n\nThis removes it from the pending review queue.`,
  );
  if (!ok) {
    ui.notify("No changes made.", "info");
    return false;
  }

  service.dismissPendingCandidate(candidate.key);
  ui.notify(`Deleted pending candidate: ${summarize(candidate.text)}`, "info");
  return true;
}

function notifySummary(ui: CtxUi, deletedSaved: number, dismissedPending: number, savedPending: number): void {
  if (deletedSaved === 0 && dismissedPending === 0 && savedPending === 0) {
    ui.notify("Review finished — no changes made.", "info");
    return;
  }

  ui.notify(
    `Review updated: saved ${savedPending}, removed ${deletedSaved} saved, and deleted ${dismissedPending} pending candidates.`,
    "info",
  );
}

function summarize(text: string, max = 90): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 1))}…`;
}
