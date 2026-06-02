import type { Api, Model } from "@earendil-works/pi-ai";

import type { JsonObject, NotificationTarget, SessionManagerLike } from "../types.ts";

export type MemoryCategory =
  | "identity"
  | "response_style"
  | "coding_pref"
  | "workflow"
  | "project";

export type MemoryDurability = "durable" | "semi_durable" | "ephemeral";
export type MemoryApplicability = "user" | "project" | "unknown";

export type MemorySource = "explicit" | "heuristic" | "repetition" | "llm_extracted" | "consolidated";

export type MemoryScope = {
  userId?: string;
  assistantId?: string;
  sessionId?: string;
};

export type MemoryMessage = {
  role: string;
  content: string;
};

export type MemoryRecord = {
  id?: string;
  text: string;
  category?: MemoryCategory;
  categories: string[];
  metadata: JsonObject;
  score?: number;
  scope?: MemoryScope;
  createdAt?: number;
  lastRetrieved?: number;
  retrievalCount?: number;
};

export type AddMemoryInput = {
  text?: string;
  messages?: MemoryMessage[];
  metadata?: JsonObject;
  category?: MemoryCategory;
  categories?: string[];
  scope?: MemoryScope;
};

export type MemorySearchInput = {
  query: string;
  scope?: MemoryScope;
  categories?: string[];
  limit?: number;
  threshold?: number;
  filters?: JsonObject;
};

export type MemoryListInput = {
  scope?: MemoryScope;
};

export type UpdateMemoryInput = {
  text?: string;
  metadata?: JsonObject;
};

export type MemoryCandidate = {
  text: string;
  normalized: string;
  category: MemoryCategory;
  durability: MemoryDurability;
  applicability?: MemoryApplicability;
  source: MemorySource;
  confidence: number;
  explicit: boolean;
  reasons: string[];
  metadata: JsonObject;
};

export type PrefilterResult = {
  hasCandidate: boolean;
  shouldRetrieve: boolean;
  candidateReasons: string[];
  candidates: MemoryCandidate[];
};

export type LocalSignal = {
  key: string;
  text: string;
  normalized: string;
  category: MemoryCategory;
  durability: MemoryDurability;
  applicability?: MemoryApplicability;
  source: MemorySource;
  explicit: boolean;
  count: number;
  lastSeenAt: number;
  strongestConfidence: number;
  reasons: string[];
  metadata: JsonObject;
  retrievalCount?: number;
  lastRetrievedAt?: number;
  promotedAt?: number;
  lastPromotionScore?: number;
  lastDecisionAction?: MemoryPolicyAction;
};

export type MemoryPolicyAction = "save" | "pending" | "discard";

export type ExtractionStability = "stable" | "likely_stable" | "uncertain";
export type ExtractionSensitivity = "safe" | "sensitive";

export type ExtractionCandidate = {
  text: string;
  category: MemoryCategory;
  durability: MemoryDurability;
  confidence: number;
  reason: string;
  stability: ExtractionStability;
  sensitivity: ExtractionSensitivity;
  suggestedAction: MemoryPolicyAction;
  applicability: MemoryApplicability;
  applicabilityConfidence?: number;
  applicabilityReason?: string;
};

export type MemoryPolicyDecision = {
  action: MemoryPolicyAction;
  score: number;
  shouldPromote: boolean;
  reasons: string[];
};

export type ConsolidationReport = {
  merged: number;
  deleted: number;
};

export type MemoryExtractorResolution = {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
};

export type MemoryCaptureEventBase = {
  sessionManager: SessionManagerLike;
  target?: NotificationTarget;
  extractor?: {
    resolve: () => Promise<MemoryExtractorResolution | null>;
  };
};

export type MemoryCaptureEvent =
  | (MemoryCaptureEventBase & {
      type: "user_input";
      text: string;
    })
  | (MemoryCaptureEventBase & {
      type: "session_before_compact";
    })
  | (MemoryCaptureEventBase & {
      type: "session_before_switch";
      reason: string;
    })
  | (MemoryCaptureEventBase & {
      type: "session_shutdown";
      reason: string;
    });

export type MemoryCapturePlan = {
  runHeuristics: boolean;
  runLlmExtraction: boolean;
  consolidate: boolean;
  extractionReason?: string;
};

export type MemoryCaptureResult = {
  plan: MemoryCapturePlan;
  automaticCaptureQueued: boolean;
  llmExtractionQueued: boolean;
  consolidationQueued: boolean;
};
