import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resolveConfigPath, writeConfig } from "../config.ts";
import { runEdit, runForget, runRemember } from "./memory-crud.ts";
import { runReview } from "./review.ts";
import { runSetup } from "./setup.ts";
import { runStatus } from "./status.ts";
import { runSync } from "./sync.ts";
import type { CtxUi } from "./ui.ts";
import { runWeb } from "./web.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("noodle", {
    description: "Noodle memory — status, remember/forget/edit, review, sync, and web explorer",
    handler: async (args, ctx) => {
      const sub = args.trim();
      const ui = ctx.ui as unknown as CtxUi;

      if (sub === "settings" || sub === "setup") {
        await runSetup(ui);
        return;
      }
      if (sub === "review") {
        await runReview(ui);
        return;
      }
      if (sub === "sync") {
        await runSync(ui);
        return;
      }
      if (sub.startsWith("remember")) {
        await runRemember(ui, sub.slice("remember".length).trim());
        return;
      }
      if (sub.startsWith("forget")) {
        await runForget(ui, sub.slice("forget".length).trim());
        return;
      }
      if (sub.startsWith("edit")) {
        await runEdit(ui, sub.slice("edit".length).trim());
        return;
      }
      if (sub === "init") {
        writeConfig({});
        ctx.ui.notify(`Created config at ${resolveConfigPath()}. Run /noodle settings to configure.`, "info");
        return;
      }
      if (sub.startsWith("web")) {
        await runWeb(ui, sub);
        return;
      }

      runStatus(ui);
    },
  });
}
