import {
  isExplorerRunning,
  openExplorerBrowser,
  readExplorerState,
  spawnExplorer,
  stopExplorer,
} from "../web/manager.ts";
import type { CtxUi } from "./ui.ts";

export async function runWeb(ui: CtxUi, subcommand: string): Promise<void> {
  if (subcommand.match(/web\s+stop\b/)) {
    ui.notify(stopExplorer() ? "Memory Explorer stopped." : "Memory Explorer is not running.", "info");
    return;
  }

  const dev = /\bdev\b/.test(subcommand);
  const portMatch = subcommand.match(/\b(\d{2,5})\b/);
  const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : 3000;

  if (isExplorerRunning()) {
    const running = readExplorerState();
    const activePort = running?.port ?? port;
    openExplorerBrowser(activePort);
    ui.notify(`Memory Explorer already running at http://localhost:${activePort}`, "info");
    return;
  }

  const spawned = spawnExplorer(port, dev);
  if (!spawned) {
    ui.notify("Failed to start Memory Explorer.", "error");
    return;
  }

  ui.notify(
    dev
      ? `Memory Explorer (dev) starting at http://localhost:${port} — use /noodle web stop when done`
      : `Memory Explorer started at http://localhost:${port} — closes automatically when all tabs are closed`,
    "info",
  );
}
