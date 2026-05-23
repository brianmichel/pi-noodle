import type { Embedder } from "../../src/memory/embedder.ts";

const DIMENSIONS = 64;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export const fakeSemanticEmbedder: Embedder = {
  dimensions: DIMENSIONS,
  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(DIMENSIONS);
    const tokens = tokenize(text);

    if (tokens.length === 0) return vector;

    for (const token of tokens) {
      const hash = hashToken(token);
      const slot = hash % DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;

      const pairSlot = (hash >>> 8) % DIMENSIONS;
      vector[pairSlot] = (vector[pairSlot] ?? 0) + token.length / 10;
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;

    for (let i = 0; i < vector.length; i += 1) {
      vector[i] = vector[i]! / norm;
    }

    return vector;
  },
};
