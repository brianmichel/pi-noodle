import type { Client } from "@libsql/client";
import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(WEB_DIR, "index.html");

export type MemoryExplorerOptions = {
  dev?: boolean;
  openBrowser?: boolean;
};

export function startMemoryExplorer(
  db: Client,
  port = 3000,
  options: MemoryExplorerOptions = {},
): void {
  const dev = options.dev ?? false;
  const openBrowser = options.openBrowser ?? !dev;
  let connections = 0;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let html = readFileSync(HTML_PATH, "utf8");
  const sockets = new Set<ServerWebSocket<unknown>>();

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
      if (!filename || filename === "server.ts" || filename === "dev.ts") return;
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
                   metadata, created_at, retrieval_count
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
        sockets.add(ws);
        connections++;
        if (shutdownTimer) {
          clearTimeout(shutdownTimer);
          shutdownTimer = null;
        }
      },
      close(ws) {
        sockets.delete(ws);
        connections--;
        if (!dev && connections === 0) {
          shutdownTimer = setTimeout(() => {
            console.log("All tabs closed. Shutting down.");
            server.stop();
            process.exit(0);
          }, 5000);
        }
      },
      message() {},
    },
  });

  const url = `http://localhost:${port}`;
  console.log(`Memory Explorer: ${url}${dev ? " (dev — hot reload on)" : ""}`);

  if (openBrowser) {
    setTimeout(() => {
      const cmd =
        platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
      spawn(cmd, [url], { stdio: "ignore", detached: true });
    }, 100);
  }
}

function rowToMemory(row: any): any {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    categories: asStringArray(safeJsonParse(row.categories)),
    scope: {
      userId: row.user_id,
      assistantId: row.assistant_id,
      sessionId: row.session_id,
    },
    metadata: safeJsonParse(row.metadata),
    createdAt: row.created_at,
    retrievalCount: row.retrieval_count,
  };
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== "string") return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
