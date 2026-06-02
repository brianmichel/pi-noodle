import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";

const RUN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run.ts");
const STATE_PATH = join(homedir(), ".pi", "noodle", "explorer.json");

export type ExplorerState = {
  pid: number;
  port: number;
  token: string;
  dev?: boolean;
};

export function explorerStatePath(): string {
  return STATE_PATH;
}

export function readExplorerState(): ExplorerState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ExplorerState;
  } catch {
    return null;
  }
}

export function clearExplorerState(): void {
  try {
    unlinkSync(STATE_PATH);
  } catch {
    /* already gone */
  }
}

export function isExplorerRunning(): boolean {
  const state = readExplorerState();
  if (!state) return false;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    clearExplorerState();
    return false;
  }
}

export function buildExplorerUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

export function openExplorerBrowser(port: number, token: string): void {
  const url = buildExplorerUrl(port, token);
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

export function spawnExplorer(port: number, dev = false): ExplorerState | null {
  if (isExplorerRunning()) {
    return readExplorerState();
  }

  const token = crypto.randomUUID();
  const args = [RUN_SCRIPT, String(port), `--token=${token}`];
  if (dev) args.push("--dev");

  const child = spawn("bun", args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });

  if (!child.pid) return null;
  child.unref();
  return { pid: child.pid, port, token, dev };
}

export function stopExplorer(): boolean {
  const state = readExplorerState();
  if (!state) return false;

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* process may already be gone */
  }

  clearExplorerState();
  return true;
}
