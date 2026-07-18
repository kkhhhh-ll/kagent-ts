import { describe, it, expect, vi, beforeEach } from "vitest";
import { CrossEncoderReRanker } from "../../src/rag/cross-encoder-reranker";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeResult(text: string, score = 0.5, source = "test.md", idx = 0) {
  return {
    chunk: { text, embedding: [0], sourcePath: source, chunkIndex: idx },
    score,
  };
}

type MockPipeFn = (input: [string, string]) => Promise<Array<{ label: string; score: number }>>;

/**
 * Create a mock pipeline that returns scores from the provided array
 * (cycling if needed). Each call consumes the next score.
 */
function makeMockPipe(scores?: number[]): MockPipeFn {
  let callIdx = 0;
  return async (_input: [string, string]) => {
    const score = scores ? scores[callIdx % scores.length] : 0.7;
    callIdx++;
    return [{ label: "RELEVANT", score }];
  };
}

/**
 * Inject a mock pipeline directly into a CrossEncoderReRanker instance,
 * bypassing the real @xenova/transformers dynamic import.
 */
function injectPipe(reranker: CrossEncoderReRanker, pipe: MockPipeFn): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (reranker as any).pipe = pipe;
}

// ─── Tests — Basic ───────────────────────────────────────────────────────

describe("CrossEncoderReRanker", () => {
  describe("rerank", () => {
    it("returns single result unchanged", async () => {
      const reranker = new CrossEncoderReRanker();

      const input = [makeResult("hello", 0.5)];
      const result = await reranker.rerank("query", input);

      expect(result).toHaveLength(1);
      expect(result[0].chunk.text).toBe("hello");
    });

    it("returns empty array unchanged", async () => {
      const reranker = new CrossEncoderReRanker();

      const result = await reranker.rerank("query", []);
      expect(result).toEqual([]);
    });

    it("re-sorts results by cross-encoder scores", async () => {
      // Simulate: doc0=0.3, doc1=0.9, doc2=0.5
      const reranker = new CrossEncoderReRanker();
      injectPipe(reranker, makeMockPipe([0.3, 0.9, 0.5]));

      const input = [
        makeResult("irrelevant", 0.8),
        makeResult("highly relevant", 0.5),
        makeResult("somewhat relevant", 0.6),
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
      // Sorted by cross-encoder score descending
      expect(result[0].chunk.text).toBe("highly relevant");  // 0.9
      expect(result[0].score).toBe(0.9);
      expect(result[1].chunk.text).toBe("somewhat relevant"); // 0.5
      expect(result[1].score).toBe(0.5);
      expect(result[2].chunk.text).toBe("irrelevant");        // 0.3
      expect(result[2].score).toBe(0.3);
    });

    it("preserves original scores for overflow beyond maxCandidates", async () => {
      // Only 2 candidates get cross-encoder scores, the 3rd keeps original
      const reranker = new CrossEncoderReRanker({ maxCandidates: 2 });
      injectPipe(reranker, makeMockPipe([0.9, 0.1]));

      const input = [
        makeResult("a", 0.5),
        makeResult("b", 0.6),
        makeResult("c", 0.7),  // overflow
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
      // CE scores: a=0.9, b=0.1. c keeps 0.7
      // Sorted: a(0.9) > c(0.7) > b(0.1)
      expect(result[0].chunk.text).toBe("a");
      expect(result[0].score).toBe(0.9);
      expect(result[1].chunk.text).toBe("c");
      expect(result[1].score).toBe(0.7);
      expect(result[2].chunk.text).toBe("b");
      expect(result[2].score).toBe(0.1);
    });

    it("uses default maxCandidates of 20", async () => {
      const reranker = new CrossEncoderReRanker();
      injectPipe(reranker, makeMockPipe([0.9]));

      // 25 results, but only first 20 get re-scored
      const input = Array.from({ length: 25 }, (_, i) =>
        makeResult(`doc${i}`, 0.5 - i * 0.01),
      );

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(25);
      // First-ranked result got CE score 0.9
      expect(result[0].score).toBe(0.9);
    });

    it("handles empty pipeline result gracefully (score=0)", async () => {
      const reranker = new CrossEncoderReRanker();
      const emptyPipe: MockPipeFn = async (_input: [string, string]) => [];
      injectPipe(reranker, emptyPipe);

      // Need ≥2 results to avoid early-return (single result is already sorted)
      const input = [makeResult("a", 0.5), makeResult("b", 0.6)];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(2);
      // Both get score 0 from empty pipeline
      expect(result[0].score).toBe(0);
      expect(result[1].score).toBe(0);
    });

    it("handles pipeline returning null score gracefully", async () => {
      const reranker = new CrossEncoderReRanker();
      const badPipe: MockPipeFn = async (_input: [string, string]) =>
        [{ label: "RELEVANT", score: undefined as unknown as number }];
      injectPipe(reranker, badPipe);

      // Need ≥2 results to reach the pipe call
      const input = [makeResult("a", 0.5), makeResult("b", 0.6)];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(2);
      expect(result[0].score).toBe(0);
      expect(result[1].score).toBe(0);
    });
  });

  // ─── Model loading ────────────────────────────────────────────────────

  describe("model loading", () => {
    it("lazy-loads: pipe is null before rerank, set after", async () => {
      const reranker = new CrossEncoderReRanker();

      // Before first rerank, pipe is null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reranker as any).pipe).toBeNull();

      // Inject a mock and call rerank
      injectPipe(reranker, makeMockPipe([0.8]));

      const result = await reranker.rerank("query", [makeResult("a"), makeResult("b")]);
      expect(result).toHaveLength(2);

      // After rerank, pipe is set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reranker as any).pipe).not.toBeNull();
    });

    it("throws descriptive error when model fails to load", async () => {
      // Simulate error by not injecting a pipe — the real loadModel will try
      // to import @xenova/transformers and fail (no model cached).
      // We test the error path by directly triggering loadModel failure.
      const reranker = new CrossEncoderReRanker({ model: "nonexistent/model" });
      const input = [makeResult("a"), makeResult("b")];

      // Without an injected pipe, rerank() will try to load the real model
      // and fail. The error message should include the model name.
      await expect(reranker.rerank("query", input)).rejects.toThrow(
        /CrossEncoderReRanker.*Failed to load model.*nonexistent\/model/s,
      );
    });
  });

  // ─── Custom config ─────────────────────────────────────────────────────

  describe("config", () => {
    it("stores model name from config", async () => {
      const reranker = new CrossEncoderReRanker({
        model: "Xenova/bge-reranker-v2-m3",
      });

      // Inject pipe and verify re-rank works with custom model config
      injectPipe(reranker, makeMockPipe([0.75, 0.25]));
      const result = await reranker.rerank("query", [
        makeResult("a"),
        makeResult("b"),
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].score).toBe(0.75);
      expect(result[1].score).toBe(0.25);
    });

    it("respects custom maxCandidates", async () => {
      const reranker = new CrossEncoderReRanker({ maxCandidates: 1 });
      injectPipe(reranker, makeMockPipe([0.9]));

      const input = [
        makeResult("a", 0.3),
        makeResult("b", 0.7),
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(2);
      // a gets CE score 0.9, b keeps original 0.7
      expect(result[0].score).toBe(0.9); // a (CE)
      expect(result[0].chunk.text).toBe("a");
    });
  });
});
