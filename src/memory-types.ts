export type MemoryCategory =
  | "identity"
  | "response_style"
  | "coding_pref"
  | "workflow"
  | "project";

export type MemoryDurability = "durable" | "semi_durable" | "ephemeral";

export type MemorySource = "explicit" | "heuristic" | "repetition";

export type MemoryAction = "save" | "ignore";

export type MemoryCandidate = {
  text: string;
  normalized: string;
  category: MemoryCategory;
  durability: MemoryDurability;
  source: MemorySource;
  confidence: number;
  explicit: boolean;
  reasons: string[];
  metadata: Record<string, unknown>;
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

export type StoredMemory = {
  id?: string;
  memory: string;
  categories: string[];
  metadata: Record<string, unknown>;
  score?: number;
};
