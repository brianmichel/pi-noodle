import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";
import type { MemoryRecord } from "../memory/types.ts";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(WEB_DIR, "index.html");

const PING_INTERVAL_MS = 4_000;
const STALE_TIMEOUT_MS = 12_000;
const SHUTDOWN_DELAY_MS = 1_500;

export type MemoryExplorerOptions = {
  dev?: boolean;
  openBrowser?: boolean;
  token: string;
};

export function startMemoryExplorer(
  service: {
    list: () => Promise<MemoryRecord[]>;
    update: (id: string, input: { text?: string; metadata?: Record<string, unknown> }) => Promise<void>;
    delete: (id: string) => Promise<void>;
  },
  port = 3000,
  options: MemoryExplorerOptions,
): ReturnType<typeof Bun.serve> {
  const dev = options.dev ?? false;
  const openBrowser = options.openBrowser ?? !dev;
  const token = options.token;
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

  function isAuthorized(url: URL): boolean {
    return url.searchParams.get("token") === token;
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: async (req, server) => {
      const url = new URL(req.url);
      if (!isAuthorized(url)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (server.upgrade(req)) return;

      if (url.pathname === "/") {
        return new Response(html, {
          headers: {
            "Content-Type": "text/html",
            ...(dev ? { "Cache-Control": "no-store" } : {}),
          },
        });
      }

      if (url.pathname === "/api/memories" && req.method === "GET") {
        try {
          const memories = (await service.list()).map(memoryToApi);
          return Response.json(memories);
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      }

      const match = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
      if (match && req.method === "PATCH") {
        try {
          const body = await req.json().catch(() => ({}));
          const text = typeof body?.text === "string" ? body.text.trim() : undefined;
          if (!text) return Response.json({ error: "text is required" }, { status: 400 });
          await service.update(decodeURIComponent(match[1] ?? ""), { text });
          return Response.json({ updated: true });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      }

      if (match && req.method === "DELETE") {
        try {
          await service.delete(decodeURIComponent(match[1] ?? ""));
          return Response.json({ deleted: true });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
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

  const url = `http://127.0.0.1:${port}`;
  console.log(`Memory Explorer: ${url}${dev ? " (dev — hot reload on)" : ""}`);

  if (openBrowser) {
    setTimeout(() => {
      const cmd =
        platform === "darwin"
          ? "open"
          : platform === "win32"
            ? "start"
            : "xdg-open";
      spawn(cmd, [`${url}/?token=${encodeURIComponent(token)}`], { stdio: "ignore", detached: true });
    }, 100);
  }

  return server;
}

function memoryToApi(memory: MemoryRecord): Record<string, unknown> {
  return {
    id: memory.id,
    text: memory.text,
    category: memory.category,
    categories: memory.categories,
    scope: memory.scope ?? {},
    metadata: memory.metadata,
    createdAt: memory.createdAt ?? null,
    retrievalCount: memory.retrievalCount ?? 0,
    lastRetrieved: memory.lastRetrieved ?? null,
  };
}
