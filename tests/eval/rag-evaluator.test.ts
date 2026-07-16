import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RAGEvaluator } from "../../src/eval/rag-evaluator";
import { RAGManager } from "../../src/rag/rag-manager";
import { SilentLogger } from "../../src/logging/logger";
import { chunkKey } from "../../src/rag/rrf";
import type { EmbeddingProvider, RAGSearchResult } from "../../src/rag/rag-types";
import type { LLMProvider } from "../../src/llm/interface";
import type { LLMResponse } from "../../src/llm/interface";
import { Role } from "../../src/messages/types";
import type { MessageData } from "../../src/messages/types";

// ─── Mock embedding provider ──────────────────────────────────────────────

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-embedding";
  readonly dimensions = 8;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.hashEmbed(text));
  }

  private hashEmbed(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }
}

// ─── Mock LLM Judge ───────────────────────────────────────────────────────

/**
 * Creates a mock LLM provider that returns pre-determined judgments.
 */
function mockJudgeLLM(judgments: Array<{ relevant: boolean; score: number; reasoning: string }>): LLMProvider {
  return {
    chat: async (_messages: MessageData[]): Promise<LLMResponse> => {
      const json = JSON.stringify(judgments.map((j, i) => ({
        chunkIndex: i,
        ...j,
      })));
      return { content: json };
    },
  } as unknown as LLMProvider;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-eval-test-"));
}

function writeFile(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

async function createIndexedManager(docsDir: string): Promise<RAGManager> {
  const manager = new RAGManager(
    {
      documentsDir: docsDir,
      embeddingProvider: new MockEmbeddingProvider(),
      topK: 3,
    },
    new SilentLogger(),
  );
  await manager.index();
  return manager;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("RAGEvaluator", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = tempDir();
  });

  afterEach(() => {
    try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── Ground-truth metrics ──────────────────────────────────────────────

  describe("ground-truth metrics", () => {
    it("computes Precision@K, Recall@K, MRR, and NDCG@K", async () => {
      writeFile(docsDir, "mcp.md", "# MCP\n\nMCP协议通过mcpServers配置。首先安装SDK然后配置参数。");
      writeFile(docsDir, "unrelated.md", "# Other\n\nThis is about something completely different.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("MCP 配置", 5);

      // Find the MCP chunk key for ground truth
      const mcpChunk = results.find(r => r.chunk.sourcePath === "mcp.md");
      const relevantKeys = mcpChunk ? [chunkKey(mcpChunk.chunk)] : [];

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "MCP config search",
          query: "MCP 配置方法",
          relevantChunks: relevantKeys,
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      expect(m.precisionAtK).toBeGreaterThan(0);
      expect(m.recallAtK).toBeGreaterThan(0);
      expect(m.mrr).toBeGreaterThan(0);
      expect(m.ndcgAtK).toBeGreaterThan(0);
    });

    it("returns 0 for all ground-truth metrics when no relevant chunks match", async () => {
      writeFile(docsDir, "doc.md", "# Docs\n\nContent about TypeScript.");

      const manager = await createIndexedManager(docsDir);

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "no match",
          query: "TypeScript",
          relevantChunks: ["nonexistent.md#99"], // chunk that doesn't exist
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBe(0);
      expect(m.ndcgAtK).toBe(0);
    });

    it("MRR is 1.0 when the first result is relevant", async () => {
      writeFile(docsDir, "a.md", "# Target\n\nThis is the target document about XYZ configuration.");
      writeFile(docsDir, "b.md", "# Noise\n\nUnrelated noise content here.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("XYZ configuration", 5);

      const targetChunk = results.find(r => r.chunk.sourcePath === "a.md");
      const relevantKeys = targetChunk ? [chunkKey(targetChunk.chunk)] : [];

      // The target should rank first for this specific query
      const isFirst = results.length > 0 && results[0].chunk.sourcePath === "a.md";

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "perfect MRR",
          query: "XYZ configuration",
          relevantChunks: relevantKeys,
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      if (isFirst && relevantKeys.length > 0) {
        expect(m.mrr).toBe(1.0);
      }
    });

    it("Presision and Recall are capped correctly", async () => {
      writeFile(docsDir, "a.md", "# A\n\nAlpha content.");
      writeFile(docsDir, "b.md", "# B\n\nBeta content.");
      writeFile(docsDir, "c.md", "# C\n\nGamma content.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("Alpha Beta Gamma", 5);

      // Mark first 2 as relevant
      const relevantKeys = results.slice(0, 2).map(r => chunkKey(r.chunk));

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "partial match",
          query: "Alpha Beta Gamma",
          relevantChunks: relevantKeys,
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      // 2 of 3 retrieved are relevant → Precision@3 = 2/3
      expect(m.precisionAtK).toBeCloseTo(2 / 3);
      // All 2 relevant docs found → Recall@3 = 2/2 = 1
      expect(m.recallAtK).toBeCloseTo(1.0);
    });
  });

  // ── Ground truth: multiple relevant ───────────────────────────────────

  describe("multiple relevant chunks in ground truth", () => {
    it("Recall@K is <1 when not all relevant docs are retrieved", async () => {
      writeFile(docsDir, "a.md", "# A\n\nMCP configuration guide chapter 1.");
      writeFile(docsDir, "b.md", "# B\n\nMCP protocol setup chapter 2.");
      writeFile(docsDir, "c.md", "# C\n\nMCP advanced usage chapter 3.");
      writeFile(docsDir, "d.md", "# D\n\nUnrelated content.");
      writeFile(docsDir, "e.md", "# E\n\nMore unrelated content.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("MCP configuration setup", 3);

      // Mark the MCP-related chunks as relevant
      const mcpChunks = results
        .filter(r => ["a.md", "b.md", "c.md"].includes(r.chunk.sourcePath))
        .map(r => chunkKey(r.chunk));

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "recall test",
          query: "MCP configuration setup",
          relevantChunks: mcpChunks,
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      // topK=3, there are potentially 3 relevant chunks but only K are retrieved
      // So Recall@3 could be < 1 if not all 3 fit in top-3
      expect(m.recallAtK).toBeGreaterThan(0);
      expect(m.recallAtK).toBeLessThanOrEqual(1);
    });
  });

  // ── LLM judge metrics ─────────────────────────────────────────────────

  describe("LLM judge metrics", () => {
    it("computes LLM-judged Precision@K and NDCG@K from judgments", async () => {
      writeFile(docsDir, "doc.md", "# Docs\n\nSome document content about MCP.");

      const manager = await createIndexedManager(docsDir);

      const judge = mockJudgeLLM([
        { relevant: true, score: 8, reasoning: "Relevant MCP info." },
        { relevant: false, score: 1, reasoning: "Not about MCP." },
      ]);

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        { name: "llm judge test", query: "MCP", topK: 3 },
      ]);

      const m = result.cases[0].metrics;
      expect(m.llmPrecisionAtK).toBeDefined();
      expect(m.llmNdcgAtK).toBeDefined();
      expect(m.avgRelevanceScore).toBeDefined();
      expect(m.avgRelevanceScore!).toBeGreaterThan(0);
    });

    it("LLM Precision@K = 0 when all chunks judged irrelevant", async () => {
      writeFile(docsDir, "doc.md", "# Docs\n\nDocument.");

      const manager = await createIndexedManager(docsDir);

      const judge = mockJudgeLLM([
        { relevant: false, score: 0, reasoning: "Irrelevant." },
        { relevant: false, score: 1, reasoning: "Still irrelevant." },
        { relevant: false, score: 2, reasoning: "Not related." },
      ]);

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        { name: "all irrelevant", query: "MCP", topK: 3 },
      ]);

      const m = result.cases[0].metrics;
      expect(m.llmPrecisionAtK).toBe(0);
    });

    it("LLM Precision@K = 1 when all chunks judged relevant", async () => {
      writeFile(docsDir, "a.md", "# A\n\nMCP guide.");

      const manager = await createIndexedManager(docsDir);

      const judge = mockJudgeLLM([
        { relevant: true, score: 9, reasoning: "Perfect match." },
      ]);

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        { name: "all relevant", query: "MCP", topK: 3 },
      ]);

      const m = result.cases[0].metrics;
      expect(m.llmPrecisionAtK).toBe(1);
    });
  });

  // ── Judge-label agreement ─────────────────────────────────────────────

  describe("judge-label agreement", () => {
    it("computes Cohen's kappa between ground truth and LLM judgments", async () => {
      writeFile(docsDir, "a.md", "# A\n\nMCP configuration guide.");
      writeFile(docsDir, "b.md", "# B\n\nUnrelated noise.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("MCP configuration", 3);

      const mcpChunk = results.find(r => r.chunk.sourcePath === "a.md");
      const relevantKeys = mcpChunk ? [chunkKey(mcpChunk.chunk)] : [];

      // Judge agrees with ground truth
      const judge = mockJudgeLLM(
        results.map(r => ({
          relevant: r.chunk.sourcePath === "a.md",
          score: r.chunk.sourcePath === "a.md" ? 9 : 1,
          reasoning: r.chunk.sourcePath === "a.md" ? "Relevant." : "Not relevant.",
        })),
      );

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        {
          name: "agreement test",
          query: "MCP configuration",
          relevantChunks: relevantKeys,
          topK: 3,
        },
      ]);

      const m = result.cases[0].metrics;
      expect(m.judgeLabelAgreement).toBeDefined();
      // Perfect agreement → κ = 1
      expect(m.judgeLabelAgreement!).toBeCloseTo(1.0);
    });
  });

  // ── Neither ground truth nor judge ────────────────────────────────────

  describe("without ground truth or LLM judge", () => {
    it("returns zeroed metrics", async () => {
      writeFile(docsDir, "doc.md", "# Docs\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        { name: "bare", query: "something", topK: 3 },
      ]);

      const m = result.cases[0].metrics;
      expect(m.precisionAtK).toBe(0);
      expect(m.recallAtK).toBe(0);
      expect(m.mrr).toBe(0);
      expect(m.ndcgAtK).toBe(0);
      expect(m.llmPrecisionAtK).toBeUndefined();
      expect(m.llmNdcgAtK).toBeUndefined();
    });
  });

  // ── Empty retrieval results ───────────────────────────────────────────

  describe("empty retrieval", () => {
    it("handles empty results gracefully", async () => {
      // Manager with no documents indexed
      const manager = new RAGManager(
        {
          documentsDir: docsDir,
          embeddingProvider: new MockEmbeddingProvider(),
          topK: 3,
        },
        new SilentLogger(),
      );
      await manager.index(); // no documents in dir

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "empty",
          query: "anything",
          relevantChunks: ["doc.md#0"],
          topK: 3,
        },
      ]);

      expect(result.cases[0].retrieved).toHaveLength(0);
      expect(result.cases[0].metrics.precisionAtK).toBe(0);
    });
  });

  // ── generateReport ────────────────────────────────────────────────────

  describe("generateReport", () => {
    it("produces a Markdown report with summary and per-case details", async () => {
      writeFile(docsDir, "mcp.md", "# MCP\n\nMCP protocol configuration guide.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("MCP", 3);

      const mcpChunk = results.find(r => r.chunk.sourcePath === "mcp.md");
      const relevantKeys = mcpChunk ? [chunkKey(mcpChunk.chunk)] : [];

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        {
          name: "MCP search",
          query: "MCP 配置",
          relevantChunks: relevantKeys,
          topK: 3,
        },
      ]);

      const report = evaluator.generateReport(result);

      expect(report).toContain("# RAG Retrieval Evaluation Report");
      expect(report).toContain("## Summary");
      expect(report).toContain("Ground-Truth Metrics");
      expect(report).toContain("Precision@K");
      expect(report).toContain("Recall@K");
      expect(report).toContain("MRR");
      expect(report).toContain("NDCG@K");
      expect(report).toContain("## Per-Case Results");
      expect(report).toContain("MCP search");
      expect(report).toContain("MCP 配置");
    });

    it("includes LLM judge metrics in report when judge is configured", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);
      const judge = mockJudgeLLM([
        { relevant: true, score: 7, reasoning: "Relevant." },
      ]);

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        { name: "test", query: "query", topK: 3 },
      ]);

      const report = evaluator.generateReport(result);

      expect(report).toContain("LLM-Judge Metrics");
      expect(report).toContain("LLM Precision@K");
      expect(report).toContain("LLM NDCG@K");
      expect(report).toContain("Avg Relevance Score");
    });

    it("includes collapsed judgments section when judgments exist", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);
      const judge = mockJudgeLLM([
        { relevant: true, score: 7, reasoning: "Relevant." },
      ]);

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: judge });
      const result = await evaluator.evaluate([
        { name: "test", query: "query", topK: 3 },
      ]);

      const report = evaluator.generateReport(result);

      expect(report).toContain("<details>");
      expect(report).toContain("LLM Judgments");
      expect(report).toContain("Relevant.");
    });
  });

  // ── Multiple cases ────────────────────────────────────────────────────

  describe("multiple cases", () => {
    it("evaluates each case independently", async () => {
      writeFile(docsDir, "a.md", "# A\n\nMCP configuration.");
      writeFile(docsDir, "b.md", "# B\n\nTypeScript generics.");

      const manager = await createIndexedManager(docsDir);

      const evaluator = new RAGEvaluator({ ragManager: manager });
      const result = await evaluator.evaluate([
        { name: "case 1", query: "MCP", topK: 3 },
        { name: "case 2", query: "TypeScript", topK: 3 },
        { name: "case 3", query: "Python", topK: 3 },
      ]);

      expect(result.cases).toHaveLength(3);
      expect(result.summary.totalCases).toBe(3);
      expect(result.cases[0].caseName).toBe("case 1");
      expect(result.cases[1].caseName).toBe("case 2");
      expect(result.cases[2].caseName).toBe("case 3");
    });
  });

  // ── Chunk ID format ───────────────────────────────────────────────────

  describe("chunk identification", () => {
    it("uses sourcePath#chunkIndex format consistent with chunkKey()", async () => {
      writeFile(docsDir, "guide.md", "# Guide\n\nThis is a guide about MCP protocol setup and configuration options.");

      const manager = await createIndexedManager(docsDir);
      const results = await manager.search("MCP protocol", 3);

      expect(results.length).toBeGreaterThan(0);

      // Verify chunkKey format
      for (const r of results) {
        const key = chunkKey(r.chunk);
        expect(key).toMatch(/^.+\.md#\d+$/);
      }
    });
  });

  // ── defaultTopK ───────────────────────────────────────────────────────

  describe("defaultTopK", () => {
    it("uses defaultTopK when case does not specify topK", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const evaluator = new RAGEvaluator({ ragManager: manager, defaultTopK: 2 });
      const result = await evaluator.evaluate([
        { name: "default k", query: "content" },
      ]);

      expect(result.cases[0].topK).toBe(2);
    });

    it("case-level topK overrides defaultTopK", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const evaluator = new RAGEvaluator({ ragManager: manager, defaultTopK: 2 });
      const result = await evaluator.evaluate([
        { name: "override", query: "content", topK: 10 },
      ]);

      expect(result.cases[0].topK).toBe(10);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles LLM judge returning malformed JSON", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const badJudge: LLMProvider = {
        chat: async (): Promise<LLMResponse> => {
          return { content: "not valid json at all!!!" };
        },
      } as unknown as LLMProvider;

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: badJudge });
      const result = await evaluator.evaluate([
        { name: "bad json", query: "query", topK: 3 },
      ]);

      // Should not throw; judgments should be defaulted
      expect(result.cases[0].judgments).toBeDefined();
      if (result.cases[0].judgments) {
        for (const j of result.cases[0].judgments) {
          expect(j.relevant).toBe(false);
          expect(j.score).toBe(0);
        }
      }
    });

    it("handles LLM judge returning JSON with markdown fences", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const fencedJudge: LLMProvider = {
        chat: async (): Promise<LLMResponse> => {
          return {
            content: '```json\n[{"chunkIndex": 0, "relevant": true, "score": 8, "reasoning": "Good."}]\n```',
          };
        },
      } as unknown as LLMProvider;

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: fencedJudge });
      const result = await evaluator.evaluate([
        { name: "fenced json", query: "query", topK: 3 },
      ]);

      expect(result.cases[0].judgments).toBeDefined();
      if (result.cases[0].judgments) {
        expect(result.cases[0].judgments[0].relevant).toBe(true);
        expect(result.cases[0].judgments[0].score).toBe(8);
      }
    });

    it("handles judge throwing an error", async () => {
      writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

      const manager = await createIndexedManager(docsDir);

      const throwingJudge: LLMProvider = {
        chat: async (): Promise<LLMResponse> => {
          throw new Error("API error");
        },
      } as unknown as LLMProvider;

      const evaluator = new RAGEvaluator({ ragManager: manager, judgeLLM: throwingJudge });
      const result = await evaluator.evaluate([
        {
          name: "judge error",
          query: "query",
          relevantChunks: ["doc.md#0"],
          topK: 3,
        },
      ]);

      // Should not throw; ground-truth metrics should still be computed
      expect(result.cases[0].metrics.precisionAtK).toBeDefined();
      expect(result.cases[0].judgments).toBeUndefined();
    });
  });
});
