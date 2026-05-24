import type { JsonObject } from "../types.ts";

export type MemoryCategory =
  | "identity"
  | "response_style"
  | "coding_pref"
  | "workflow"
  | "project";

export type MemoryDurability = "durable" | "semi_durable" | "ephemeral";

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

export type ConversationCaptureInput = {
  messages: MemoryMessage[];
  metadata?: JsonObject;
  scope?: MemoryScope;
};

export type MemoryCandidate = {
  text: string;
  normalized: string;
  category: MemoryCategory;
  durability: MemoryDurability;
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
  count: number;
  lastSeenAt: number;
};

export type ExtractionCandidate = {
  text: string;
  category: MemoryCategory;
  durability: MemoryDurability;
  confidence: number;
  reason: string;
};

export type ConsolidationReport = {
  merged: number;
  deleted: number;
};
