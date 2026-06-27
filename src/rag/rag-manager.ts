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
} from "./rag-types";
import { loadDocuments } from "./document-loader";
import { InMemoryVectorStore } from "./vector-store";
import { Logger, ConsoleLogger } from "../logging/logger";

export class RAGManager {
  private config: RAGConfig;
  private store: VectorStore;
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
    this.store = new InMemoryVectorStore();
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
    this.clear();

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

    this.store.add(allChunks);
    this.logger.info("RAG", `Indexing complete — ${this.store.size} chunk(s) in vector store.`);
    this._indexed = true;
  }

  /**
   * Search the knowledge base for chunks relevant to the query.
   *
   * @param query Natural-language search query.
   * @param topK  Number of results to return (overrides config default).
   */
  async search(query: string, topK?: number): Promise<RAGSearchResult[]> {
    if (!this._indexed || this.store.size === 0) {
      return [];
    }

    const k = topK ?? this.config.topK ?? 5;
    const [queryEmbedding] = await this.config.embeddingProvider.embed([query]);
    return this.store.search(queryEmbedding, k);
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
  clear(): void {
    this.store.clear();
    this.documents = [];
    this._indexed = false;
  }
}
