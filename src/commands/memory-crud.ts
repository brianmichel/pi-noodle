import { memoryService } from "../memory/runtime.ts";
import type { MemoryRecord } from "../memory/types.ts";
import { describeError } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

export async function runRemember(ui: CtxUi, initialText: string): Promise<void> {
  try {
    const text = (initialText || await ui.input("Memory to save", "") || "").trim();
    if (!text) {
      ui.notify("Nothing saved — memory text is required.", "info");
      return;
    }

    await memoryService.add({
      text,
      metadata: {
        source: "manual_command",
        auto_saved: false,
      },
    });
    ui.notify(`Saved memory: ${summarizeMemory(text)}`, "info");
  } catch (error) {
    ui.notify(`Remember failed: ${describeError(error)}`, "error");
  }
}

export async function runForget(ui: CtxUi, queryText: string): Promise<void> {
  try {
    const query = (queryText || await ui.input("Find memory to forget", "") || "").trim();
    if (!query) {
      ui.notify("Forget cancelled — enter a memory query.", "info");
      return;
    }

    const target = await pickMemoryForAction(ui, query, "delete");
    if (!target?.id) return;

    const ok = await ui.confirm("Delete this memory?", target.text);
    if (!ok) {
      ui.notify("Forget cancelled.", "info");
      return;
    }

    await memoryService.delete(target.id);
    ui.notify(`Deleted memory: ${summarizeMemory(target.text)}`, "info");
  } catch (error) {
    ui.notify(`Forget failed: ${describeError(error)}`, "error");
  }
}

export async function runEdit(ui: CtxUi, queryText: string): Promise<void> {
  try {
    const query = (queryText || await ui.input("Find memory to edit", "") || "").trim();
    if (!query) {
      ui.notify("Edit cancelled — enter a memory query.", "info");
      return;
    }

    const target = await pickMemoryForAction(ui, query, "edit");
    if (!target?.id) return;

    const replacement = (await ui.input("Replacement text", target.text) || "").trim();
    if (!replacement) {
      ui.notify("Edit cancelled — replacement text is required.", "info");
      return;
    }
    if (replacement === target.text) {
      ui.notify("No changes made.", "info");
      return;
    }

    await memoryService.update(target.id, {
      text: replacement,
      metadata: {
        ...target.metadata,
        source: "manual_edit",
        updated_from: target.text,
      },
    });
    ui.notify(`Updated memory: ${summarizeMemory(replacement)}`, "info");
  } catch (error) {
    ui.notify(`Edit failed: ${describeError(error)}`, "error");
  }
}

async function pickMemoryForAction(
  ui: CtxUi,
  query: string,
  action: "edit" | "delete",
): Promise<MemoryRecord | null> {
  const matches = await findMemoryMatches(query);
  if (matches.length === 0) {
    ui.notify(`No memories matched: ${query}`, "info");
    return null;
  }
  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  ui.notify(`Top matches for ${action}:`, "info");
  for (let index = 0; index < matches.length; index += 1) {
    ui.notify(`[${index + 1}] ${summarizeMemory(matches[index]!.text)}`, "info");
  }

  const raw = (await ui.input(`Choose memory to ${action} (1-${matches.length})`, "1") || "").trim();
  const index = parseInt(raw, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= matches.length) {
    ui.notify(`Invalid selection — cancelled ${action}.`, "info");
    return null;
  }

  return matches[index] ?? null;
}

async function findMemoryMatches(query: string): Promise<MemoryRecord[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const semantic = await memoryService.search({ query, limit: 8 }).catch(() => []);
  const listed = await memoryService.list();
  const substring = listed.filter((memory) => memory.text.toLowerCase().includes(normalized));

  const deduped = new Map<string, MemoryRecord>();
  for (const memory of [...semantic, ...substring]) {
    const key = memory.id ?? memory.text;
    if (!deduped.has(key)) deduped.set(key, memory);
  }

  return Array.from(deduped.values()).slice(0, 8);
}

function summarizeMemory(text: string, max = 80): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, Math.max(0, max - 1))}…`;
}
