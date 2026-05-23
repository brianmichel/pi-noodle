import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveConfig } from "../config.ts";
import {
  clearExplorerState,
  explorerStatePath,
  type ExplorerState,
} from "./manager.ts";
import { startMemoryExplorer } from "./server.ts";

const port = parseInt(process.argv[2] ?? "3000", 10);
const dev = process.argv.includes("--dev");

const config = resolveConfig();
const dbUrl =
  config.db.mode === "cloud"
    ? (config.db.url ?? "libsql://")
    : `file:${config.db.path}`;
const dbOptions: { url: string; authToken?: string } = { url: dbUrl };
if (config.db.mode === "cloud" && config.db.authToken) {
  dbOptions.authToken = config.db.authToken;
}

mkdirSync(dirname(explorerStatePath()), { recursive: true });
const state: ExplorerState = { pid: process.pid, port, dev };
writeFileSync(explorerStatePath(), JSON.stringify(state));

function cleanup(): void {
  clearExplorerState();
}

const db = createClient(dbOptions);
const server = startMemoryExplorer(db, port, { dev, openBrowser: true });

function shutdown(): void {
  cleanup();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", cleanup);
