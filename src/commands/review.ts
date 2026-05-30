import { memoryService } from "../memory/runtime.ts";
import type { MemoryRecord } from "../memory/types.ts";
import { describeError } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

export async function runReview(ui: CtxUi): Promise<void> {
  try {
    const memories = await memoryService.list();
    const pending = memoryService.listPendingCandidates();

    const autoSaved = memories
      .filter((memory) => {
        const source = memory.metadata.source as string | undefined;
        return source === "heuristic" || source === "repetition" || source === "llm_extracted" || source === "consolidated";
      })
      .slice(0, 10);

    if (autoSaved.length === 0 && pending.length === 0) {
      ui.notify("No auto-saved or pending memory candidates to review.", "info");
      return;
    }

    notifySaved(ui, autoSaved);
    notifyPending(ui, pending);

    const input = await ui.input(
      "Delete saved memories with a1,a2 or dismiss pending with p1,p2. Press Enter to skip",
      "",
    );
    if (!input?.trim()) {
      ui.notify("No changes made.", "info");
      return;
    }

    const savedSelections: MemoryRecord[] = [];
    const pendingSelections: string[] = [];

    for (const token of input.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)) {
      const match = token.match(/^([ap])(\d+)$/);
      if (!match) continue;
      const index = parseInt(match[2] ?? "0", 10) - 1;
      if (match[1] === "a" && index >= 0 && index < autoSaved.length) {
        savedSelections.push(autoSaved[index]!);
      }
      if (match[1] === "p" && index >= 0 && index < pending.length) {
        pendingSelections.push(pending[index]!.key);
      }
    }

    if (savedSelections.length === 0 && pendingSelections.length === 0) {
      ui.notify("No valid selections — no changes made.", "info");
      return;
    }

    const preview = [
      ...savedSelections.map((memory) => `  delete saved: ${memory.text}`),
      ...pendingSelections.map((key) => {
        const signal = pending.find((candidate) => candidate.key === key);
        return `  dismiss pending: ${signal?.text ?? key}`;
      }),
    ].join("\n");

    const ok = await ui.confirm("Apply review changes?", preview);
    if (!ok) {
      ui.notify("Cancelled.", "info");
      return;
    }

    for (const memory of savedSelections) {
      if (memory.id) await memoryService.delete(memory.id);
    }
    for (const key of pendingSelections) {
      memoryService.dismissPendingCandidate(key);
    }

    ui.notify(
      `Review updated: removed ${savedSelections.length} saved and dismissed ${pendingSelections.length} pending candidates.`,
      "info",
    );
  } catch (error) {
    ui.notify(`Review failed: ${describeError(error)}`, "error");
  }
}

function notifySaved(ui: CtxUi, autoSaved: MemoryRecord[]): void {
  if (autoSaved.length === 0) return;
  ui.notify("─── Auto-saved memories ───", "info");
  for (let index = 0; index < autoSaved.length; index += 1) {
    const memory = autoSaved[index]!;
    const source = memory.metadata.source ?? "?";
    const category = memory.category ?? memory.categories[0] ?? "?";
    const confidence = typeof memory.metadata.confidence === "number"
      ? ` ${Math.round((memory.metadata.confidence as number) * 100)}%`
      : "";
    ui.notify(`[a${index + 1}] ${memory.text}  (${category}, ${source}${confidence})`, "info");
  }
}

function notifyPending(
  ui: CtxUi,
  pending: ReturnType<typeof memoryService.listPendingCandidates>,
): void {
  if (pending.length === 0) return;
  ui.notify("─── Pending candidates ───", "info");
  for (let index = 0; index < pending.length; index += 1) {
    const candidate = pending[index]!;
    ui.notify(
      `[p${index + 1}] ${candidate.text}  (score ${candidate.score}, seen ${candidate.count}×, ${Math.round(candidate.strongestConfidence * 100)}%)`,
      "info",
    );
  }
}
