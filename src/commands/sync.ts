import { syncManager } from "../memory/runtime.ts";
import { flushPendingWrites } from "../queue.ts";
import { describeError } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

/** `/noodle sync` — flush pending writes, then push + pull with Turso Cloud. */
export async function runSync(ui: CtxUi): Promise<void> {
  if (!syncManager.isSyncMode) {
    ui.notify("Sync is only available in sync db mode. Run /noodle settings and choose Sync.", "error");
    return;
  }

  ui.notify("Flushing pending writes…", "info");
  try {
    await flushPendingWrites();
  } catch (error) {
    ui.notify(`Flush failed: ${describeError(error)}`, "error");
    return;
  }

  ui.notify("Syncing with Turso Cloud…", "info");
  const result = await syncManager.syncNow();
  if (result.ok) {
    ui.notify("Sync complete.", "info");
  } else if (result.skipped) {
    ui.notify(`Sync skipped: ${result.error}`, "info");
  } else {
    ui.notify(`Sync failed: ${result.error}`, "error");
  }
}