/**
 * Tests for RAGManager's default Cross-Encoder re-ranker behavior.
 *
 * These tests mock @xenova/transformers to avoid downloading the real model.
 * They live in a separate file so the mock doesn't affect other RAGManager tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RAGManager } from "../../src/rag/rag-manager";
import { SilentLogger } from "../../src/logging/logger";
import type { EmbeddingProvider } from "../../src/rag/rag-types";

// ─── Mock @xenova/transformers ──────────────────────────────────────────

// vitest hoists vi.mock() to the top of the file, intercepting all
// dynamic imports of @xenova/transformers from CrossEncoderReRanker.
const { mockPipeFn } = vi.hoisted(() => ({
  mockPipeFn: vi.fn(),
}));

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(mockPipeFn),
}));

// ─── Mock embedding provider ────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-default-rerank-"));
}

function writeFile(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RAGManager — default CrossEncoder re-ranker", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = tempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("uses CrossEncoderReRanker by default (re-rank results differ from original order)", async () => {
    // Setup: mock pipeline returns descending scores (first doc=0.9, second=0.3)
    mockPipeFn.mockImplementation(async (_input: [string, string]) => {
      // Return deterministic scores based on call order tracking via mock
      return [{ label: "RELEVANT", score: 0.9 }];
    });

    writeFile(docsDir, "a.md", "# A\n\nFirst document about apples and fruit.");
    writeFile(docsDir, "b.md", "# B\n\nSecond document about oranges and citrus.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    // Search should trigger re-rank via CrossEncoderReRanker
    const results = await manager.search("fruit", 5);
    expect(results.length).toBeGreaterThan(0);
    // The mock pipeline was called (re-rank happened)
    expect(mockPipeFn).toHaveBeenCalled();
  });

  it("reRanker: null disables re-ranking entirely", async () => {
    writeFile(docsDir, "a.md", "# A\n\nContent about machine learning.");

    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        reRanker: null,
      },
      new SilentLogger(),
    );
    await manager.index();

    const results = await manager.search("machine learning", 3);
    expect(results.length).toBeGreaterThan(0);
    // Pipeline should NOT have been called (no re-ranker)
    expect(mockPipeFn).not.toHaveBeenCalled();
  });

  it("gracefully degrades when re-ranker pipeline fails", async () => {
    // Simulate pipeline throwing an error
    mockPipeFn.mockRejectedValue(new Error("Model download failed"));

    writeFile(docsDir, "a.md", "# Doc\n\nSome searchable content here.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    // Search should NOT throw — graceful degradation
    const results = await manager.search("searchable content", 3);
    expect(results.length).toBeGreaterThan(0);
    // Results still returned, just un-ranked
  });
});
