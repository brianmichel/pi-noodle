import type { Embedder } from "../embedder.ts";

export type OpenAIEmbedderOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

/**
 * Creates an embedder that calls an OpenAI-compatible `/v1/embeddings` endpoint.
 * Works with OpenAI, LM Studio, Ollama, vLLM, etc. — anything that exposes the
 * OpenAI embeddings API shape.
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const model = options.model ?? "text-embedding-3-small";
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const dimensions = model === "text-embedding-3-small" ? 1536 : 3072;

  return {
    dimensions,
    embed: async (text: string): Promise<Float32Array> => {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: text }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        throw new Error(
          `OpenAI embeddings request failed: ${response.status} ${body}`,
        );
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      const embedding = json.data[0];
      if (!embedding?.embedding) {
        throw new Error("OpenAI returned no embeddings");
      }

      return new Float32Array(embedding.embedding);
    },
  };
}