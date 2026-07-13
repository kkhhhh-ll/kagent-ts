import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RAGManager } from "../../src/rag/rag-manager";
import { createSearchKnowledgeTool, createListKnowledgeDocumentsTool, createIngestKnowledgeTool } from "../../src/rag/search-knowledge";
import { SilentLogger } from "../../src/logging/logger";
import { splitText } from "../../src/rag/text-splitter";
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

    await manager.clear();
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

// ─── Hybrid Search (BM25 + Vector + RRF) ──────────────────────────────────

describe("RAGManager — hybrid search", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-hybrid-"));
  });

  afterEach(() => {
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it("hybrid mode indexes both vector and keyword stores", async () => {
    fs.writeFileSync(path.join(docsDir, "a.md"), "Machine learning is transforming industries.", "utf-8");

    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        hybridSearch: true,
      },
      new SilentLogger(),
    );
    await manager.index();
    expect(manager.indexed).toBe(true);
    expect(manager.chunkCount).toBeGreaterThan(0);
  });

  it("hybrid search returns results for keyword matches", async () => {
    fs.writeFileSync(path.join(docsDir, "a.md"), "TypeScript is a strongly typed programming language.", "utf-8");

    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        hybridSearch: true,
      },
      new SilentLogger(),
    );
    await manager.index();

    const results = await manager.search("TypeScript", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("hybrid mode returns fewer results when topK is small", async () => {
    fs.writeFileSync(path.join(docsDir, "a.md"), "A B C D E F G H I J", "utf-8");

    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        hybridSearch: true,
        topK: 1,
      },
      new SilentLogger(),
    );
    await manager.index();

    const results = await manager.search("A");
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("hybrid clear() resets both indexes", async () => {
    fs.writeFileSync(path.join(docsDir, "a.md"), "Some content.", "utf-8");

    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        hybridSearch: true,
      },
      new SilentLogger(),
    );
    await manager.index();
    expect(manager.indexed).toBe(true);

    await manager.clear();
    expect(manager.indexed).toBe(false);
    expect(manager.chunkCount).toBe(0);

    const results = await manager.search("content", 3);
    expect(results).toHaveLength(0);
  });

  it("hybrid search returns empty when not indexed", async () => {
    const manager = new RAGManager(
      {
        documentsDir: docsDir,
        embeddingProvider: new MockEmbeddingProvider(),
        hybridSearch: true,
      },
      new SilentLogger(),
    );
    const results = await manager.search("anything", 3);
    expect(results).toHaveLength(0);
  });

  it("pure vector mode (default) still works (backward compat)", async () => {
    fs.writeFileSync(path.join(docsDir, "a.md"), "Hello world.", "utf-8");

    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const results = await manager.search("hello", 3);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── Runtime Document Operations ────────────────────────────────────────────

describe("RAGManager — runtime addDocument / removeDocument", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it("addDocument adds a single document at runtime", async () => {
    // Start with an empty index
    writeFile(docsDir, "seed.md", "# Seed\n\nInitial content.");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();
    const initialCount = manager.documentCount;
    const initialChunks = manager.chunkCount;

    // Add a new document at runtime (raw text split into chunks)
    const doc: {
      path: string;
      content: string;
      chunks: Array<{ text: string; embedding: number[]; sourcePath: string; chunkIndex: number }>;
    } = {
      path: "runtime-doc.md",
      content: "Runtime content for testing. ".repeat(50),
      chunks: [],
    };
    // Use splitText to create chunks manually (simulating a loader)
    const texts = splitText(doc.content, 1000, 200);
    doc.chunks = texts.map((text, i) => ({
      text,
      embedding: [],
      sourcePath: doc.path,
      chunkIndex: i,
    }));

    await manager.addDocument(doc);

    expect(manager.documentCount).toBe(initialCount + 1);
    expect(manager.chunkCount).toBeGreaterThan(initialChunks);
    expect(manager.documentPaths).toContain("runtime-doc.md");

    // Should be searchable immediately
    const results = await manager.search("runtime testing", 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.chunk.sourcePath === "runtime-doc.md")).toBe(true);
  });

  it("addDocument replaces existing document with same path", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    // Add doc v1
    const docV1 = {
      path: "dynamic.md",
      content: "Version one.",
      chunks: splitText("Version one.", 1000, 200).map((t: string, i: number) => ({
        text: t, embedding: [], sourcePath: "dynamic.md", chunkIndex: i,
      })),
    };
    await manager.addDocument(docV1);
    const countAfterV1 = manager.chunkCount;

    // Add doc v2 with same path (more content → more chunks)
    const docV2 = {
      path: "dynamic.md",
      content: "Version two. ".repeat(100),
      chunks: splitText("Version two. ".repeat(100), 1000, 200).map((t: string, i: number) => ({
        text: t, embedding: [], sourcePath: "dynamic.md", chunkIndex: i,
      })),
    };
    await manager.addDocument(docV2);

    // Should have replaced, not duplicated
    expect(manager.documentCount).toBe(2); // seed + dynamic (not 3)
    expect(manager.chunkCount).not.toBe(countAfterV1 + docV2.chunks.length); // v1 chunks removed
  });

  it("removeDocument removes a document by path", async () => {
    writeFile(docsDir, "a.md", "# A\n\nDoc A content.");
    writeFile(docsDir, "b.md", "# B\n\nDoc B content.");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();
    expect(manager.documentPaths).toContain("a.md");

    const removed = await manager.removeDocument("a.md");
    expect(removed).toBe(true);
    expect(manager.documentPaths).not.toContain("a.md");
    expect(manager.documentPaths).toContain("b.md"); // b.md is untouched
  });

  it("removeDocument returns false for unknown path", async () => {
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const removed = await manager.removeDocument("non-existent.md");
    expect(removed).toBe(false);
  });

  it("addFromSource supports 'text' type", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const doc = await manager.addFromSource({
      type: "text",
      content: "Inline text about machine learning.",
      title: "ml-notes",
    });

    expect(doc).not.toBeNull();
    expect(doc!.chunks.length).toBeGreaterThan(0);
    expect(manager.documentPaths.some((p) => p.includes("ml-notes"))).toBe(true);

    // Searchable
    const results = await manager.search("machine learning", 3);
    expect(results.length).toBeGreaterThan(0);
  });

  it("addFromSource supports 'text' type with short content", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const doc = await manager.addFromSource({
      type: "text",
      content: "Quick note.",
      title: "quick-note",
    });
    expect(doc).not.toBeNull();
    expect(doc!.chunks.length).toBe(1);
  });

  it("addDocument on empty store makes it indexed and searchable", async () => {
    // Start with NO documentsDir indexing at all
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    // Not calling index() — simulating a store that was never initialized

    const doc = {
      path: "late-doc.md",
      content: "Late content for testing.",
      chunks: splitText("Late content for testing.", 1000, 200).map((t: string, i: number) => ({
        text: t, embedding: [], sourcePath: "late-doc.md", chunkIndex: i,
      })),
    };

    await manager.addDocument(doc);

    expect(manager.indexed).toBe(true);
    expect(manager.documentCount).toBe(1);

    const results = await manager.search("late content", 3);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── ingest_knowledge Tool ──────────────────────────────────────────────────

describe("ingest_knowledge tool", () => {
  let docsDir: string;

  beforeEach(() => {
    docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-ingest-"));
  });

  afterEach(() => {
    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it("ingest_knowledge with text source works", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createIngestKnowledgeTool(manager);

    const result = await tool.execute({
      source: "text",
      content: "Important information about Kubernetes pods.",
      title: "k8s-pods",
    });

    expect(result).toContain("ingested successfully");
    expect(result).toContain("k8s-pods");
    expect(manager.documentCount).toBe(2); // seed + k8s-pods
  });

  it("ingest_knowledge with text source rejects missing title", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createIngestKnowledgeTool(manager);

    const result = await tool.execute({
      source: "text",
      content: "Some content without a title.",
    });

    expect(result).toContain("Error");
    expect(result).toContain("title");
  });

  it("ingest_knowledge with text source rejects empty content", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createIngestKnowledgeTool(manager);

    const result = await tool.execute({
      source: "text",
      content: "   ",
      title: "empty-doc",
    });

    expect(result).toContain("Error");
    expect(result).toContain("content");
  });

  it("ingest_knowledge rejects invalid source type", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createIngestKnowledgeTool(manager);

    const result = await tool.execute({ source: "invalid" });
    expect(result).toContain("Error");
    expect(result).toContain('"url", "text", "file"');
  });

  it("ingest_knowledge with file source works", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    // Place the external file outside docsDir so index() doesn't pick it up
    const externalFile = path.join(os.tmpdir(), `kagent-rag-external-${Date.now()}.txt`);
    fs.writeFileSync(externalFile, "External document content for testing.\n\nMore content here.", "utf-8");

    try {
      const manager = new RAGManager(
        { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
        new SilentLogger(),
      );
      await manager.index();

      const tool = createIngestKnowledgeTool(manager);

      const result = await tool.execute({
        source: "file",
        filePath: externalFile,
      });

      expect(result).toContain("ingested successfully");
      expect(manager.documentCount).toBe(2); // seed + external
    } finally {
      try { fs.unlinkSync(externalFile); } catch { /* */ }
    }
  });

  it("ingest_knowledge with file source rejects missing path", async () => {
    writeFile(docsDir, "seed.md", "# Seed");
    const manager = new RAGManager(
      { documentsDir: docsDir, embeddingProvider: new MockEmbeddingProvider() },
      new SilentLogger(),
    );
    await manager.index();

    const tool = createIngestKnowledgeTool(manager);

    const result = await tool.execute({ source: "file" });
    expect(result).toContain("Error");
    expect(result).toContain("filePath");
  });
});
