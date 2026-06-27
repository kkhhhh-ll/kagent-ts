import { describe, it, expect } from "vitest";
import { LLMReRanker } from "../../src/rag/llm-reranker";
import type { LLMProvider, LLMResponse, LLMStreamEvent } from "../../src/llm/interface";
import type { MessageData } from "../../src/messages/types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeResult(text: string, score = 0.5, source = "test.md", idx = 0) {
  return {
    chunk: { text, embedding: [0], sourcePath: source, chunkIndex: idx },
    score,
  };
}

// ─── Mock LLM ────────────────────────────────────────────────────────────

class MockLLM implements LLMProvider {
  readonly model = "mock";
  private onChat: (msgs: MessageData[]) => string;

  constructor(onChat: (msgs: MessageData[]) => string) {
    this.onChat = onChat;
  }

  async chat(messages: MessageData[]): Promise<LLMResponse> {
    return { content: this.onChat(messages) };
  }

  async *chatStream(): AsyncIterable<LLMStreamEvent> {
    // no-op for tests that don't stream
  }

  getTokenCount(): number {
    return 0;
  }
}

// ─── Tests — Basic ───────────────────────────────────────────────────────

describe("LLMReRanker", () => {
  describe("rerank", () => {
    it("returns single result unchanged", async () => {
      const mock = new MockLLM(() => "[8]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("hello", 0.5)];
      const result = await reranker.rerank("query", input);

      expect(result).toHaveLength(1);
      expect(result[0].chunk.text).toBe("hello");
    });

    it("returns empty array unchanged", async () => {
      const mock = new MockLLM(() => "[8]");
      const reranker = new LLMReRanker({ llm: mock });

      const result = await reranker.rerank("query", []);
      expect(result).toEqual([]);
    });

    it("re-sorts results by LLM scores", async () => {
      // LLM scores: doc 0=3, doc 1=9, doc 2=5 → normalized to 0.3, 0.9, 0.5
      const mock = new MockLLM(() => "[3, 9, 5]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [
        makeResult("irrelevant", 0.8),
        makeResult("highly relevant", 0.5),
        makeResult("somewhat relevant", 0.6),
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
      // Sorted: highest LLM score first
      expect(result[0].chunk.text).toBe("highly relevant");  // 0.9
      expect(result[1].chunk.text).toBe("somewhat relevant"); // 0.5
      expect(result[2].chunk.text).toBe("irrelevant");        // 0.3
    });

    it("normalizes scores to [0, 1]", async () => {
      const mock = new MockLLM(() => "[0, 5, 10]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a"), makeResult("b"), makeResult("c")];
      const result = await reranker.rerank("query", input);

      expect(result[2].score).toBe(0);    // 0/10
      expect(result[1].score).toBe(0.5);   // 5/10
      expect(result[0].score).toBe(1);     // 10/10
    });

    it("caps scores at [0, 1]", async () => {
      const mock = new MockLLM(() => "[-1, 15]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a"), makeResult("b")];
      const result = await reranker.rerank("query", input);

      expect(result.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
    });

    it("falls back to original scores when LLM returns unparseable output", async () => {
      const mock = new MockLLM(() => "I'm sorry, I cannot rank these documents.");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [
        makeResult("a", 0.9),
        makeResult("b", 0.3),
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(2);
      // Should fall back to original order (sorted by original score desc)
      expect(result[0].score).toBe(0.9);
      expect(result[1].score).toBe(0.3);
    });

    it("falls back to original scores when LLM returns empty content", async () => {
      const mock = new MockLLM(() => "");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a", 0.7)];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0.7);
    });

    it("falls back to original scores for empty array response", async () => {
      const mock = new MockLLM(() => "[]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a", 0.7)];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0.7);
    });
  });

  // ── Parsing ────────────────────────────────────────────────────────────

  describe("score parsing", () => {
    it("handles JSON array with whitespace", async () => {
      const mock = new MockLLM(() => "[ 8, 2 , 5 ]");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a"), makeResult("b"), makeResult("c")];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
    });

    it("extracts array even when surrounded by other text", async () => {
      const mock = new MockLLM(() => "Here are the scores:\n[7, 3, 9]\nHope this helps!");
      const reranker = new LLMReRanker({ llm: mock });

      const input = [makeResult("a"), makeResult("b"), makeResult("c")];
      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
    });
  });

  // ── Max Candidates ─────────────────────────────────────────────────────

  describe("maxCandidates", () => {
    it("handles more results than maxCandidates", async () => {
      // Only the first 2 candidates get LLM scores; rest keep original
      const mock = new MockLLM(() => "[9, 1]");
      const reranker = new LLMReRanker({ llm: mock, maxCandidates: 2 });

      const input = [
        makeResult("a", 0.5),
        makeResult("b", 0.6),
        makeResult("c", 0.7),  // overflow
      ];

      const result = await reranker.rerank("query", input);
      expect(result).toHaveLength(3);
      // a gets 0.9, b gets 0.1, c keeps 0.7
      // Sorted: a(0.9) > c(0.7) > b(0.1)
      expect(result[0].chunk.text).toBe("a");
      expect(result[1].chunk.text).toBe("c");
      expect(result[2].chunk.text).toBe("b");
    });
  });
});
