import type {
  AddMemoryInput,
  ConsolidationReport,
  MemoryListInput,
  MemoryRecord,
  MemorySearchInput,
  UpdateMemoryInput,
} from "./types.ts";

export interface MemoryBackend {
  add(input: AddMemoryInput): Promise<void>;
  search(input: MemorySearchInput): Promise<MemoryRecord[]>;
  list(input?: MemoryListInput): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  update(id: string, input: UpdateMemoryInput): Promise<void>;
  delete(id: string): Promise<void>;
  /** Bump retrieval stats when memories are injected into a prompt. */
  recordRetrievals?(ids: string[]): Promise<void>;
  consolidate?(): Promise<ConsolidationReport>;
}
