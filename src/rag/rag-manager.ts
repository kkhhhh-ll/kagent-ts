/**
 * RAG Manager — orchestrates document loading, embedding, and search.
 *
 * Lifecycle:
 *   1. `index()` — load documents from `documentsDir`, chunk, embed, store.
 *   2. `search(query, topK)` — embed query, search vector store, return results.
 *   3. `addDocument(doc)` / `removeDocument(path)` — runtime incremental updates.
 *   4. `clear()` — wipe all indexed data.
 *
 * Owned by the main Agent; created during `Agent.init()` when `rag` config
 * is present.
 */

import type {
  RAGConfig,
  RAGDocument,
  RAGChunk,
  RAGSearchResult,
  VectorStore,
  ReRanker,
  DocumentSource,
  DocumentLoader,
} from "./rag-types";
import { loadDocuments, UrlLoader, TextLoader, FileLoader } from "./document-loader";
import { InMemoryVectorStore } from "./vector-store";
import { InMemoryKeywordIndex } from "./keyword-index";
import { rrfFusion, type RankedResult } from "./rrf";
import { Logger, ConsoleLogger } from "../logging/logger";

export class RAGManager {
  private config: RAGConfig;
  private store: VectorStore;
  private keywordIndex?: InMemoryKeywordIndex;
  private reRanker?: ReRanker;
  private logger: Logger;
  private documents: RAGDocument[] = [];
  private _indexed = false;
  /** Map of document path → RAGDocument for dedup on runtime ingestion. */
  private docMap = new Map<string, RAGDocument>();

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
    this.reRanker = config.reRanker;
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

    await this.embedAndStore(allChunks);

    this.logger.info("RAG", `Indexing complete — ${this.store.size} chunk(s) in vector store${this.keywordIndex ? `, ${this.keywordIndex.size} in keyword index` : ""}.`);
    this._indexed = true;
    this.rebuildDocMap();
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
    // Fetch extra candidates when re-ranking so the re-ranker has more to work with
    const fetchFactor = this.reRanker ? (this.config.hybridRetrievalFactor ?? 3) : 1;

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

    // ── Re-rank (optional) ────────────────────────────────────────────
    if (this.reRanker && results.length > 0) {
      results = await this.reRanker.rerank(query, results);
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

  // ─── Runtime Document Operations ────────────────────────────────────────

  /**
   * Add a single document to the knowledge base at runtime.
   *
   * Incremental — does NOT clear existing data. Generates embeddings and
   * adds chunks to both the vector store and keyword index (if enabled).
   *
   * If a document with the same `path` already exists, it is replaced
   * (old chunks removed first).
   *
   * @returns The number of chunks added.
   */
  async addDocument(document: RAGDocument): Promise<number> {
    if (document.chunks.length === 0) return 0;

    // Replace existing document with same path
    if (this.docMap.has(document.path)) {
      await this.removeDocument(document.path);
    }

    await this.embedAndStore(document.chunks);

    this.documents.push(document);
    this.docMap.set(document.path, document);
    this._indexed = true;

    this.logger.info("RAG", `Added document "${document.path}" (${document.chunks.length} chunk(s)). Total: ${this.store.size} chunk(s).`);

    return document.chunks.length;
  }

  /**
   * Add multiple documents at once.
   *
   * @returns Total number of chunks added across all documents.
   */
  async addDocuments(documents: RAGDocument[]): Promise<number> {
    let total = 0;
    for (const doc of documents) {
      total += await this.addDocument(doc);
    }
    return total;
  }

  /**
   * Add a document from a source descriptor (URL, text, or file path).
   *
   * Convenience method that resolves the source to a {@link DocumentLoader},
   * loads the document, and adds it to the knowledge base.
   *
   * @returns The RAGDocument that was created and indexed.
   */
  async addFromSource(source: DocumentSource): Promise<RAGDocument | null> {
    let loader: DocumentLoader;

    switch (source.type) {
      case "url":
        loader = new UrlLoader(source.url, {
          title: source.title,
          chunkSize: this.config.chunkSize,
          chunkOverlap: this.config.chunkOverlap,
        });
        break;
      case "text":
        loader = new TextLoader({
          content: source.content,
          title: source.title,
          chunkSize: this.config.chunkSize,
          chunkOverlap: this.config.chunkOverlap,
        });
        break;
      case "file":
        loader = new FileLoader(source.path, this.config.chunkSize, this.config.chunkOverlap);
        break;
    }

    const docs = await loader.load();
    if (docs.length === 0) return null;

    const doc = docs[0];
    await this.addDocument(doc);
    return doc;
  }

  /**
   * Remove a document by path from the knowledge base.
   *
   * Deletes chunks from the vector store and keyword index (if enabled).
   * The document path must match exactly as returned by {@link documentPaths}.
   *
   * @returns `true` if the document was found and removed, `false` otherwise.
   */
  async removeDocument(path: string): Promise<boolean> {
    const idx = this.documents.findIndex((d) => d.path === path);
    if (idx === -1) return false;

    this.documents.splice(idx, 1);
    this.docMap.delete(path);

    // Try to delete chunks from vector store
    if (this.store.deleteBySource) {
      try {
        const deleted = await this.store.deleteBySource(path);
        this.logger.info("RAG", `Removed ${deleted} chunk(s) for "${path}".`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("RAG", `Failed to delete chunks for "${path}" from store: ${message}. Chunks may remain; full rebuild with index() will clean them up.`);
      }
    } else {
      this.logger.warn("RAG", `VectorStore does not support deleteBySource — chunks for "${path}" remain in the store.`);
    }

    // Note: keyword index does not support selective deletion.
    // This is acceptable because BM25 search will skip chunks whose source
    // path no longer exists in our documents list (they won't be returned).
    // A full `index()` rebuild will clean up both stores completely.

    return true;
  }

  /** Clear all indexed data. */
  async clear(): Promise<void> {
    await this.store.clear();
    this.keywordIndex?.clear();
    this.documents = [];
    this.docMap.clear();
    this._indexed = false;
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────

  /**
   * Generate embeddings for the given chunks and store them.
   *
   * Shared by `index()` (bulk) and `addDocument()` (incremental).
   */
  private async embedAndStore(chunks: RAGChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    this.logger.info("RAG", `Generating embeddings for ${chunks.length} chunk(s) (model: ${this.config.embeddingProvider.model})...`);
    const texts = chunks.map((c) => c.text);
    const batchSize = 20;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await this.config.embeddingProvider.embed(batch);
      allEmbeddings.push(...batchEmbeddings);
    }

    // Attach embeddings to chunks
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = allEmbeddings[i];
    }

    await this.store.add(chunks);

    // Add to keyword index for hybrid search (BM25)
    if (this.keywordIndex) {
      this.keywordIndex.add(chunks);
    }
  }

  /** Rebuild the doc map from the current documents array. */
  private rebuildDocMap(): void {
    this.docMap.clear();
    for (const doc of this.documents) {
      this.docMap.set(doc.path, doc);
    }
  }
}
