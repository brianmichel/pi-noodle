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
const tokenArg = process.argv.find((arg) => arg.startsWith("--token="));
const token = tokenArg?.slice("--token=".length) || crypto.randomUUID();

mkdirSync(dirname(explorerStatePath()), { recursive: true, mode: 0o700 });
const state: ExplorerState = { pid: process.pid, port, token, dev };
writeFileSync(explorerStatePath(), JSON.stringify(state), { mode: 0o600 });

function cleanup(): void {
  clearExplorerState();
}

const server = startMemoryExplorer(memoryService, port, { dev, openBrowser: true, token });

function shutdown(): void {
  cleanup();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", cleanup);
