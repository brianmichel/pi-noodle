import { mem0Request } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { DEFAULT_AGENT_ID } from "./constants.ts";
import { enqueueWriteTask, flushPendingWrites } from "./queue.ts";
import type { JsonObject, MemoryMessage, NotificationTarget, SessionEntryLike, SessionManagerLike } from "./types.ts";
import { extractTextContent } from "./utils.ts";

export { flushPendingWrites };

export function ensureMessages(memory?: string, messages?: MemoryMessage[]): MemoryMessage[] {
  if (messages && messages.length > 0) return messages;
  if (memory && memory.trim()) {
    return [{ role: "user", content: memory.trim() }];
  }
  throw new Error("Provide either memory or messages.");
}

export function resolveAgentId(agentId?: string): string {
  const trimmed = agentId?.trim();
  return trimmed || DEFAULT_AGENT_ID;
}

export function collectSessionMessages(sessionManager: SessionManagerLike): MemoryMessage[] {
  const branch = sessionManager.getBranch();
  const messages: MemoryMessage[] = [];

  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const typedEntry = entry as SessionEntryLike;

    if (typedEntry.type !== "message") continue;
    const role = typedEntry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = extractTextContent(typedEntry.message?.content);
    if (!content) continue;
    messages.push({ role, content });
  }

  return messages;
}

export function buildSessionSignature(sessionManager: SessionManagerLike): string {
  const sessionFile = sessionManager.getSessionFile?.() || "ephemeral";
  const leafId = sessionManager.getLeafId?.() || "no-leaf";
  return `${sessionFile}::${leafId}`;
}

export function selectMemoryWorthMessages(messages: MemoryMessage[]): MemoryMessage[] {
  const filtered = messages.filter((message) => message.content.trim().length >= 20);
  return filtered.slice(-20);
}

export async function saveSessionMemories(
  sessionManager: SessionManagerLike,
  reason: string,
  savedSignatures: Set<string>,
  options?: {
    target?: NotificationTarget;
    successMessage?: string;
  },
): Promise<boolean> {
  const signature = buildSessionSignature(sessionManager);
  if (savedSignatures.has(signature)) return false;

  const messages = selectMemoryWorthMessages(collectSessionMessages(sessionManager));
  if (messages.length < 2) return false;

  const payload: JsonObject = {
    messages,
    agent_id: DEFAULT_AGENT_ID,
    metadata: {
      source: "pi-session-wrapup",
      reason,
      session_file: sessionManager.getSessionFile?.() || null,
    },
  };

  savedSignatures.add(signature);

  enqueueWriteTask({
    label: "Mem0 session auto-save",
    ...(options?.target ? { target: options.target } : {}),
    ...(options?.successMessage ? { successMessage: options.successMessage } : {}),
    onFailure: () => {
      savedSignatures.delete(signature);
    },
    task: async () => {
      const config = await resolveConfig();
      const requestPayload: JsonObject = { ...payload };
      if (config.userId) requestPayload.user_id = config.userId;
      await mem0Request("POST", "/memories", requestPayload);
    },
  });

  return true;
}
