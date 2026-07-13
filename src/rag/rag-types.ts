/**
 * RAG (Retrieval-Augmented Generation) type definitions.
 *
 * The RAG module provides document indexing and semantic retrieval,
 * exposed to the LLM as callable tools (`search_knowledge`, `list_knowledge_documents`).
 */

// ─── Document Loader ─────────────────────────────────────────────────────────

/**
 * Interface for loading documents from any source.
 *
 * Implementations:
 * - {@link DirectoryLoader} — local filesystem directory
 * - {@link UrlLoader} — fetch a web page
 * - {@link TextLoader} — inline text content
 *
 * Users can provide custom loaders for databases, APIs, cloud storage, etc.
 */
export interface DocumentLoader {
  /** Load documents from the source. Returns an array of RAGDocuments. */
  load(): Promise<RAGDocument[]>;
}

/**
 * A source descriptor for runtime document ingestion.
 *
 * Used by the `ingest_knowledge` tool and `RAGManager.addFromSource()`.
 * Each variant maps to a corresponding {@link DocumentLoader}:
 * - `url` → {@link UrlLoader}
 * - `text` → {@link TextLoader}
 * - `file` → loads a single file, same format support as {@link DirectoryLoader}
 */
export type DocumentSource =
  | { type: "url"; url: string; title?: string }
  | { type: "text"; content: string; title: string }
  | { type: "file"; path: string };

// ─── Documents & Chunks ──────────────────────────────────────────────────────

/** A loaded document with its original metadata. */
export interface RAGDocument {
  /** Relative path from the documents root directory. */
  path: string;
  /** Raw document text (before chunking). */
  content: string;
  /** Chunks produced by the text splitter. */
  chunks: RAGChunk[];
}

/** A single chunk of text with its embedding vector. */
export interface RAGChunk {
  /** The chunk text content. */
  text: string;
  /** The embedding vector (populated by the EmbeddingProvider). */
  embedding: number[];
  /** Source document path. */
  sourcePath: string;
  /** Zero-based chunk index within the source document. */
  chunkIndex: number;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

/**
 * Interface for generating text embeddings.
 *
 * Built-in implementation: OpenAIEmbeddingProvider (text-embedding-3-small / etc.).
 * Users can provide their own implementation for local models or other providers.
 */
export interface EmbeddingProvider {
  /** Model identifier (for logging / cost tracking). */
  readonly model: string;

  /**
   * Generate embedding vectors for the given texts.
   *
   * Batch-friendly: the implementation should send all texts in one API call
   * when the provider supports it.
   */
  embed(texts: string[]): Promise<number[][]>;

  /** Dimension of the embedding vectors this provider produces. */
  readonly dimensions: number;
}

// ─── Vector Store ────────────────────────────────────────────────────────────

/** A single search result returned by the vector store. */
export interface RAGSearchResult {
  /** The matched chunk. */
  chunk: RAGChunk;
  /** Cosine similarity score (0–1). */
  score: number;
}

/**
 * Interface for storing and searching embeddings.
 *
 * Built-in implementation: InMemoryVectorStore (cosine similarity, no deps).
 */
export interface VectorStore {
  /** Add chunks with their embeddings to the store. */
  add(chunks: RAGChunk[]): Promise<void>;

  /**
   * Search for the top-K most similar chunks to the query embedding.
   * Returns results sorted by similarity descending.
   */
  search(queryEmbedding: number[], topK: number): Promise<RAGSearchResult[]>;

  /** Number of chunks currently stored. */
  readonly size: number;

  /** Remove all chunks. */
  clear(): Promise<void>;

  /**
   * Delete all chunks belonging to a given source document.
   *
   * Optional — stores that don't support selective deletion should throw
   * an error so the caller can fall back to a full rebuild.
   *
   * @param sourcePath The document path as stored in `RAGChunk.sourcePath`.
   * @returns Number of chunks deleted (0 if none matched).
   */
  deleteBySource?(sourcePath: string): Promise<number>;
}

// ─── Re-ranker ────────────────────────────────────────────────────────────────

/**
 * Interface for re-ranking retrieved results.
 *
 * After vector search (and optionally BM25 + RRF), a re-ranker can
 * re-score the candidates using a more expensive but accurate model
 * (e.g., a Cross-Encoder or LLM).
 */
export interface ReRanker {
  /**
   * Re-rank a list of candidate results for a given query.
   *
   * @param query   The original search query.
   * @param results The candidate results to re-rank (typically 2–3× topK).
   * @returns       Re-ranked results with updated scores, sorted descending.
   */
  rerank(query: string, results: RAGSearchResult[]): Promise<RAGSearchResult[]>;
}

// ─── Manager Config ──────────────────────────────────────────────────────────

/** Configuration for the RAG module (passed via AgentConfig.rag). */
export interface RAGConfig {
  /** Path to the directory containing documents to index. */
  documentsDir: string;
  /** Provider for generating embeddings. */
  embeddingProvider: EmbeddingProvider;
  /** Maximum characters per chunk (default: 1000). */
  chunkSize?: number;
  /** Characters of overlap between adjacent chunks (default: 200). */
  chunkOverlap?: number;
  /** Number of top results to return per search (default: 5). */
  topK?: number;
  /**
   * Custom vector store instance (default: InMemoryVectorStore).
   *
   * Use this to plug in a persistent or database-backed store:
   * ```ts
   * store: new ChromaVectorStore({ embeddingDimension: 1536 })
   * ```
   */
  store?: VectorStore;

  /**
   * Enable hybrid retrieval (BM25 keyword + vector + RRF fusion).
   *
   * When true, each search runs both a vector similarity search and a BM25
   * keyword search in parallel, then merges the results using Reciprocal
   * Rank Fusion. This improves recall for queries with rare keywords or
   * domain-specific terminology.
   *
   * Default: false (pure vector search).
   */
  hybridSearch?: boolean;

  /**
   * When hybridSearch is enabled, each retrieval system fetches
   * `topK * hybridRetrievalFactor` candidates before RRF fusion.
   *
   * Higher values improve recall at a small latency cost.
   * Default: 3.
   */
  hybridRetrievalFactor?: number;

  /**
   * Optional re-ranker for post-retrieval refinement.
   *
   * After retrieval (and optionally RRF fusion), the candidate results
   * are passed to the re-ranker, which re-scores them using a more
   * accurate model (e.g., a Cross-Encoder or an LLM).
   *
   * The re-ranker receives all pre-ranked candidates and returns a
   * re-sorted list. The final top-K results are taken from the
   * re-ranker's output.
   *
   * Without a re-ranker, results are returned as-is from retrieval/RRF.
   */
  reRanker?: ReRanker;
}
