/**
 * ChromaVectorStore integration tests.
 *
 * These tests require a running Chroma server. If none is available,
 * all tests are skipped automatically (no failures).
 *
 * Start Chroma locally:
 *   docker run -p 8000:8000 chromadb/chroma
 *
 * Or install and run chroma directly:
 *   pip install chromadb && chroma run --port 8000
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChromaVectorStore } from "../../src/rag/chroma-store";

// ─── Helpers ─────────────────────────────────────────────────────────────

const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
const TEST_COLLECTION = "kagent-test-" + Date.now();

function makeChunk(text: string, embedding: number[], source = "test.md", idx = 0) {
  return { text, embedding, sourcePath: source, chunkIndex: idx };
}

/** Quick connectivity check — skip all tests if Chroma is unreachable. */
async function isChromaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${CHROMA_URL}/api/v2/heartbeat`);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ChromaVectorStore", () => {
  let store: ChromaVectorStore;
  let available = false;

  beforeAll(async () => {
    available = await isChromaAvailable();
    if (!available) {
      console.log(`  [SKIP] Chroma not available at ${CHROMA_URL} — skipping integration tests.`);
      return;
    }
  });

  beforeEach(async () => {
    if (!available) return;
    store = new ChromaVectorStore({
      url: CHROMA_URL,
      collectionName: TEST_COLLECTION,
      embeddingDimension: 3,
    });
  });

  afterAll(async () => {
    if (!available) return;
    // Clean up test collection
    const { ChromaClient } = await import("chromadb");
    const client = new ChromaClient({ url: CHROMA_URL });
    try { await client.deleteCollection({ name: TEST_COLLECTION }); } catch { /* ok */ }
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts with size 0 (or existing count)", async () => {
      if (!available) return;
      // First access triggers ensureInit → count from Chroma
      await store.add([]);
      expect(store.size).toBe(0);
    });

    it("adds chunks and updates size", async () => {
      if (!available) return;
      const chunks = [
        makeChunk("hello world", [1, 0, 0]),
        makeChunk("goodbye world", [0, 1, 0]),
      ];
      await store.add(chunks);
      expect(store.size).toBe(2);
    });

    it("clear() removes all chunks", async () => {
      if (!available) return;
      await store.add([makeChunk("temp", [0, 0, 1])]);
      expect(store.size).toBeGreaterThanOrEqual(1);
      await store.clear();
      expect(store.size).toBe(0);
    });

    it("clear() is idempotent", async () => {
      if (!available) return;
      await store.clear();
      await store.clear(); // should not throw
      expect(store.size).toBe(0);
    });
  });

  // ── Search ─────────────────────────────────────────────────────────────

  describe("search", () => {
    beforeEach(async () => {
      if (!available) return;
      await store.clear();
      const chunks = [
        makeChunk("close to query", [1, 0.1, 0]),
        makeChunk("far from query", [0, 1, 0]),
        makeChunk("also close", [0.9, 0, 0.1]),
      ];
      await store.add(chunks);
    });

    it("returns empty array when store is empty", async () => {
      if (!available) return;
      await store.clear();
      const results = await store.search([1, 0, 0], 5);
      expect(results).toHaveLength(0);
    });

    it("returns results sorted by similarity", async () => {
      if (!available) return;
      const results = await store.search([1, 0, 0], 3);
      expect(results.length).toBeGreaterThan(0);
      // Scores should be descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it("respects topK parameter", async () => {
      if (!available) return;
      const results = await store.search([1, 0, 0], 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns chunks with source metadata", async () => {
      if (!available) return;
      const results = await store.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].chunk.sourcePath).toBe("test.md");
      expect(results[0].chunk.text).toBeTruthy();
    });
  });

  // ── Persistence ────────────────────────────────────────────────────────

  describe("persistence", () => {
    it("survives reconnection (data persists across store instances)", async () => {
      if (!available) return;

      // Create and add data
      const store1 = new ChromaVectorStore({
        url: CHROMA_URL,
        collectionName: TEST_COLLECTION,
        embeddingDimension: 3,
      });
      await store1.add([makeChunk("persistent data", [0.5, 0.5, 0])]);
      expect(store1.size).toBeGreaterThanOrEqual(1);

      // Create a NEW store instance with same collection name
      const store2 = new ChromaVectorStore({
        url: CHROMA_URL,
        collectionName: TEST_COLLECTION,
        embeddingDimension: 3,
      });

      // Should see the existing data (size > 0)
      // Trigger initialization by searching
      const results = await store2.search([0.5, 0.5, 0], 5);
      expect(results.length).toBeGreaterThan(0);
      expect(store2.size).toBeGreaterThan(0);
    });
  });
});
