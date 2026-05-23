import { Mem0Backend } from "./mem0-backend.ts";
import { MemoryService } from "./service.ts";

export const memoryService = new MemoryService(new Mem0Backend());
