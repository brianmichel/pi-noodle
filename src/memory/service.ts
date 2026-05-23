import type { Api, Model } from "@earendil-works/pi-ai";

import { DEFAULT_AGENT_ID } from "../constants.ts";
import { enqueueWriteTask } from "../queue.ts";
import {
  buildSessionSignature,
  collectSessionMessages,
  ensureMessages,
  selectMemoryWorthMessages,
} from "../session.ts";
import type { JsonObject, NotificationTarget, SessionManagerLike } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import { extractMemoriesFromMessages } from "./extractor.ts";
import {
  buildSignalKey,
  categoriesForPrompt,
  prefilterUserMessage,
  shouldPromoteCandidate,
  shouldRetrieveMemories,
} from "./policy.ts";
import type {
  AddMemoryInput,
  LocalSignal,
  MemoryCategory,
  MemoryRecord,
  MemorySearchInput,
  MemoryScope,
  UpdateMemoryInput,
} from "./types.ts";

export class MemoryService {
  private readonly localSignals = new Map<string, LocalSignal>();
  private readonly recentlySaved = new Set<string>();
  private readonly backend: MemoryBackend;

  constructor(backend: MemoryBackend) {
    this.backend = backend;
  }

  async add(input: AddMemoryInput): Promise<void> {
    await this.backend.add({
      ...input,
      messages: ensureMessages(input.text, input.messages),
      scope: this.withDefaultScope(input.scope),
    });
  }

  async search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    return this.backend.search({
      ...input,
      scope: this.withDefaultScope(input.scope),
    });
  }

  async list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    return this.backend.list({
      scope: this.withDefaultScope(scope),
    });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.backend.get(id);
  }

  async update(id: string, input: UpdateMemoryInput): Promise<void> {
    await this.backend.update(id, input);
  }

  async delete(id: string): Promise<void> {
    await this.backend.delete(id);
  }

  async findRelevantMemories(prompt: string, limit = 3): Promise<MemoryRecord[]> {
    if (!shouldRetrieveMemories(prompt)) return [];

    return this.backend.search({
      query: prompt,
      limit,
      threshold: 0.35,
      categories: categoriesForPrompt(prompt),
      scope: this.withDefaultScope(),
    });
  }

  queueAutomaticCapture(text: string, target?: NotificationTarget): boolean {
    const prefilter = prefilterUserMessage(text);
    if (!prefilter.hasCandidate) return false;

    let queued = false;

    for (const candidate of prefilter.candidates) {
      const key = buildSignalKey(candidate);
      const signal = this.localSignals.get(key) ?? { key, count: 0, lastSeenAt: 0 };
      signal.count += 1;
      signal.lastSeenAt = Date.now();
      this.localSignals.set(key, signal);

      if (this.recentlySaved.has(key) || !shouldPromoteCandidate(candidate, signal)) {
        continue;
      }

      queued = true;
      this.recentlySaved.add(key);
      enqueueWriteTask({
        label: "Memory automatic capture",
        ...(target ? { target } : {}),
        task: async () => {
          const result = await this.addCandidateIfNovel(candidate.text, candidate.normalized, {
            category: candidate.category,
            categories: [candidate.category],
            durability: candidate.durability,
            confidence: candidate.confidence,
            source: signal.count >= 2 && !candidate.explicit ? "repetition" : candidate.source,
            signal_count: signal.count,
            trigger_reasons: candidate.reasons,
            assistant_id: DEFAULT_AGENT_ID,
            auto_saved: true,
            ...candidate.metadata,
          });
          if (result !== "saved") {
            this.recentlySaved.delete(key);
          }
        },
        onFailure: () => {
          this.recentlySaved.delete(key);
        },
      });
    }

    return queued;
  }

  async captureSessionConversation(
    sessionManager: SessionManagerLike,
    reason: string,
    savedSignatures: Set<string>,
    options?: { target?: NotificationTarget; successMessage?: string },
  ): Promise<boolean> {
    const signature = buildSessionSignature(sessionManager);
    if (savedSignatures.has(signature)) return false;

    const messages = selectMemoryWorthMessages(collectSessionMessages(sessionManager));
    if (messages.length < 2) return false;

    savedSignatures.add(signature);
    enqueueWriteTask({
      label: "Memory session capture",
      ...(options?.target ? { target: options.target } : {}),
      ...(options?.successMessage ? { successMessage: options.successMessage } : {}),
      onFailure: () => {
        savedSignatures.delete(signature);
      },
      task: async () => {
        if (this.backend.captureConversation) {
          await this.backend.captureConversation({
            messages,
            metadata: {
              source: "pi-session-wrapup",
              reason,
              session_file: sessionManager.getSessionFile?.() || null,
            },
            scope: this.withDefaultScope(),
          });
          return;
        }

        await this.add({
          messages,
          metadata: {
            source: "pi-session-wrapup",
            reason,
            session_file: sessionManager.getSessionFile?.() || null,
          },
        });
      },
    });

    return true;
  }

  queueLLMExtraction(
    sessionManager: SessionManagerLike,
    model: Model<Api> | undefined,
    target?: NotificationTarget,
  ): boolean {
    if (!model) return false;

    const messages = selectMemoryWorthMessages(collectSessionMessages(sessionManager));
    if (messages.length < 4) return false;

    enqueueWriteTask({
      label: "Memory LLM extraction",
      ...(target ? { target } : {}),
      task: async () => {
        const candidates = await extractMemoriesFromMessages(messages, model);
        for (const candidate of candidates) {
          if (candidate.confidence < 0.6) continue;
          await this.addCandidateIfNovel(candidate.text, candidate.text.toLowerCase(), {
            category: candidate.category,
            categories: [candidate.category],
            durability: candidate.durability,
            confidence: candidate.confidence,
            source: "llm_extracted",
            trigger_reasons: [candidate.reason],
            assistant_id: DEFAULT_AGENT_ID,
            auto_saved: true,
          });
        }
      },
    });

    return true;
  }

  queueConsolidation(target?: NotificationTarget): void {
    if (!this.backend.consolidate) return;

    const consolidate = this.backend.consolidate.bind(this.backend);

    enqueueWriteTask({
      label: "Memory consolidation",
      ...(target ? { target } : {}),
      task: async () => {
        await consolidate();
      },
    });
  }

  async addCandidateIfNovel(text: string, normalized: string, metadata: JsonObject): Promise<"saved" | "skipped"> {
    const existing = await this.list();
    const normalizedValue = normalized.trim().toLowerCase();
    if (existing.some((memory) => {
      const current = memory.text.trim().toLowerCase();
      return current === normalizedValue || current.includes(normalizedValue) || normalizedValue.includes(current);
    })) {
      return "skipped";
    }

    const category = typeof metadata.category === "string" ? metadata.category as MemoryCategory : undefined;
    const categories = Array.isArray(metadata.categories)
      ? metadata.categories.filter((value): value is string => typeof value === "string")
      : undefined;

    await this.add({
      text,
      metadata,
      ...(category ? { category } : {}),
      ...(categories ? { categories } : {}),
    });
    return "saved";
  }

  private withDefaultScope(scope?: MemoryScope): MemoryScope {
    return {
      assistantId: scope?.assistantId || DEFAULT_AGENT_ID,
      ...(scope?.userId ? { userId: scope.userId } : {}),
      ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
    };
  }
}
