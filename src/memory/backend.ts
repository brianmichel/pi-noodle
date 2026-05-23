import type {
  AddMemoryInput,
  ConversationCaptureInput,
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
  captureConversation?(input: ConversationCaptureInput): Promise<void>;
}
