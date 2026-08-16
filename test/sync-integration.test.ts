import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { connectTurso, type SyncCapable } from "../src/memory/turso-client.ts";
import { SyncManager } from "../src/memory/sync-manager.ts";
import { TursoBackend } from "../src/memory/turso-backend.ts";
import type { Embedder } from "../src/memory/embedder.ts";
import type { NoodleConfig } from "../src/types.ts";

// Real integration test against the `tursodb` local sync server.
// Skipped automatically when the `tursodb` binary is not installed, so it runs
// where the CLI is present but does not break bare CI.

const BIN = path.join(homedir(), ".turso", "tursodb");
const haveBinary = existsSync(BIN);

// Deterministic, hardcoded embeddings (no external API) — same scheme as the
// other test fakes so cross-client vector search is reproducible.
const DIM = 8;
const fakeEmbedder: Embedder = {
  dimensions: DIM,
  embed: async (text: string): Promise<Float32Array> => {
    const vec = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) {
      vec[i] = (text.charCodeAt(i % text.length) / 255) * 2 - 1;
    }
    return vec;
  },
};

const BACKEND_OPTS = { provider: "custom", model: "fake", baseUrl: "test" };

function syncConfig(localPath: string, url: string): NoodleConfig {
  return {
    db: { mode: "sync", path: localPath, url },
    embedding: { provider: "custom", apiKey: "", baseUrl: "test", model: "fake" },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = connect({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`server not up on :${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

type Server = { url: string; stop: () => void };

async function startServer(tmpDir: string): Promise<Server> {
  const port = await freePort();
  const serverFile = path.join(tmpDir, "server.db");
  const proc = spawn(BIN, [serverFile, "--sync-server", `127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForPort(port);
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    },
  };
}

const suite = haveBinary ? describe : describe.skip;

suite("sync integration (local sync server)", () => {
  let tmpDir: string;
  let server: Server;

  before(async () => {
    tmpDir = mkdtempSync(path.join("/tmp", "noodle-sync-"));
    server = await startServer(tmpDir);
  });

  after(() => {
    server?.stop();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
  });

  it("replicates memories A→server→B and vector search works after pull", async () => {
    // Client A: add two memories, then push via SyncManager.
    const a = await connectTurso(syncConfig(path.join(tmpDir, "a.db"), server.url), fakeEmbedder, BACKEND_OPTS);
    const backendA = a.backend as TursoBackend;
    assert.ok(a.syncDb, "sync mode must expose a sync-capable db");

    await backendA.add({ text: "User prefers Rust over C++ for systems work", category: "coding_pref", categories: ["coding_pref"], metadata: { source: "test" }, scope: { assistantId: "agent-1" } });
    await backendA.add({ text: "User prefers concise replies", category: "response_style", categories: ["response_style"], metadata: { source: "test" }, scope: { assistantId: "agent-1" } });

    const mgrA = new SyncManager({
      syncMode: true,
      ensureConnected: async () => {},
      getDb: () => a.syncDb as SyncCapable,
      flush: async () => {},
    });
    const pushResult = await mgrA.syncNow();
    assert.equal(pushResult.ok, true, "A push/pull should succeed");
    assert.ok(mgrA.lastSyncUnixMs > 0);

    // Client B: fresh local replica against the same server; pull, then search.
    const b = await connectTurso(syncConfig(path.join(tmpDir, "b.db"), server.url), fakeEmbedder, BACKEND_OPTS);
    const backendB = b.backend as TursoBackend;
    const mgrB = new SyncManager({
      syncMode: true,
      ensureConnected: async () => {},
      getDb: () => b.syncDb as SyncCapable,
      flush: async () => {},
    });
    const pullResult = await mgrB.syncNow();
    assert.equal(pullResult.ok, true, "B pull should succeed");

    const results = await backendB.search({ query: "User prefers Rust over C++ for systems work", limit: 5, scope: { assistantId: "agent-1" } });
    assert.ok(results.length >= 1, "B should find at least one memory after pulling A's data");
    assert.ok(results.some((r) => r.text.includes("Rust")), `top results should include the Rust memory; got: ${JSON.stringify(results.map((r) => r.text))}`);
    assert.ok(typeof results[0]?.score === "number");

    const list = await backendB.list({ scope: { assistantId: "agent-1" } });
    assert.equal(list.length, 2, "B should have both memories after pull");
  });

  it("is a no-op (no DB contact) when syncMode is false", async () => {
    // Local-mode config; SyncManager must not push/pull or require a server.
    const localCfg: NoodleConfig = {
      db: { mode: "local", path: path.join(tmpDir, "local.db") },
      embedding: { provider: "custom", apiKey: "", baseUrl: "test", model: "fake" },
    };
    const { backend } = await connectTurso(localCfg, fakeEmbedder, BACKEND_OPTS);
    await backend.add({ text: "local only memory", category: "project", categories: ["project"], metadata: {}, scope: { assistantId: "x" } });
    const mgr = new SyncManager({
      syncMode: false,
      ensureConnected: async () => { throw new Error("must not connect in non-sync mode"); },
      getDb: () => undefined,
    });
    const r = await mgr.syncNow();
    assert.equal(r.ok, false);
    assert.equal((r as { skipped?: boolean }).skipped, true);
  });
});