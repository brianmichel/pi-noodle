/** Injectable embedding function. */
export type Embedder = {
  /** Produce a floating-point embedding vector for `text`. */
  embed(text: string): Promise<Float32Array>;
  /** Optional expected dimensionality of the vectors returned by `embed`. */
  dimensions?: number;
};
