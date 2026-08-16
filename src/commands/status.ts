import { resolveConfig, resolveConfigPath } from "../config.ts";
import { syncManager } from "../memory/runtime.ts";
import { maskSecret } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

export function runStatus(ui: CtxUi): void {
  const config = resolveConfig();
  ui.notify("─── Noodle Memory ───", "info");
  ui.notify("Commands: /noodle remember | /noodle forget | /noodle edit | /noodle review | /noodle sync | /noodle settings | /noodle web", "info");
  ui.notify(`Config: ${resolveConfigPath()}`, "info");
  const dbLocation = config.db.mode === "local" ? config.db.path : (config.db.url ?? "");
  ui.notify(`Database: ${config.db.mode}  ${dbLocation}`, "info");
  if ((config.db.mode === "cloud" || config.db.mode === "sync") && config.db.authToken) {
    ui.notify(`Auth token: ${maskSecret(config.db.authToken)}`, "info");
  }
  if (config.db.mode === "sync") {
    const interval = config.db.syncIntervalSeconds ?? 300;
    const last = syncManager.lastSyncUnixMs
      ? `last sync: ${new Date(syncManager.lastSyncUnixMs).toISOString()}`
      : "(not yet synced)";
    ui.notify(`Sync interval: ${interval}s  ${interval === 0 ? "(manual — use /noodle sync)" : ""}  ${last}`, "info");
    if (syncManager.lastErrorMessage) {
      ui.notify(`Sync error: ${syncManager.lastErrorMessage}`, "info");
    }
  }
  ui.notify(
    `Embedding: ${config.embedding.provider}  ${config.embedding.model}${config.embedding.dimensions ? `  ${config.embedding.dimensions}d` : ""}`,
    "info",
  );
  ui.notify(`Endpoint: ${config.embedding.baseUrl}`, "info");
  ui.notify(`API key: ${maskSecret(config.embedding.apiKey)}`, "info");

  const extractor = config.extractor;
  if ((extractor?.mode ?? "off") !== "off") {
    const modelLabel = extractor?.model ?? "(none — extraction disabled)";
    ui.notify(
      `Memory mode: ${extractor?.mode ?? "balanced"}  ${modelLabel}  every ${extractor?.triggerEvery ?? 10} turns  debug ${extractor?.debug ? "on" : "off"}`,
      "info",
    );
    return;
  }

  ui.notify("Memory mode: off", "info");
}
