import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryVectorStore, cosineSimilarity } from "../../src/rag/vector-store";
import type { RAGChunk } from "../../src/rag/rag-types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeChunk(text: string, embedding: number[], source = "test.md", idx = 0): RAGChunk {
  return { text, embedding, sourcePath: source, chunkIndex: idx };
}

// ─── Cosine Similarity ───────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 for zero-norm vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("returns ~0.5 for 60-degree angle", () => {
    // Two 2D vectors at 60°: dot = |a||b|cos60 = 1*1*0.5 = 0.5
    const a = [1, 0];
    const b = [0.5, Math.sqrt(0.75)]; // unit vector at 60°
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      /dimension mismatch/i,
    );
  });

  it("handles high-dimensional vectors", () => {
    const dim = 128;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.cos(i));
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(-1);
    expect(score).toBeLessThan(1);
  });
});

// ─── InMemoryVectorStore ─────────────────────────────────────────────────

describe("InMemoryVectorStore", () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it("starts with size 0", () => {
    expect(store.size).toBe(0);
  });

  it("adds chunks and updates size", () => {
    const chunks = [
      makeChunk("hello", [1, 0, 0]),
      makeChunk("world", [0, 1, 0]),
    ];
    store.add(chunks);
    expect(store.size).toBe(2);
  });

  it("clear() removes all chunks", () => {
    store.add([makeChunk("x", [1, 0])]);
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("search returns empty array when store is empty", () => {
    const results = store.search([1, 0, 0], 5);
    expect(results).toHaveLength(0);
  });

  it("search returns top-K results sorted by similarity", () => {
    const chunks = [
      makeChunk("close to query", [1, 0.1, 0]),
      makeChunk("far from query", [0, 1, 0]),
      makeChunk("also close", [0.9, 0, 0.1]),
    ];
    store.add(chunks);

    const results = store.search([1, 0, 0], 2);

    expect(results).toHaveLength(2);
    // First result should be most similar
    expect(results[0].chunk.text).toBe("close to query");
    // Scores should be descending
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("search caps results at topK", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`chunk-${i}`, [i, 0, 0]),
    );
    store.add(chunks);

    const results = store.search([5, 0, 0], 3);
    expect(results).toHaveLength(3);
  });

  it("excludes zero-scoring results", () => {
    // All-zeros embedding → dot product 0 → excluded
    const chunks = [
      makeChunk("zero embedding", [0, 0, 0]),
      makeChunk("positive embedding", [1, 0, 0]),
    ];
    store.add(chunks);

    const results = store.search([1, 0, 0], 5);
    // "zero embedding" should not appear (score = 0)
    expect(results.every((r) => r.score > 0)).toBe(true);
  });
});
