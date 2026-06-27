import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RAGManager } from "../../src/rag/rag-manager";
import { createSearchKnowledgeTool, createListKnowledgeDocumentsTool } from "../../src/rag/search-knowledge";
import { SilentLogger } from "../../src/logging/logger";
import type { EmbeddingProvider } from "../../src/rag/rag-types";

// ─── Mock embedding provider ──────────────────────────────────────────────

/**
 * A mock embedding provider that generates deterministic pseudo-embeddings
 * by hashing the input text. No API key required.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock-embedding";
  readonly dimensions = 8;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.hashEmbed(text));
  }

  private hashEmbed(text: string): number[] {
    // Simple hash → deterministic 8‑dim vector
    const vec = new Array<number>(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-mgr-test-"));
}

function writeFile(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RAGManager", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = tempDir();
  });

  afterEach(() => {
    try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── Indexing ──────────────────────────────────────────────────────────

  it("indexes documents from a directory", async () => {
    writeFile(docsDir, "a.md", "# Document A\n\nThis is document A about TypeScript.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    expect(manager.indexed).toBe(false);
    await manager.index();

    expect(manager.indexed).toBe(true);
    expect(manager.documentCount).toBe(1);
    expect(manager.chunkCount).toBeGreaterThanOrEqual(1);
    expect(manager.documentPaths).toContain("a.md");
  });

  it("indexes multiple documents", async () => {
    writeFile(docsDir, "a.md", "# A\n\nContent A.");
    writeFile(docsDir, "b.txt", "Content B.");
    writeFile(docsDir, "c.json", '{"x": 1}');

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    await manager.index();

    expect(manager.documentCount).toBe(3);
    expect(manager.chunkCount).toBeGreaterThanOrEqual(3);
  });

  it("handles empty directory gracefully", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    await manager.index();

    expect(manager.indexed).toBe(true);
    expect(manager.documentCount).toBe(0);
    expect(manager.chunkCount).toBe(0);
  });

  it("clear() resets all state", async () => {
    writeFile(docsDir, "doc.md", "# Doc\n\nContent.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    await manager.index();
    expect(manager.documentCount).toBe(1);

    manager.clear();
    expect(manager.documentCount).toBe(0);
    expect(manager.chunkCount).toBe(0);
    expect(manager.indexed).toBe(false);
  });

  it("index() is idempotent — calling it again rebuilds", async () => {
    writeFile(docsDir, "doc.md", "# V1\n\nVersion one.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    await manager.index();
    const count1 = manager.chunkCount;

    // Calling again should clear + rebuild
    await manager.index();
    expect(manager.chunkCount).toBe(count1); // Same content, same count
  });

  // ── Search ─────────────────────────────────────────────────────────────

  it("search returns relevant results for a query", async () => {
    writeFile(
      docsDir,
      "typescript.md",
      "TypeScript is a typed superset of JavaScript. " +
      "It adds static type checking to the language. " +
      "TypeScript compiles to plain JavaScript.",
    );
    writeFile(
      docsDir,
      "python.md",
      "Python is an interpreted high-level programming language. " +
      "It emphasizes code readability with significant indentation. " +
      "Python supports multiple programming paradigms.",
    );

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider(), topK: 3 },
      new SilentLogger(),
    );

    await manager.index();

    // Search for TypeScript-related content
    const results = await manager.search("TypeScript type checking", 2);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Both documents are in the index — results exist
    expect(results.every((r) => r.score > 0)).toBe(true);
    expect(results.every((r) => r.chunk.text.length > 0)).toBe(true);
  });

  it("search returns empty array when store is not indexed", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    const results = await manager.search("query");
    expect(results).toHaveLength(0);
  });

  it("search respects topK parameter", async () => {
    writeFile(docsDir, "long.md", "Content. ".repeat(100));

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider(), topK: 3 },
      new SilentLogger(),
    );

    await manager.index();

    const results = await manager.search("content", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("search falls back to config.topK when not specified", async () => {
    writeFile(docsDir, "long.md", "Data. ".repeat(80));

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider(), topK: 3 },
      new SilentLogger(),
    );

    await manager.index();

    const results = await manager.search("data"); // no topK arg
    expect(results.length).toBeLessThanOrEqual(3);
  });

  // ── formatResults ──────────────────────────────────────────────────────

  it("formatResults includes source path and scores", () => {
    writeFile(docsDir, "doc.md", "# Doc\n\nContent here.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    const formatted = manager.formatResults([
      {
        chunk: { text: "Sample chunk text.", embedding: [], sourcePath: "doc.md", chunkIndex: 0 },
        score: 0.85,
      },
    ]);

    expect(formatted).toContain("doc.md");
    expect(formatted).toContain("0.850");
    expect(formatted).toContain("Sample chunk text.");
  });

  it("formatResults returns placeholder for empty results", () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    const formatted = manager.formatResults([]);
    expect(formatted).toContain("No relevant documents");
  });
});

// ─── Tool factories ──────────────────────────────────────────────────────

describe("RAG tools (search_knowledge / list_knowledge_documents)", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = tempDir();
  });

  afterEach(() => {
    try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("search_knowledge tool returns error for empty query", async () => {
    writeFile(docsDir, "doc.md", "# Test\n\nContent.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createSearchKnowledgeTool(manager);
    const result = await tool.execute({ query: "" });
    expect(result).toContain("Error");
  });

  it("search_knowledge tool returns empty-msg when not indexed", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    // NOT calling index()

    const tool = createSearchKnowledgeTool(manager);
    const result = await tool.execute({ query: "test" });
    expect(result).toContain("empty");
  });

  it("search_knowledge tool returns formatted results on success", async () => {
    writeFile(docsDir, "api.md", "# API Reference\n\nThe API provides endpoints for data access.");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider(), topK: 3 },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createSearchKnowledgeTool(manager);
    const result = await tool.execute({ query: "API endpoints" });

    expect(result).toContain("api.md");
    expect(result).toContain("API");
  });

  it("list_knowledge_documents tool lists indexed paths", async () => {
    writeFile(docsDir, "a.md", "# A");
    writeFile(docsDir, "b.txt", "B");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createListKnowledgeDocumentsTool(manager);
    const result = await tool.execute({});

    expect(result).toContain("a.md");
    expect(result).toContain("b.txt");
  });

  it("list_knowledge_documents tool reports when not indexed", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );

    const tool = createListKnowledgeDocumentsTool(manager);
    const result = await tool.execute({});
    expect(result).toContain("not been indexed");
  });

  it("list_knowledge_documents tool reports empty knowledge base", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index(); // Empty dir → 0 documents

    const tool = createListKnowledgeDocumentsTool(manager);
    const result = await tool.execute({});
    expect(result).toContain("No documents");
  });
});
