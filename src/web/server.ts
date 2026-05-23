import type { Client } from "@libsql/client";
import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(WEB_DIR, "index.html");

const PING_INTERVAL_MS = 4_000;
const STALE_TIMEOUT_MS = 12_000;
const SHUTDOWN_DELAY_MS = 1_500;

export type MemoryExplorerOptions = {
  dev?: boolean;
  openBrowser?: boolean;
};

export function startMemoryExplorer(
  db: Client,
  port = 3000,
  options: MemoryExplorerOptions = {},
): ReturnType<typeof Bun.serve> {
  const dev = options.dev ?? false;
  const openBrowser = options.openBrowser ?? !dev;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let html = readFileSync(HTML_PATH, "utf8");
  const sockets = new Set<ServerWebSocket<unknown>>();
  const lastSeen = new Map<ServerWebSocket<unknown>, number>();

  function scheduleShutdownIfIdle(): void {
    if (dev) return;
    if (sockets.size > 0) {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      return;
    }
    if (shutdownTimer) return;
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (sockets.size > 0) return;
      console.log("All tabs closed. Shutting down.");
      server.stop();
      process.exit(0);
    }, SHUTDOWN_DELAY_MS);
  }

  function touch(ws: ServerWebSocket<unknown>): void {
    lastSeen.set(ws, Date.now());
  }

  function pruneStaleSockets(): void {
    const now = Date.now();
    for (const ws of sockets) {
      if (now - (lastSeen.get(ws) ?? 0) > STALE_TIMEOUT_MS) {
        ws.close(1000, "stale");
      }
    }
  }

  function broadcastReload(): void {
    const payload = JSON.stringify({ type: "reload" });
    for (const ws of sockets) {
      ws.send(payload);
    }
  }

  function invalidateAndReload(): void {
    html = readFileSync(HTML_PATH, "utf8");
    console.log("[dev] UI updated — reloading browser");
    broadcastReload();
  }

  if (dev) {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    watch(WEB_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || filename === "server.ts" || filename === "dev.ts")
        return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        invalidateAndReload();
      }, 100);
    });
  }

  const server = Bun.serve({
    port,
    routes: {
      "/": () =>
        new Response(html, {
          headers: {
            "Content-Type": "text/html",
            ...(dev ? { "Cache-Control": "no-store" } : {}),
          },
        }),
      "/api/memories": async () => {
        try {
          const result = await db.execute(`
            SELECT id, text, category, categories, user_id, assistant_id, session_id,
                   metadata, created_at, retrieval_count, last_retrieved
            FROM memories
            ORDER BY created_at DESC
          `);
          const memories = result.rows.map(rowToMemory);
          return Response.json(memories);
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      },
    },
    websocket: {
      open(ws) {
        touch(ws);
        sockets.add(ws);
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
      },
      close(ws) {
        sockets.delete(ws);
        lastSeen.delete(ws);
        scheduleShutdownIfIdle();
      },
      message(ws, raw) {
        touch(ws);
        try {
          const msg = JSON.parse(String(raw)) as { type?: string };
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          if (msg.type === "bye") {
            ws.close(1000, "client bye");
          }
        } catch {
          /* ignore malformed messages */
        }
      },
    },
  });

  if (!dev) {
    setInterval(() => {
      pruneStaleSockets();
      scheduleShutdownIfIdle();
    }, PING_INTERVAL_MS);
  }

  const url = `http://localhost:${port}`;
  console.log(`Memory Explorer: ${url}${dev ? " (dev — hot reload on)" : ""}`);

  if (openBrowser) {
    setTimeout(() => {
      const cmd =
        platform === "darwin"
          ? "open"
          : platform === "win32"
            ? "start"
            : "xdg-open";
      spawn(cmd, [url], { stdio: "ignore", detached: true });
    }, 100);
  }

  return server;
}

function rowToMemory(row: any): any {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    categories: asStringArray(safeJsonArray(row.categories)),
    scope: {
      userId: row.user_id,
      assistantId: row.assistant_id,
      sessionId: row.session_id,
    },
    metadata: safeJsonObject(row.metadata),
    createdAt: row.created_at,
    retrievalCount: row.retrieval_count ?? 0,
    lastRetrieved: row.last_retrieved ?? null,
  };
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeJsonArray(value: unknown): unknown {
  if (typeof value !== "string") return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}
