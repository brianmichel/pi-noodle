import { DEFAULT_AGENT_ID } from "./constants.ts";
import type { MemoryMessage } from "./memory/types.ts";
import { flushPendingWrites } from "./queue.ts";
import type { SessionEntryLike, SessionManagerLike } from "./types.ts";
import { extractTextContent } from "./utils.ts";

export { flushPendingWrites };

export function ensureMessages(text?: string, messages?: MemoryMessage[]): MemoryMessage[] {
  if (messages && messages.length > 0) return messages;
  if (text && text.trim()) {
    return [{ role: "user", content: text.trim() }];
  }
  throw new Error("Provide either text or messages.");
}

export function resolveAssistantId(assistantId?: string): string {
  const trimmed = assistantId?.trim();
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
