import { resolveConfig, resolveConfigPath } from "../config.ts";
import { maskSecret } from "../utils.ts";
import type { CtxUi } from "./ui.ts";

export function runStatus(ui: CtxUi): void {
  const config = resolveConfig();
  ui.notify("─── Noodle Memory ───", "info");
  ui.notify("Commands: /noodle remember | /noodle forget | /noodle edit | /noodle review | /noodle settings | /noodle web", "info");
  ui.notify(`Config: ${resolveConfigPath()}`, "info");
  ui.notify(`Database: ${config.db.mode}  ${config.db.mode === "cloud" ? (config.db.url ?? "") : config.db.path}`, "info");
  if (config.db.mode === "cloud" && config.db.authToken) {
    ui.notify(`Auth token: ${maskSecret(config.db.authToken)}`, "info");
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
