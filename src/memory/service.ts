import type { Api, Model } from "@earendil-works/pi-ai";

import { DEFAULT_AGENT_ID } from "../constants.ts";
import {
  noteExtractorRunFailed,
  noteExtractorRunFinished,
  noteExtractorRunStarted,
} from "../debug-overlay.ts";
import { enqueueWriteTask } from "../queue.ts";
import {
  buildSessionSignature,
  collectSessionMessages,
  ensureMessages,
  selectExtractorMessages,
  selectMemoryWorthMessages,
} from "../session.ts";
import type { JsonObject, NotificationTarget, SessionManagerLike } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import { extractMemoriesFromMessages } from "./extractor.ts";
import {
  buildSignalKey,
  categoriesForPrompt,
  evaluateCandidateDecision,
  prefilterUserMessage,
  shouldRetrieveMemories,
} from "./policy.ts";
import type {
  AddMemoryInput,
  LocalSignal,
  MemoryCandidate,
  MemoryCategory,
  MemoryRecord,
  MemorySearchInput,
  MemoryScope,
  UpdateMemoryInput,
} from "./types.ts";
import type { NoodleExtractorMode } from "../types.ts";

export class MemoryService {
  private readonly localSignals = new Map<string, LocalSignal>();
  private readonly recentlySaved = new Set<string>();
  private readonly backend: MemoryBackend;
  private readonly extractorMode: NoodleExtractorMode;

  constructor(backend: MemoryBackend, options?: { extractorMode?: NoodleExtractorMode }) {
    this.backend = backend;
    this.extractorMode = options?.extractorMode ?? "balanced";
  }

  add(input: AddMemoryInput): Promise<void> {
    return this.backend.add({
      ...input,
      messages: ensureMessages(input.text, input.messages),
      scope: this.withDefaultScope(input.scope),
    });
  }

  search(input: MemorySearchInput): Promise<MemoryRecord[]> {
    return this.backend.search({
      ...input,
      scope: this.withDefaultScope(input.scope),
    });
  }

  list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    return this.backend.list({
      scope: this.withDefaultScope(scope),
    });
  }

  get(id: string): Promise<MemoryRecord | null> {
    return this.backend.get(id);
  }

  update(id: string, input: UpdateMemoryInput): Promise<void> {
    return this.backend.update(id, input);
  }

  delete(id: string): Promise<void> {
    return this.backend.delete(id);
  }

  findRelevantMemories(prompt: string, limit = 3): Promise<MemoryRecord[]> {
    if (!shouldRetrieveMemories(prompt)) return Promise.resolve([]);

    return this.backend.search({
      query: prompt,
      limit,
      threshold: 0.22,
      categories: categoriesForPrompt(prompt),
      scope: this.withDefaultScope(),
    }).then((results) => {
      this.noteRetrievedMemories(results);
      return results;
    });
  }

  queueAutomaticCapture(text: string, target?: NotificationTarget): boolean {
    const prefilter = prefilterUserMessage(text);
    if (!prefilter.hasCandidate) return false;

    let queued = false;

    for (const candidate of prefilter.candidates) {
      if (this.handleCandidate(candidate, {
        label: "Memory automatic capture",
        ...(target ? { target } : {}),
      })) {
        queued = true;
      }
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

    const messages = selectExtractorMessages(collectSessionMessages(sessionManager));
    if (messages.length < 4) return false;

    enqueueWriteTask({
      label: "Memory LLM extraction",
      ...(target ? { target } : {}),
      onFailure: () => {
        noteExtractorRunFailed("LLM extraction failed");
      },
      task: async () => {
        noteExtractorRunStarted();
        const candidates = await extractMemoriesFromMessages(messages, model);
        let savedCount = 0;
        const extractedTexts: string[] = [];

        for (const extracted of candidates) {
          if (extracted.confidence < 0.58) continue;
          extractedTexts.push(extracted.text);

          const candidate: MemoryCandidate = {
            text: extracted.text,
            normalized: extracted.text.toLowerCase(),
            category: extracted.category,
            durability: extracted.durability,
            source: "llm_extracted",
            confidence: extracted.confidence,
            explicit: false,
            reasons: [extracted.reason],
            metadata: {
              trigger: extracted.reason,
              stability: extracted.stability,
              sensitivity: extracted.sensitivity,
              suggested_action: extracted.suggestedAction,
            },
          };

          if (this.handleCandidate(candidate, {
            countIncrement: extracted.confidence >= 0.85 ? 2 : 1,
            label: "Memory LLM extraction",
            ...(target ? { target } : {}),
            extraMetadata: {
              extractor_reinforced: true,
              extractor_stability: extracted.stability,
              extractor_sensitivity: extracted.sensitivity,
              extractor_suggested_action: extracted.suggestedAction,
            },
          })) {
            savedCount += 1;
          }
        }

        noteExtractorRunFinished(extractedTexts, savedCount);
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

  // Pending candidates stay review-only in v1 so retrieval quality is based on
  // committed memories, not speculative first-pass inferences.
  listPendingCandidates(): Array<LocalSignal & { score: number; promotionReasons: string[] }> {
    return Array.from(this.localSignals.values())
      .filter((signal) => !signal.promotedAt && signal.lastDecisionAction === "pending")
      .map((signal) => {
        const candidate = signalToCandidate(signal);
        const decision = evaluateCandidateDecision(candidate, signal, this.extractorMode);
        return {
          ...signal,
          score: decision.score,
          promotionReasons: decision.reasons,
        };
      })
      .sort((a, b) => b.score - a.score || b.count - a.count || b.lastSeenAt - a.lastSeenAt)
      .slice(0, 10);
  }

  dismissPendingCandidate(key: string): boolean {
    const signal = this.localSignals.get(key);
    if (!signal || signal.promotedAt || signal.lastDecisionAction !== "pending") return false;
    this.localSignals.delete(key);
    return true;
  }

  async addCandidateIfNovel(text: string, normalized: string, metadata: JsonObject): Promise<"saved" | "merged" | "skipped"> {
    const existing = await this.list();
    const normalizedValue = normalized.trim().toLowerCase();
    const duplicate = existing.find((memory) => {
      const current = memory.text.trim().toLowerCase();
      return current === normalizedValue || current.includes(normalizedValue) || normalizedValue.includes(current);
    });

    if (duplicate?.id) {
      await this.update(duplicate.id, {
        metadata: mergeMemoryMetadata(duplicate.metadata, {
          ...metadata,
          retrieval_count: duplicate.retrievalCount ?? 0,
          last_retrieved_at: duplicate.lastRetrieved ?? null,
        }),
      });
      return "merged";
    }
    if (duplicate) {
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

  // Heuristic and LLM candidates share one promotion pipeline so settings,
  // dedupe, metadata, and policy decisions stay consistent across sources.
  private handleCandidate(
    candidate: MemoryCandidate,
    options?: {
      countIncrement?: number;
      target?: NotificationTarget;
      label?: string;
      extraMetadata?: JsonObject;
    },
  ): boolean {
    const signal = this.recordCandidateEvidence(
      candidate,
      options?.countIncrement !== undefined ? { countIncrement: options.countIncrement } : undefined,
    );
    const decision = evaluateCandidateDecision(candidate, signal, this.extractorMode);
    signal.lastDecisionAction = decision.action;

    if (decision.action !== "save") {
      return false;
    }
    if (this.recentlySaved.has(signal.key)) {
      return false;
    }

    this.recentlySaved.add(signal.key);
    enqueueWriteTask({
      label: options?.label ?? "Memory candidate promotion",
      ...(options?.target ? { target: options.target } : {}),
      task: async () => {
        const result = await this.promoteSignal(signal, decision.score, decision.reasons, {
          category: candidate.category,
          categories: [candidate.category],
          durability: candidate.durability,
          confidence: signal.strongestConfidence,
          source: signal.count >= 2 && !candidate.explicit ? "repetition" : candidate.source,
          signal_count: signal.count,
          trigger_reasons: signal.reasons,
          promotion_score: decision.score,
          promotion_reasons: decision.reasons,
          assistant_id: DEFAULT_AGENT_ID,
          auto_saved: true,
          extractor_mode: this.extractorMode,
          ...signal.metadata,
          ...options?.extraMetadata,
        });
        if (result === "saved" || result === "merged") {
          signal.promotedAt = Date.now();
          signal.lastPromotionScore = decision.score;
          signal.lastDecisionAction = "save";
        } else {
          this.recentlySaved.delete(signal.key);
        }
      },
      onFailure: () => {
        this.recentlySaved.delete(signal.key);
      },
    });

    return true;
  }

  private recordCandidateEvidence(candidate: MemoryCandidate, options?: { countIncrement?: number }): LocalSignal {
    const key = this.findMatchingSignalKey(candidate) ?? buildSignalKey(candidate);
    const signal = this.localSignals.get(key) ?? {
      key,
      text: candidate.text,
      normalized: candidate.normalized,
      category: candidate.category,
      durability: candidate.durability,
      source: candidate.source,
      explicit: candidate.explicit,
      count: 0,
      lastSeenAt: 0,
      strongestConfidence: 0,
      reasons: [],
      metadata: {},
    };

    signal.text = candidate.text;
    signal.normalized = candidate.normalized;
    signal.category = candidate.category;
    signal.durability = candidate.durability;
    signal.source = candidate.source;
    signal.explicit = signal.explicit || candidate.explicit;
    signal.count += options?.countIncrement ?? 1;
    signal.lastSeenAt = Date.now();
    signal.strongestConfidence = Math.max(signal.strongestConfidence, candidate.confidence);
    signal.reasons = Array.from(new Set([...signal.reasons, ...candidate.reasons]));
    signal.metadata = {
      ...signal.metadata,
      ...candidate.metadata,
    };
    this.localSignals.set(key, signal);
    return signal;
  }

  private async promoteSignal(signal: LocalSignal, score: number, promotionReasons: string[], metadata: JsonObject): Promise<"saved" | "merged" | "skipped"> {
    return this.addCandidateIfNovel(signal.text, signal.normalized, {
      ...metadata,
      confidence: signal.strongestConfidence,
      signal_count: signal.count,
      trigger_reasons: signal.reasons,
      promotion_score: score,
      promotion_reasons: promotionReasons,
      last_seen_at: signal.lastSeenAt,
      retrieval_signal_count: signal.retrievalCount ?? 0,
      last_retrieved_at: signal.lastRetrievedAt ?? null,
    });
  }

  private findMatchingSignalKey(candidate: MemoryCandidate): string | null {
    for (const [key, signal] of this.localSignals.entries()) {
      if (signal.category !== candidate.category) continue;
      if (
        signal.normalized === candidate.normalized ||
        signal.normalized.includes(candidate.normalized) ||
        candidate.normalized.includes(signal.normalized)
      ) {
        return key;
      }
    }
    return null;
  }

  private noteRetrievedMemories(records: MemoryRecord[]): void {
    const now = Date.now();
    for (const record of records) {
      const normalized = record.text.trim().toLowerCase();
      for (const signal of this.localSignals.values()) {
        if (
          signal.normalized === normalized ||
          signal.normalized.includes(normalized) ||
          normalized.includes(signal.normalized)
        ) {
          signal.retrievalCount = (signal.retrievalCount ?? 0) + 1;
          signal.lastRetrievedAt = now;
        }
      }
    }
  }

  private withDefaultScope(scope?: MemoryScope): MemoryScope {
    return {
      assistantId: scope?.assistantId || DEFAULT_AGENT_ID,
      ...(scope?.userId ? { userId: scope.userId } : {}),
      ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
    };
  }
}

function mergeMemoryMetadata(existing: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = {
    ...existing,
    ...incoming,
  };

  const triggerReasons = new Set<string>();
  const addReasons = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) triggerReasons.add(item);
    }
  };
  addReasons(existing["trigger_reasons"]);
  addReasons(incoming["trigger_reasons"]);
  if (triggerReasons.size > 0) merged["trigger_reasons"] = Array.from(triggerReasons);

  const existingSignal = typeof existing["signal_count"] === "number" ? existing["signal_count"] : 0;
  const incomingSignal = typeof incoming["signal_count"] === "number" ? incoming["signal_count"] : 0;
  if (existingSignal || incomingSignal) {
    merged["signal_count"] = Math.max(existingSignal, incomingSignal);
  }

  const existingConfidence = typeof existing["confidence"] === "number" ? existing["confidence"] : undefined;
  const incomingConfidence = typeof incoming["confidence"] === "number" ? incoming["confidence"] : undefined;
  if (existingConfidence !== undefined || incomingConfidence !== undefined) {
    merged["confidence"] = Math.max(existingConfidence ?? 0, incomingConfidence ?? 0);
  }

  const existingRetrievalSignal = typeof existing["retrieval_signal_count"] === "number" ? existing["retrieval_signal_count"] : 0;
  const incomingRetrievalSignal = typeof incoming["retrieval_signal_count"] === "number" ? incoming["retrieval_signal_count"] : 0;
  if (existingRetrievalSignal || incomingRetrievalSignal) {
    merged["retrieval_signal_count"] = Math.max(existingRetrievalSignal, incomingRetrievalSignal);
  }

  merged["last_seen_at"] = Date.now();
  return merged;
}

function signalToCandidate(signal: LocalSignal): MemoryCandidate {
  return {
    text: signal.text,
    normalized: signal.normalized,
    category: signal.category,
    durability: signal.durability,
    source: signal.source,
    confidence: signal.strongestConfidence,
    explicit: signal.explicit,
    reasons: signal.reasons,
    metadata: signal.metadata,
  };
}
