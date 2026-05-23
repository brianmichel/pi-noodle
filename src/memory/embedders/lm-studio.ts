import type { Embedder } from "../embedder.ts";
import { createOpenAIEmbedder } from "./openai.ts";
import type { OpenAIEmbedderOptions } from "./openai.ts";

export type LMStudioEmbedderOptions = {
  baseUrl: string;
  model?: string;
};

/**
 * LM Studio exposes an OpenAI-compatible `/v1/embeddings` endpoint — this is a
 * thin convenience wrapper.
 */
export function createLMStudioEmbedder(
  options: LMStudioEmbedderOptions,
): Embedder {
  const opts: Record<string, unknown> = {
    apiKey: "lm-studio",
    baseUrl: options.baseUrl,
  };
  if (options.model) opts.model = options.model;
  return createOpenAIEmbedder(
    opts as unknown as OpenAIEmbedderOptions,
  );
}