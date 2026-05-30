import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type DebugRunStatus = "queued" | "running" | "success" | "error" | "skipped";

type DebugRunSummary = {
  startedAt: number;
  finishedAt?: number;
  status: DebugRunStatus;
  reason: string;
  model?: string;
  candidateTexts: string[];
  savedCount: number;
  error?: string;
};

type DebugState = {
  enabled: boolean;
  mode: string;
  triggerEvery: number;
  sessionTurnCount: number;
  turnsUntilNextRun: number;
  isRunning: boolean;
  lastRun?: DebugRunSummary;
};

const state: DebugState = {
  enabled: false,
  mode: "off",
  triggerEvery: 10,
  sessionTurnCount: 0,
  turnsUntilNextRun: 10,
  isRunning: false,
};

const sessions = new Set<ExtensionContext>();
const WIDGET_KEY = "noodle-extractor-debug-widget";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MIN_RUNNING_MS = 900;

let spinnerIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

function emit(): void {
  for (const ctx of sessions) {
    ctx.ui.setWidget(WIDGET_KEY, renderWidget(ctx));
  }
}

function formatAge(timestamp?: number): string {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function startSpinner(): void {
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    emit();
  }, 90);
}

function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
}

function renderStateLabel(ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  if (state.isRunning) {
    return `${theme.fg("accent", SPINNER_FRAMES[spinnerIndex] ?? "⠋")} ${theme.fg("accent", "running")}`;
  }
  switch (state.lastRun?.status) {
    case "queued":
      return `${theme.fg("warning", "…")} ${theme.fg("warning", "queued")}`;
    case "error":
      return theme.fg("error", "error");
    case "skipped":
      return theme.fg("warning", "skipped");
    case "success":
      return theme.fg("success", "ready");
    default:
      return theme.fg("dim", "idle");
  }
}

function summarizeReason(reason: string): string {
  if (reason.startsWith("shutdown:")) return `shutdown (${reason.slice("shutdown:".length)})`;
  return reason === "scheduled" ? "scheduled cadence" : reason;
}

function renderWidget(ctx: ExtensionContext): string[] | undefined {
  if (!state.enabled) return undefined;

  const theme = ctx.ui.theme;
  const title = theme.bold?.("Noodle extractor") ?? "Noodle extractor";
  const nextRun = state.turnsUntilNextRun === 0
    ? "this turn"
    : `in ${state.turnsUntilNextRun} turn${state.turnsUntilNextRun === 1 ? "" : "s"}`;

  const lines = [
    title,
    theme.fg("dim", `mode ${state.mode} • every ${state.triggerEvery} turns • next ${nextRun}`),
    renderStateLabel(ctx),
  ];

  if (!state.lastRun) return lines;

  lines.push(theme.fg("dim", `last run ${formatAge(state.lastRun.finishedAt ?? state.lastRun.startedAt)} ago • ${summarizeReason(state.lastRun.reason)}`));
  if (state.lastRun.model) lines.push(theme.fg("dim", `model ${state.lastRun.model}`));

  if (state.lastRun.status === "success") {
    lines.push(theme.fg("dim", `pulled ${state.lastRun.candidateTexts.length} candidate${state.lastRun.candidateTexts.length === 1 ? "" : "s"} • saved ${state.lastRun.savedCount}`));
    if (state.lastRun.candidateTexts.length > 0) {
      lines.push(...state.lastRun.candidateTexts.slice(0, 2).map((text) => theme.fg("dim", `• ${text}`)));
    } else {
      lines.push(theme.fg("dim", "• nothing durable found"));
    }
  } else if (state.lastRun.status === "skipped") {
    lines.push(theme.fg("dim", `• ${state.lastRun.reason}`));
  } else if (state.lastRun.status === "error" && state.lastRun.error) {
    lines.push(theme.fg("dim", `• ${state.lastRun.error}`));
  }

  return lines;
}

function finalizeRun(
  status: Extract<DebugRunStatus, "success" | "error">,
  options: { candidateTexts?: string[]; savedCount?: number; error?: string },
): void {
  const apply = () => {
    state.isRunning = false;
    stopSpinner();
    state.lastRun = {
      startedAt: state.lastRun?.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      status,
      reason: state.lastRun?.reason ?? "scheduled",
      ...(state.lastRun?.model ? { model: state.lastRun.model } : {}),
      candidateTexts: options.candidateTexts?.slice(0, 3) ?? state.lastRun?.candidateTexts ?? [],
      savedCount: options.savedCount ?? state.lastRun?.savedCount ?? 0,
      ...(options.error ? { error: options.error } : {}),
    };
    emit();
  };

  const startedAt = state.lastRun?.startedAt ?? Date.now();
  const remaining = Math.max(0, MIN_RUNNING_MS - (Date.now() - startedAt));
  if (remaining > 0) {
    setTimeout(apply, remaining);
  } else {
    apply();
  }
}

export function configureExtractorDebug(enabled: boolean, mode: string, triggerEvery: number): void {
  state.enabled = enabled && mode !== "off";
  state.mode = mode;
  state.triggerEvery = Math.max(1, triggerEvery);
  state.turnsUntilNextRun = state.enabled
    ? state.triggerEvery - (state.sessionTurnCount % state.triggerEvery || 0)
    : 0;
  emit();
}

export function noteUserTurnForExtractorDebug(): void {
  state.sessionTurnCount += 1;
  if (!state.enabled) {
    emit();
    return;
  }

  const remainder = state.sessionTurnCount % state.triggerEvery;
  state.turnsUntilNextRun = remainder === 0 ? 0 : state.triggerEvery - remainder;
  emit();
}

export function noteExtractorSkipped(reason: string): void {
  state.isRunning = false;
  state.lastRun = {
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: "skipped",
    reason,
    candidateTexts: [],
    savedCount: 0,
  };
  emit();
}

export function noteExtractorQueued(reason: string, model?: string): void {
  state.isRunning = false;
  state.lastRun = {
    startedAt: Date.now(),
    status: "queued",
    reason,
    ...(model ? { model } : {}),
    candidateTexts: [],
    savedCount: 0,
  };
  emit();
}

export function noteExtractorRunStarted(): void {
  state.isRunning = true;
  startSpinner();
  if (state.lastRun) {
    state.lastRun.status = "running";
    state.lastRun.startedAt = Date.now();
  }
  emit();
}

export function noteExtractorRunFinished(candidateTexts: string[], savedCount: number): void {
  finalizeRun("success", { candidateTexts, savedCount });
}

export function noteExtractorRunFailed(error: string): void {
  finalizeRun("error", { error });
}

export function maybeStartExtractorDebugOverlay(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  sessions.add(ctx);
  ctx.ui.setWidget(WIDGET_KEY, renderWidget(ctx));
}
