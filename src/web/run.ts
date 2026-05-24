import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { memoryService } from "../memory/runtime.ts";
import {
  clearExplorerState,
  explorerStatePath,
  type ExplorerState,
} from "./manager.ts";
import { startMemoryExplorer } from "./server.ts";

const port = parseInt(process.argv[2] ?? "3000", 10);
const dev = process.argv.includes("--dev");

mkdirSync(dirname(explorerStatePath()), { recursive: true });
const state: ExplorerState = { pid: process.pid, port, dev };
writeFileSync(explorerStatePath(), JSON.stringify(state));

function cleanup(): void {
  clearExplorerState();
}

const server = startMemoryExplorer(memoryService, port, { dev, openBrowser: true });

function shutdown(): void {
  cleanup();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", cleanup);
