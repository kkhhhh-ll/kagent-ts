/**
 * RAG Manager — orchestrates document loading, embedding, and search.
 *
 * Lifecycle:
 *   1. `index()` — load documents from `documentsDir`, chunk, embed, store.
 *   2. `search(query, topK)` — embed query, search vector store, return results.
 *   3. `clear()` — wipe all indexed data.
 *
 * Owned by the main Agent; created during `Agent.init()` when `rag` config
 * is present.
 */

import type {
  RAGConfig,
  RAGDocument,
  RAGSearchResult,
  VectorStore,
  ReRanker,
} from "./rag-types";
import { loadDocuments } from "./document-loader";
import { InMemoryVectorStore } from "./vector-store";
import { InMemoryKeywordIndex } from "./keyword-index";
import { rrfFusion, chunkKey, type RankedResult } from "./rrf";
import { CrossEncoderReRanker } from "./cross-encoder-reranker";
import { Logger, ConsoleLogger } from "../logging/logger";

export class RAGManager {
  private config: RAGConfig;
  private store: VectorStore;
  private keywordIndex?: InMemoryKeywordIndex;
  private reRanker?: ReRanker | null;
  private logger: Logger;
  private documents: RAGDocument[] = [];
  private _indexed = false;

  constructor(config: RAGConfig, logger?: Logger) {
    this.config = {
      chunkSize: 1000,
      chunkOverlap: 200,
      topK: 5,
      ...config,
    };
    this.store = config.store ?? new InMemoryVectorStore();
    if (this.config.hybridSearch) {
      this.keywordIndex = new InMemoryKeywordIndex();
    }
    // Default to CrossEncoderReRanker unless user explicitly set reRanker
    // (pass `reRanker: null` to disable re-ranking entirely).
    if ("reRanker" in config) {
      this.reRanker = config.reRanker;
    } else {
      this.reRanker = new CrossEncoderReRanker();
    }
    this.logger = logger ?? new ConsoleLogger();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Whether the index has been built. */
  get indexed(): boolean {
    return this._indexed;
  }

  /** Number of chunks in the store. */
  get chunkCount(): number {
    return this.store.size;
  }

  /** Number of documents loaded. */
  get documentCount(): number {
    return this.documents.length;
  }

  /** List of indexed document paths. */
  get documentPaths(): string[] {
    return this.documents.map((d) => d.path);
  }

  /**
   * Load documents, generate embeddings, and populate the vector store.
   *
   * Idempotent — if already indexed, calling again clears and rebuilds.
   */
  async index(): Promise<void> {
    await this.clear();

    this.logger.info("RAG", `Loading documents from "${this.config.documentsDir}"...`);
    this.documents = loadDocuments(
      this.config.documentsDir,
      this.config.chunkSize!,
      this.config.chunkOverlap!,
    );

    if (this.documents.length === 0) {
      this.logger.warn("RAG", `No supported documents found in "${this.config.documentsDir}".`);
      this._indexed = true;
      return;
    }

    const allChunks = this.documents.flatMap((d) => d.chunks);
    this.logger.info(
      "RAG",
      `Loaded ${this.documents.length} document(s), ${allChunks.length} chunk(s).`,
    );

    if (allChunks.length === 0) {
      this._indexed = true;
      return;
    }

    // Generate embeddings in batches
    this.logger.info("RAG", `Generating embeddings (model: ${this.config.embeddingProvider.model})...`);
    const texts = allChunks.map((c) => c.text);
    const batchSize = 20;
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await this.config.embeddingProvider.embed(batch);
      embeddings.push(...batchEmbeddings);
    }

    // Attach embeddings to chunks
    for (let i = 0; i < allChunks.length; i++) {
      allChunks[i].embedding = embeddings[i];
    }

    await this.store.add(allChunks);

    // Build keyword index for hybrid search (BM25)
    if (this.keywordIndex) {
      this.keywordIndex.add(allChunks);
    }

    this.logger.info("RAG", `Indexing complete — ${this.store.size} chunk(s) in vector store${this.keywordIndex ? `, ${this.keywordIndex.size} in keyword index` : ""}.`);
    this._indexed = true;
  }

  /**
   * Search the knowledge base for chunks relevant to the query.
   *
   * In hybrid mode (hybridSearch: true), runs both vector similarity and
   * BM25 keyword search in parallel, then merges results via RRF.
   *
   * @param query Natural-language search query.
   * @param topK  Number of results to return (overrides config default).
   */
  async search(query: string, topK?: number): Promise<RAGSearchResult[]> {
    if (!this._indexed || this.store.size === 0) {
      return [];
    }

    const k = topK ?? this.config.topK ?? 5;
    // Fetch extra candidates when using hybrid search or re-ranking,
    // so the downstream step (RRF fusion / LLM re-ranker) has more to work with.
    const fetchFactor = (this.keywordIndex || this.reRanker)
      ? (this.config.hybridRetrievalFactor ?? 3)
      : 1;

    let results: RAGSearchResult[];

    // ── Hybrid mode: vector + BM25 → RRF fusion ──────────────────────
    if (this.keywordIndex) {
      const fetchK = k * fetchFactor;

      const [queryEmbedding] = await this.config.embeddingProvider.embed([query]);
      if (!queryEmbedding) return [];

      const [vectorResults, bm25Results] = await Promise.all([
        this.store.search(queryEmbedding, fetchK),
        this.keywordIndex.search(query, fetchK),
      ]);

      const vecRanking: RankedResult[] = vectorResults.map((r) => ({
        chunk: r.chunk,
        score: r.score,
      }));
      const bm25Ranking: RankedResult[] = bm25Results.map((r) => ({
        chunk: r.chunk,
        score: r.score,
      }));

      const fused = rrfFusion([vecRanking, bm25Ranking], 60, fetchK);

      results = fused.map((f) => ({
        chunk: f.chunk,
        score: f.rrfScore,
      }));
    } else {
      // ── Pure vector mode ─────────────────────────────────────────
      const fetchK = k * fetchFactor;
      const [queryEmbedding] = await this.config.embeddingProvider.embed([query]);
      if (!queryEmbedding) return [];
      results = await this.store.search(queryEmbedding, fetchK);
    }

    // ── Re-rank (default: Cross-Encoder) ───────────────────────────────
    //
    // When both hybrid search AND re-rank are enabled, RRF fusion acts as a
    // candidate-pool selector (merging + deduplicating the two retrieval
    // paths with a ranking bias toward chunks that appear in both).  The
    // re-ranker then re-scores this pool from scratch.  RRF scores are
    // intentionally discarded — the re-ranker's semantic relevance judgment
    // is more accurate than the RRF formula for the final ordering.
    //
    // If the re-ranker fails (e.g. model not downloaded yet, disk full),
    // we log a warning and return the un-ranked results rather than crashing
    // the search.  The quality degrades but the system stays available.
    if (this.reRanker && results.length > 0) {
      try {
        results = await this.reRanker.rerank(query, results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("RAG", `Re-ranker failed, returning un-ranked results: ${message}`);
        // results unchanged — continue with original retrieval scores
      }
    }

    // Take final top-K
    return results.slice(0, k);
  }

  /**
   * Format search results for injection into the LLM context.
   */
  formatResults(results: RAGSearchResult[]): string {
    if (results.length === 0) {
      return "No relevant documents found in the knowledge base.";
    }

    const lines: string[] = [];
    lines.push(`Found ${results.length} relevant document chunk(s):\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`### [${i + 1}] ${r.chunk.sourcePath} (chunk ${r.chunk.chunkIndex + 1}, score: ${r.score.toFixed(3)})`);
      lines.push(r.chunk.text);
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Clear all indexed data. */
  async clear(): Promise<void> {
    await this.store.clear();
    this.keywordIndex?.clear();
    this.documents = [];
    this._indexed = false;
  }
}
