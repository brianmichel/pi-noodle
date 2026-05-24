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

function looksLikeToolOrCodeChatter(content: string): boolean {
  return /```|^\$ |\bstderr\b|\bstdout\b|traceback|exception|stack trace|npm ERR!/im.test(content);
}

export function selectMemoryWorthMessages(messages: MemoryMessage[]): MemoryMessage[] {
  const filtered = messages.filter((message) => {
    const trimmed = message.content.trim();
    return trimmed.length >= 20 && !looksLikeToolOrCodeChatter(trimmed);
  });
  return filtered.slice(-20);
}

export function selectExtractorMessages(messages: MemoryMessage[]): MemoryMessage[] {
  const filtered = messages.filter((message) => {
    const trimmed = message.content.trim();
    if (trimmed.length < 24 || looksLikeToolOrCodeChatter(trimmed)) return false;
    if (message.role === "user") return true;
    return /\b(prefer|usually|always|never|avoid|default|remember|name is|we(?:'|’)re|we are|our stack|standardi[sz]e)\b/i.test(trimmed);
  });

  const preferred = filtered.slice(-12);
  const userCount = preferred.filter((message) => message.role === "user").length;
  if (preferred.length >= 4 && userCount >= 2) return preferred;
  return messages.slice(-8).filter((message) => message.content.trim().length >= 24);
}
