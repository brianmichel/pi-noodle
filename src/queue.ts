import { notify } from "./notifications.ts";
import type { NotificationTarget } from "./types.ts";
import { describeError } from "./utils.ts";

let nextWriteJobId = 1;
let pendingWriteQueue: Promise<void> = Promise.resolve();

export function enqueueWriteTask(options: {
  label: string;
  task: () => Promise<void>;
  target?: NotificationTarget;
  successMessage?: string;
  onSuccess?: () => void;
  onFailure?: () => void;
}): number {
  const jobId = nextWriteJobId++;

  const run = async () => {
    try {
      await options.task();
      if (options.successMessage) {
        notify(options.target, options.successMessage, "info");
      }
      options.onSuccess?.();
    } catch (error) {
      options.onFailure?.();
      const message = `${options.label} failed: ${describeError(error)}`;
      if (options.target) {
        notify(options.target, message, "error");
      } else {
        console.error(message);
      }
    }
  };

  pendingWriteQueue = pendingWriteQueue.catch(() => undefined).then(run);
  return jobId;
}

export async function flushPendingWrites(): Promise<void> {
  await pendingWriteQueue.catch(() => undefined);
}
