import type { NotificationTarget } from "./types.ts";

export function notify(target: NotificationTarget | undefined, message: string, level: "info" | "error"): void {
  if (!target) return;

  try {
    target.ui.notify(message, level);
  } catch {
    // ignore notify failures
  }
}
