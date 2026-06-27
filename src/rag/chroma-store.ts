/**
 * ChromaDB-backed vector store.
 *
 * Uses the `chromadb` npm package to persist embeddings to a Chroma server.
 * Chroma can run locally (embedded mode via `path`) or as a remote server
 * (e.g. `docker run -p 8000:8000 chromadb/chroma`).
 *
 * The store maintains a manual size counter (no async overhead for `size`),
 * synchronised from `Collection.count()` on construction.
 */
import type { VectorStore, RAGChunk, RAGSearchResult } from "./rag-types";
import { ChromaClient, Collection, IncludeEnum } from "chromadb";

// ─── ChromaVectorStoreConfig ────────────────────────────────────────────────

export interface ChromaVectorStoreConfig {
  /**
   * Chroma server URL (remote mode).
   * Example: "http://localhost:8000"
   *
   * Takes precedence over `path` when both are provided.
   */
  url?: string;

  /**
   * Local directory for embedded Chroma (no server needed).
   * Example: "./.chroma-data"
   *
   * Ignored when `url` is set.
   */
  path?: string;

  /**
   * Collection name (default: "kagent-rag").
   */
  collectionName?: string;

  /**
   * Embedding vector dimension (required — must match your provider).
   * OpenAI text-embedding-3-small: 1536
   * OpenAI text-embedding-3-large: 3072
   */
  embeddingDimension: number;
}

// ─── ChromaVectorStore ──────────────────────────────────────────────────────

export class ChromaVectorStore implements VectorStore {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private collectionName: string;
  private _size = 0;
  private initialized = false;

  constructor(private config: ChromaVectorStoreConfig) {
    const params: { url?: string; path?: string } = {};
    if (config.url) {
      params.url = config.url;
    } else if (config.path) {
      params.path = config.path;
    } else {
      // Default: local embedded Chroma in `.chroma-data`
      params.path = "./.chroma-data";
    }
    this.client = new ChromaClient(params);
    this.collectionName = config.collectionName ?? "kagent-rag";
  }

  // ─── VectorStore Implementation ────────────────────────────────────────

  async add(chunks: RAGChunk[]): Promise<void> {
    await this.ensureInitialized();

    const ids: string[] = [];
    const embeddings: number[][] = [];
    const metadatas: Array<Record<string, string | number | boolean>> = [];
    const documents: string[] = [];

    for (const chunk of chunks) {
      ids.push(`${chunk.sourcePath}#${chunk.chunkIndex}`);
      embeddings.push(chunk.embedding);
      metadatas.push({
        sourcePath: chunk.sourcePath,
        chunkIndex: chunk.chunkIndex,
      });
      documents.push(chunk.text);
    }

    await this.collection!.add({ ids, embeddings, metadatas, documents });
    this._size += chunks.length;
  }

  async search(queryEmbedding: number[], topK: number): Promise<RAGSearchResult[]> {
    await this.ensureInitialized();

    if (this._size === 0) return [];

    const result = await this.collection!.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      include: [IncludeEnum.Distances, IncludeEnum.Documents, IncludeEnum.Metadatas],
    });

    const ids = result.ids[0];           // Array of IDs for query 0
    const distances = result.distances?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatasArr = result.metadatas?.[0] ?? [];

    const searchResults: RAGSearchResult[] = [];
    for (let i = 0; i < ids.length; i++) {
      const distance = distances[i] ?? 0;
      // Chroma returns L2 distance by default. Convert to similarity (0–1):
      // similarity = 1 / (1 + distance)
      const score = 1 / (1 + (typeof distance === "number" ? distance : 0));

      searchResults.push({
        chunk: {
          text: documents[i] ?? "",
          embedding: queryEmbedding, // not stored in results — placeholder
          sourcePath: String(metadatasArr[i]?.sourcePath ?? ""),
          chunkIndex: Number(metadatasArr[i]?.chunkIndex ?? 0),
        },
        score,
      });
    }

    return searchResults;
  }

  get size(): number {
    return this._size;
  }

  async clear(): Promise<void> {
    if (this.collection) {
      try {
        await this.client.deleteCollection({ name: this.collectionName });
      } catch {
        // collection might not exist yet — ok
      }
      this.collection = null;
      this.initialized = false;
      this._size = 0;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.collection) return;

    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      metadata: { "description": "kagent-ts RAG documents" },
    });

    // Sync size from existing data
    const count = await this.collection.count();
    this._size = count;
    this.initialized = true;
  }
}
