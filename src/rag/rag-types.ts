/**
 * RAG (Retrieval-Augmented Generation) type definitions.
 *
 * The RAG module provides document indexing and semantic retrieval,
 * exposed to the LLM as callable tools (`search_knowledge`, `list_knowledge_documents`).
 */

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
  add(chunks: RAGChunk[]): void;

  /**
   * Search for the top-K most similar chunks to the query embedding.
   * Returns results sorted by similarity descending.
   */
  search(queryEmbedding: number[], topK: number): RAGSearchResult[];

  /** Number of chunks currently stored. */
  readonly size: number;

  /** Remove all chunks. */
  clear(): void;
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
}
