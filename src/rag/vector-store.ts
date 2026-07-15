/**
 * In-memory vector store with cosine similarity search.
 *
 * Zero external dependencies — pure TypeScript implementation suitable
 * for knowledge bases with up to ~10K chunks.
 *
 * NOTE: Search is brute-force O(N) over all stored vectors.  For larger
 * corpora (>10K chunks), replace this with an approximate-nearest-neighbor
 * (ANN) store — e.g. ChromaVectorStore (HNSW), a hnswlib-node wrapper, or
 * any external vector database that implements the VectorStore interface.
 */

import type { VectorStore, RAGChunk, RAGSearchResult } from "./rag-types";

/**
 * An in-memory vector store backed by a simple array.
 *
 * Search uses brute-force cosine similarity, which is fast enough
 * for typical knowledge base sizes (a few thousand chunks).
 */
export class InMemoryVectorStore implements VectorStore {
  private chunks: RAGChunk[] = [];

  async add(chunks: RAGChunk[]): Promise<void> {
    this.chunks.push(...chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  async clear(): Promise<void> {
    this.chunks = [];
  }

  /**
   * Search for the top-K most similar chunks via cosine similarity.
   *
   * Returns results sorted by similarity score descending (best match first).
   * Chunks with near-zero-norm embeddings are excluded from results.
   */
  async search(queryEmbedding: number[], topK: number): Promise<RAGSearchResult[]> {
    if (this.chunks.length === 0) return [];

    const results: RAGSearchResult[] = [];

    for (const chunk of this.chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score !== 0) {
        results.push({ chunk, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [0, 1] for non-negative embeddings (the usual case),
 * or [-1, 1] in the general case. Returns 0 for zero-norm vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    );
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}
