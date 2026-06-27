/**
 * Built-in EmbeddingProvider implementations.
 *
 * The interface is exported from rag-types.ts so users can bring their own;
 * this file provides the OpenAI implementation out of the box.
 */

import type { EmbeddingProvider } from "./rag-types";

// ─── OpenAI Embedding Provider ───────────────────────────────────────────────

/**
 * Configuration for OpenAIEmbeddingProvider.
 */
export interface OpenAIEmbeddingConfig {
  /** OpenAI API key. */
  apiKey: string;
  /** Embedding model ID (default: "text-embedding-3-small"). */
  model?: string;
  /** Optional base URL for proxies / compatible APIs. */
  baseURL?: string;
  /** Request timeout in milliseconds (default: 30_000). */
  timeoutMs?: number;
}

/**
 * Embedding provider backed by the OpenAI embeddings API.
 *
 * Supports text-embedding-3-small (1536d), text-embedding-3-large (3072d),
 * and text-embedding-ada-002 (1536d).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private apiKey: string;
  private baseURL: string;
  private timeoutMs: number;

  constructor(config: OpenAIEmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.baseURL = config.baseURL ?? "https://api.openai.com/v1";
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.dimensions = dimensionForModel(this.model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `OpenAI Embeddings API returned ${response.status} ${response.statusText}: ${body}`,
        );
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;
      // Sort by index so results align with input order
      return json.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } catch (err: unknown) {
      if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`OpenAI Embeddings API timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dimensionForModel(model: string): number {
  if (model.startsWith("text-embedding-3-large")) return 3072;
  // text-embedding-3-small, text-embedding-ada-002, and most others are 1536
  return 1536;
}

// ─── Internal response type ──────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
  object: string;
  data: Array<{ index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}
