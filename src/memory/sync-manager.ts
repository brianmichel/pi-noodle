import { describeError } from "../utils.ts";

export interface SyncManagerOptions {
  /** True when config `db.mode === "sync"`. Drives whether start/syncNow do
   * anything at all — known at construction, independent of connect state. */
  syncMode: boolean;
  /** Triggers the (lazy) Turso connection. Called by {@link start} before the
   * interval begins, and by {@link syncNow} if not yet connected. */
  ensureConnected: () => Promise<void>;
  /** Returns the sync-capable DB once connected, or undefined beforehand. */
  getDb: () => { push(): Promise<void>; pull(): Promise<boolean> } | undefined;
  /** Push/pull interval in seconds. 0 or undefined = no background timer
   * (manual-only — use /noodle sync). */
  intervalSeconds?: number;
  /** Called before every sync to drain the sequential write queue. */
  flush?: () => Promise<void>;
}

/**
 * Drives background push/pull sync for `sync` db mode.
 *
 * Turso Sync has no built-in interval — we own the timer. {@link start} begins
 * the periodic loop; {@link syncNow} flushes writes then pushes + pulls (used
 * by `/noodle sync` and the session-shutdown hook); {@link stop} clears the
 * timer. All methods are no-ops when {@link SyncManagerOptions.syncMode} is
 * false, so local/cloud modes never open a database via the sync path.
 */
export class SyncManager {
  private readonly opts: SyncManagerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;
  private lastSyncAt = 0;
  private lastError: string | undefined;

  constructor(opts: SyncManagerOptions) {
    this.opts = opts;
  }

  get isSyncMode(): boolean {
    return this.opts.syncMode;
  }

  get intervalSeconds(): number | undefined {
    return this.opts.intervalSeconds;
  }

  get lastSyncUnixMs(): number {
    return this.lastSyncAt;
  }

  get lastErrorMessage(): string | undefined {
    return this.lastError;
  }

  /** Begin the background sync interval (sync mode only). Connects first so
   * {@link getDb} is populated, then starts the timer. No-op when interval is
   * 0/unset (manual-only). */
  start(): void {
    this.stop();
    if (!this.opts.syncMode) return;
    const interval = this.opts.intervalSeconds;
    if (!interval || interval <= 0) return;
    void this.opts.ensureConnected()
      .then(() => {
        const db = this.opts.getDb();
        if (!db) return;
        this.timer = setInterval(() => {
          void this.syncNow().catch(() => {
            // errors are recorded inside syncNow; swallow to avoid unhandled rejections
          });
        }, interval * 1000);
        if (typeof this.timer.unref === "function") {
          // Don't keep the process alive solely for sync.
          this.timer.unref();
        }
      })
      .catch(() => {
        // Connection failure is surfaced to the first backend call and to
        // /noodle status via lastError; don't let it reject unhandled here.
      });
  }

  /** Clear the background interval. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Flush pending writes, then push local changes to Turso Cloud and pull
   * remote changes back. No-op (skipped) when not in sync mode — does not open
   * a database. */
  async syncNow(): Promise<{ ok: true } | { ok: false; error: string; skipped?: boolean }> {
    if (!this.opts.syncMode) return { ok: false, error: "not in sync mode", skipped: true };
    if (this.syncing) return { ok: false, error: "sync already in progress", skipped: true };
    if (!this.opts.getDb()) {
      // Not connected yet — connect first.
      await this.opts.ensureConnected();
    }
    const db = this.opts.getDb();
    if (!db) return { ok: false, error: "sync database unavailable", skipped: true };
    this.syncing = true;
    try {
      await this.opts.flush?.();
      await db.push();
      await db.pull();
      this.lastSyncAt = Date.now();
      this.lastError = undefined;
      return { ok: true };
    } catch (error) {
      this.lastError = describeError(error);
      return { ok: false, error: this.lastError };
    } finally {
      this.syncing = false;
    }
  }
}