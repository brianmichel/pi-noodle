import { DEFAULT_AGENT_ID } from "../constants.ts";
import {
  noteExtractorQueued,
  noteExtractorRunFailed,
  noteExtractorRunFinished,
  noteExtractorRunStarted,
  noteExtractorSkipped,
} from "../debug-overlay.ts";
import { enqueueWriteTask } from "../queue.ts";
import {
  buildSessionSignature,
  collectSessionMessages,
  ensureMessages,
  selectExtractorMessages,
  selectMemoryWorthMessages,
} from "../session.ts";
import type { JsonObject } from "../types.ts";
import type { NoodleExtractorMode, NotificationTarget } from "../types.ts";
import type { MemoryBackend } from "./backend.ts";
import { extractMemoriesFromMessages } from "./extractor.ts";
import { deriveProjectKey } from "./project-identity.ts";
import {
  buildSignalKey,
  categoriesForPrompt,
  evaluateCandidateDecision,
  prefilterUserMessage,
  shouldRetrieveMemories,
} from "./policy.ts";
import type {
  AddMemoryInput,
  ExtractionCandidate,
  LocalSignal,
  MemoryCandidate,
  MemoryCaptureEvent,
  MemoryCapturePlan,
  MemoryCaptureResult,
  MemoryCategory,
  MemoryExtractorResolution,
  MemoryRecord,
  MemorySearchInput,
  MemoryScope,
  UpdateMemoryInput,
} from "./types.ts";

const DEFAULT_EXTRACTOR_TRIGGER_EVERY = 10;

type ExtractMemoriesFn = typeof extractMemoriesFromMessages;

type MemoryServiceOptions = {
  extractorMode?: NoodleExtractorMode;
  extractorTriggerEvery?: number;
  projectKeyResolver?: () => string | null;
  extractMemoriesFromMessages?: ExtractMemoriesFn;
};

type QueueCandidateOptions = {
  countIncrement?: number;
  target?: NotificationTarget;
  label?: string;
  extraMetadata?: JsonObject;
};

type ExtractorRunOptions = {
  sessionManager: MemoryCaptureEvent["sessionManager"];
  reason: string;
  target?: NotificationTarget;
  resolve: () => Promise<MemoryExtractorResolution | null>;
};

type ConversationCaptureOptions = {
  sessionManager: MemoryCaptureEvent["sessionManager"];
  reason: string;
  target?: NotificationTarget;
  successMessage?: string;
};

export function planMemoryCaptureEvent(
  event: MemoryCaptureEvent,
  options: {
    extractorMode: NoodleExtractorMode;
    extractorTriggerEvery: number;
    sessionTurnCount: number;
    hasHeuristicCandidates: boolean;
  },
): MemoryCapturePlan {
  const canExtract = options.extractorMode !== "off" && !!event.extractor;

  switch (event.type) {
    case "user_input": {
      const runLlmExtraction = canExtract && (
        options.hasHeuristicCandidates
        || options.sessionTurnCount % Math.max(1, options.extractorTriggerEvery) === 0
      );

      return {
        runHeuristics: true,
        runLlmExtraction,
        captureConversation: false,
        consolidate: false,
        extractionReason: options.hasHeuristicCandidates ? "automatic_capture" : "scheduled",
      };
    }
    case "session_before_compact":
      return {
        runHeuristics: false,
        runLlmExtraction: canExtract,
        captureConversation: true,
        consolidate: false,
        extractionReason: "before_compact",
        conversationReason: "before_compact",
      };
    case "session_before_switch":
      return {
        runHeuristics: false,
        runLlmExtraction: canExtract,
        captureConversation: true,
        consolidate: false,
        extractionReason: `before_switch:${event.reason}`,
        conversationReason: `before_switch:${event.reason}`,
      };
    case "session_shutdown":
      if (event.reason === "reload") {
        return {
          runHeuristics: false,
          runLlmExtraction: false,
          captureConversation: false,
          consolidate: false,
        };
      }
      return {
        runHeuristics: false,
        runLlmExtraction: canExtract,
        captureConversation: true,
        consolidate: true,
        extractionReason: `shutdown:${event.reason}`,
        conversationReason: `shutdown:${event.reason}`,
      };
  }
}

export class MemoryService {
  private readonly localSignals = new Map<string, LocalSignal>();
  private readonly recentlySaved = new Set<string>();
  private readonly savedSessionSignatures = new Set<string>();
  private readonly backend: MemoryBackend;
  private readonly extractorMode: NoodleExtractorMode;
  private readonly extractorTriggerEvery: number;
  private readonly projectKeyResolver: () => string | null;
  private readonly extractMemories: ExtractMemoriesFn;
  private cachedProjectKey?: string | null;
  private sessionTurnCount = 0;

  constructor(backend: MemoryBackend, options?: MemoryServiceOptions) {
    this.backend = backend;
    this.extractorMode = options?.extractorMode ?? "balanced";
    this.extractorTriggerEvery = Math.max(1, options?.extractorTriggerEvery ?? DEFAULT_EXTRACTOR_TRIGGER_EVERY);
    this.projectKeyResolver = options?.projectKeyResolver ?? (() => deriveProjectKey());
    this.extractMemories = options?.extractMemoriesFromMessages ?? extractMemoriesFromMessages;
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
      const filtered = this.filterMemoriesForCurrentProject(results);
      this.noteRetrievedMemories(filtered);
      return filtered;
    });
  }

  async capture(event: MemoryCaptureEvent): Promise<MemoryCaptureResult> {
    if (event.type === "user_input") {
      this.sessionTurnCount += 1;
    }

    const prefilter = event.type === "user_input"
      ? prefilterUserMessage(event.text)
      : { hasCandidate: false, candidates: [] };

    const plan = planMemoryCaptureEvent(event, {
      extractorMode: this.extractorMode,
      extractorTriggerEvery: this.extractorTriggerEvery,
      sessionTurnCount: this.sessionTurnCount,
      hasHeuristicCandidates: prefilter.hasCandidate,
    });

    let automaticCaptureQueued = false;
    if (plan.runHeuristics && prefilter.hasCandidate) {
      for (const candidate of prefilter.candidates) {
        if (this.handleCandidate(candidate, {
          label: "Memory automatic capture",
          ...(event.target ? { target: event.target } : {}),
        })) {
          automaticCaptureQueued = true;
        }
      }
    }

    let conversationCaptureQueued = false;
    if (plan.captureConversation && plan.conversationReason) {
      conversationCaptureQueued = this.queueConversationCapture({
        sessionManager: event.sessionManager,
        reason: plan.conversationReason,
        ...(event.target ? { target: event.target } : {}),
      });
    }

    let llmExtractionQueued = false;
    if (plan.runLlmExtraction && event.extractor && plan.extractionReason) {
      llmExtractionQueued = await this.queueExtractorRun({
        sessionManager: event.sessionManager,
        reason: plan.extractionReason,
        ...(event.target ? { target: event.target } : {}),
        resolve: event.extractor.resolve,
      });
    }

    let consolidationQueued = false;
    if (plan.consolidate) {
      consolidationQueued = this.queueConsolidationInternal(event.target);
    }

    return {
      plan,
      automaticCaptureQueued,
      llmExtractionQueued,
      conversationCaptureQueued,
      consolidationQueued,
    };
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
    const normalizedValue = normalizeText(normalized);
    const duplicate = existing.find((memory) => overlapsNormalizedText(memory.text, normalizedValue));

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

  private queueConversationCapture(options: ConversationCaptureOptions): boolean {
    const signature = buildSessionSignature(options.sessionManager);
    if (this.savedSessionSignatures.has(signature)) return false;

    const messages = selectMemoryWorthMessages(collectSessionMessages(options.sessionManager));
    if (messages.length < 2) return false;

    this.savedSessionSignatures.add(signature);
    enqueueWriteTask({
      label: "Memory session capture",
      ...(options.target ? { target: options.target } : {}),
      ...(options.successMessage ? { successMessage: options.successMessage } : {}),
      onFailure: () => {
        this.savedSessionSignatures.delete(signature);
      },
      task: async () => {
        if (this.backend.captureConversation) {
          await this.backend.captureConversation({
            messages,
            metadata: {
              source: "pi-session-wrapup",
              reason: options.reason,
              session_file: options.sessionManager.getSessionFile?.() || null,
            },
            scope: this.withDefaultScope(),
          });
          return;
        }

        await this.add({
          messages,
          metadata: {
            source: "pi-session-wrapup",
            reason: options.reason,
            session_file: options.sessionManager.getSessionFile?.() || null,
          },
        });
      },
    });

    return true;
  }

  private async queueExtractorRun(options: ExtractorRunOptions): Promise<boolean> {
    const resolved = await options.resolve();
    if (!resolved?.model || !resolved.apiKey) {
      noteExtractorSkipped("extractor model not configured");
      return false;
    }

    const messages = selectExtractorMessages(collectSessionMessages(options.sessionManager));
    if (messages.length < 4) {
      noteExtractorSkipped(
        options.reason.startsWith("shutdown:")
          ? "shutdown run skipped: not enough memory-worthy context yet"
          : "not enough memory-worthy context yet",
      );
      return false;
    }

    noteExtractorQueued(options.reason, resolved.model.id);
    enqueueWriteTask({
      label: "Memory LLM extraction",
      ...(options.target ? { target: options.target } : {}),
      onFailure: () => {
        noteExtractorRunFailed("LLM extraction failed");
      },
      task: async () => {
        noteExtractorRunStarted();
        const candidates = await this.extractMemories(messages, resolved.model, {
          apiKey: resolved.apiKey,
          ...(resolved.headers ? { headers: resolved.headers } : {}),
        });
        let savedCount = 0;
        const extractedTexts: string[] = [];

        for (const extracted of candidates) {
          if (extracted.confidence < 0.58) continue;
          extractedTexts.push(extracted.text);

          const candidate = buildCandidateFromExtraction(extracted);

          if (this.handleCandidate(candidate, {
            countIncrement: extracted.confidence >= 0.85 ? 2 : 1,
            label: "Memory LLM extraction",
            ...(options.target ? { target: options.target } : {}),
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

  private queueConsolidationInternal(target?: NotificationTarget): boolean {
    if (!this.backend.consolidate) return false;

    const consolidate = this.backend.consolidate.bind(this.backend);

    enqueueWriteTask({
      label: "Memory consolidation",
      ...(target ? { target } : {}),
      task: async () => {
        await consolidate();
      },
    });

    return true;
  }

  // Heuristic and LLM candidates share one promotion pipeline so settings,
  // dedupe, metadata, and policy decisions stay consistent across sources.
  private handleCandidate(candidate: MemoryCandidate, options?: QueueCandidateOptions): boolean {
    const candidateWithContext = this.bindCandidateProjectContext(candidate);
    const signal = this.recordCandidateEvidence(
      candidateWithContext,
      options?.countIncrement !== undefined ? { countIncrement: options.countIncrement } : undefined,
    );

    if (candidateWithContext.applicability === "project" && typeof signal.metadata["project_key"] !== "string") {
      signal.lastDecisionAction = "pending";
      return false;
    }

    const decision = evaluateCandidateDecision(candidateWithContext, signal, this.extractorMode);
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
        const result = await this.promoteSignal(
          signal,
          decision.score,
          decision.reasons,
          buildPromotionMetadata(candidateWithContext, signal, decision.score, decision.reasons, this.extractorMode, options?.extraMetadata),
        );
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
      ...(candidate.applicability ? { applicability: candidate.applicability } : {}),
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
    if (candidate.applicability) signal.applicability = candidate.applicability;
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
      if (overlapsNormalizedText(signal.normalized, candidate.normalized)) {
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
        if (overlapsNormalizedText(signal.normalized, normalized)) {
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

  private currentProjectKey(): string | null {
    if (this.cachedProjectKey !== undefined) return this.cachedProjectKey;
    this.cachedProjectKey = this.projectKeyResolver();
    return this.cachedProjectKey;
  }

  private bindCandidateProjectContext(candidate: MemoryCandidate): MemoryCandidate {
    if (candidate.applicability !== "project") return candidate;
    const projectKey = this.currentProjectKey();
    if (!projectKey) return candidate;
    return {
      ...candidate,
      metadata: {
        ...candidate.metadata,
        project_key: projectKey,
      },
    };
  }

  private filterMemoriesForCurrentProject(records: MemoryRecord[]): MemoryRecord[] {
    const currentProjectKey = this.currentProjectKey();
    return records.filter((record) => {
      const applicability = typeof record.metadata["applicability"] === "string"
        ? record.metadata["applicability"]
        : "unknown";
      if (applicability !== "project") return true;
      const projectKey = typeof record.metadata["project_key"] === "string"
        ? record.metadata["project_key"]
        : null;
      return !!currentProjectKey && projectKey === currentProjectKey;
    });
  }
}

function buildCandidateFromExtraction(extracted: ExtractionCandidate): MemoryCandidate {
  return {
    text: extracted.text,
    normalized: extracted.text.toLowerCase(),
    category: extracted.category,
    durability: extracted.durability,
    applicability: extracted.applicability,
    source: "llm_extracted",
    confidence: extracted.confidence,
    explicit: false,
    reasons: [extracted.reason],
    metadata: {
      trigger: extracted.reason,
      stability: extracted.stability,
      sensitivity: extracted.sensitivity,
      suggested_action: extracted.suggestedAction,
      applicability: extracted.applicability,
      ...(extracted.applicabilityConfidence !== undefined
        ? { applicability_confidence: extracted.applicabilityConfidence }
        : {}),
      ...(extracted.applicabilityReason
        ? { applicability_reason: extracted.applicabilityReason }
        : {}),
    },
  };
}

function buildPromotionMetadata(
  candidate: MemoryCandidate,
  signal: LocalSignal,
  score: number,
  promotionReasons: string[],
  extractorMode: NoodleExtractorMode,
  extraMetadata?: JsonObject,
): JsonObject {
  return {
    category: candidate.category,
    categories: [candidate.category],
    durability: candidate.durability,
    confidence: signal.strongestConfidence,
    source: signal.count >= 2 && !candidate.explicit ? "repetition" : candidate.source,
    signal_count: signal.count,
    trigger_reasons: signal.reasons,
    promotion_score: score,
    promotion_reasons: promotionReasons,
    assistant_id: DEFAULT_AGENT_ID,
    auto_saved: true,
    extractor_mode: extractorMode,
    ...signal.metadata,
    ...extraMetadata,
  };
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function overlapsNormalizedText(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
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
    ...(signal.applicability ? { applicability: signal.applicability } : {}),
    source: signal.source,
    confidence: signal.strongestConfidence,
    explicit: signal.explicit,
    reasons: signal.reasons,
    metadata: signal.metadata,
  };
}
