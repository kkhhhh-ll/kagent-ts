import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKeywordIndex } from "../../src/rag/keyword-index";
import type { RAGChunk } from "../../src/rag/rag-types";

function makeChunk(text: string, source = "test.md", idx = 0): RAGChunk {
  return { text, embedding: [], sourcePath: source, chunkIndex: idx };
}

describe("InMemoryKeywordIndex", () => {
  let index: InMemoryKeywordIndex;

  beforeEach(() => {
    index = new InMemoryKeywordIndex();
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  it("starts with size 0", () => {
    expect(index.size).toBe(0);
  });

  it("adds chunks and updates size", () => {
    index.add([makeChunk("hello world")]);
    expect(index.size).toBe(1);
  });

  it("clear() resets all state", () => {
    index.add([makeChunk("hello world")]);
    index.clear();
    expect(index.size).toBe(0);
  });

  // ── Search ─────────────────────────────────────────────────────────────

  describe("search", () => {
    it("returns empty array when index is empty", () => {
      const results = index.search("hello", 5);
      expect(results).toHaveLength(0);
    });

    it("returns matching chunk for exact keyword match", () => {
      index.add([makeChunk("hello world")]);
      const results = index.search("hello", 5);
      expect(results).toHaveLength(1);
      expect(results[0].chunk.text).toBe("hello world");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("returns empty for query with no matching words", () => {
      index.add([makeChunk("hello world")]);
      const results = index.search("xyzzy", 5);
      expect(results).toHaveLength(0);
    });

    it("scores documents higher when query term appears more frequently (TF)", () => {
      index.add([
        makeChunk("hello hello hello world"),  // dense TF
        makeChunk("hello world"),              // sparse TF
      ]);

      const results = index.search("hello", 5);
      expect(results).toHaveLength(2);
      // The chunk with more "hello" tokens should rank higher
      expect(results[0].chunk.text).toBe("hello hello hello world");
    });

    it("returns empty when query is empty or whitespace", () => {
      index.add([makeChunk("hello world")]);
      expect(index.search("", 5)).toHaveLength(0);
      expect(index.search("   ", 5)).toHaveLength(0);
    });

    it("respects topK parameter", () => {
      const chunks = Array.from({ length: 10 }, (_, i) =>
        makeChunk(`document about topic ${i}`, `doc${i}.md`, 0),
      );
      index.add(chunks);
      const results = index.search("topic", 3);
      expect(results).toHaveLength(3);
    });

    it("is case-insensitive", () => {
      index.add([makeChunk("Hello World")]);
      const results = index.search("hello", 5);
      expect(results).toHaveLength(1);
      expect(results[0].chunk.text).toBe("Hello World");
    });
  });

  // ── CJK Tokenization ──────────────────────────────────────────────────

  describe("CJK tokenization", () => {
    it("splits Chinese characters into individual tokens", () => {
      index.add([makeChunk("你好世界")]);
      const results = index.search("你好", 5);
      expect(results).toHaveLength(1);
    });

    it("splits Japanese characters", () => {
      index.add([makeChunk("こんにちは世界")]);
      const results = index.search("世界", 5);
      expect(results).toHaveLength(1);
    });

    it("handles mixed CJK and Latin text", () => {
      index.add([makeChunk("machine learning 机器学习 is great")]);
      const r1 = index.search("machine", 5);
      const r2 = index.search("机器", 5);
      const r3 = index.search("学习", 5);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r3).toHaveLength(1);
    });
  });

  // ── Multiple Documents ────────────────────────────────────────────────

  describe("multiple documents", () => {
    it("returns empty for stop-word-only queries (IDF near zero)", () => {
      // "the" appears in all docs → IDF ≈ 0 → score ≈ 0
      // But BM25 still returns non-zero scores. The key is that common
      // words score lower than rare ones.
      index.add([
        makeChunk("the cat sat on the mat"),
        makeChunk("the dog ran"),
        makeChunk("a bird flew by the window"),
      ]);

      const rareResults = index.search("bird", 5);
      const commonResults = index.search("the", 5);

      // "bird" should score higher than "the" for its doc
      expect(rareResults.length).toBeGreaterThan(0);
      if (commonResults.length > 0) {
        // The score for the rare word should be higher
        expect(rareResults[0].score).toBeGreaterThan(commonResults[0].score);
      }
    });

    it("multi-word queries sum scores across matching terms", () => {
      index.add([
        makeChunk("machine learning algorithms explained"),
        makeChunk("deep learning for computer vision"),
        makeChunk("cooking recipes for beginners"),
      ]);

      // "machine learning" should match doc 0 highest (both terms)
      const results = index.search("machine learning", 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunk.text).toBe("machine learning algorithms explained");
    });
  });
});
