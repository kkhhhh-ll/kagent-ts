/**
 * Cross-Encoder re-ranker using a local ONNX model via @xenova/transformers.
 *
 * Unlike the LLMReRanker (which sends candidates to an LLM for scoring),
 * this uses a dedicated Cross-Encoder model (e.g., BGE-Reranker) that
 * evaluates the relevance of each (query, document) pair directly — faster,
 * cheaper, and more accurate than LLM-based re-ranking.
 *
 * The model is loaded lazily on the first `rerank()` call.  On first run,
 * @xenova/transformers downloads the quantized ONNX model from HuggingFace
 * Hub (~100–200 MB).  Subsequent calls reuse the cached model.
 *
 * Default model: Xenova/bge-reranker-base (quantized, English-optimized).
 * For multilingual (Chinese + English), pass:
 *   `model: "Xenova/bge-reranker-v2-m3"`
 *
 * In the standard RAG pipeline:
 *   Embedding (bi-encoder, coarse) → Retrieval → Cross-Encoder (fine) → Top-K
 */

import type { ReRanker, RAGSearchResult } from "./rag-types";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface CrossEncoderReRankerConfig {
  /**
   * Model name on HuggingFace Hub (Xenova-converted ONNX).
   *
   * Default: "Xenova/bge-reranker-base" — a quantized BGE-Reranker model
   * that balances speed and accuracy for English text.
   *
   * Alternatives:
   * - "Xenova/bge-reranker-v2-m3" — multilingual (Chinese + English), larger
   * - "Xenova/bge-reranker-large" — higher accuracy, slower
   */
  model?: string;

  /**
   * Maximum candidates to re-rank in one call.
   *
   * Default: 20.  More candidates = better comparison but slower inference.
   * Each candidate is evaluated independently as a (query, doc) pair.
   */
  maxCandidates?: number;
}

// ─── CrossEncoderReRanker ────────────────────────────────────────────────────

export class CrossEncoderReRanker implements ReRanker {
  private modelName: string;
  private maxCandidates: number;

  /**
   * The pipeline instance — lazy-loaded on first use.
   * Typed loosely to avoid importing @xenova/transformers' complex generic
   * types. The call site extracts `result[0].score` defensively.
   */
  private pipe: ((input: [string, string]) => Promise<Array<{ label: string; score: number }>>) | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: CrossEncoderReRankerConfig = {}) {
    this.modelName = config.model ?? "Xenova/bge-reranker-base";
    this.maxCandidates = config.maxCandidates ?? 20;
  }

  // ─── ReRanker impl ──────────────────────────────────────────────────────

  async rerank(query: string, results: RAGSearchResult[]): Promise<RAGSearchResult[]> {
    if (results.length <= 1) return results;

    // Limit candidates to avoid excessive inference time
    const candidates = results.slice(0, this.maxCandidates);

    // Ensure the model is loaded (lazy, cached after first call)
    await this.ensureModel();

    // Score each (query, document) pair with the cross-encoder.
    // Each call returns [{label, score}]; we extract the score.
    const scores: number[] = [];
    for (const c of candidates) {
      // Truncate document text to 512 chars — the model's max context.
      // BGE-Reranker models handle up to 512 tokens; 512 chars is a safe
      // upper bound that avoids tokenizer-specific edge cases.
      const docText = c.chunk.text.slice(0, 512);
      const result = await this.pipe!([query, docText]);
      const score = Array.isArray(result) && result.length > 0
        ? (result[0].score ?? 0)
        : 0;
      scores.push(score);
    }

    // Apply new scores
    const reranked: RAGSearchResult[] = candidates.map((c, i) => ({
      ...c,
      score: scores[i],
    }));

    // Append overflow results with original scores
    for (let i = this.maxCandidates; i < results.length; i++) {
      reranked.push({ ...results[i] });
    }

    // Sort by new score descending
    reranked.sort((a, b) => b.score - a.score);
    return reranked;
  }

  // ─── Model loading ───────────────────────────────────────────────────────

  /**
   * Ensure the cross-encoder pipeline is loaded.
   * Idempotent — subsequent calls return immediately.
   */
  private async ensureModel(): Promise<void> {
    if (this.pipe) return;
    if (!this.initPromise) {
      this.initPromise = this.loadModel();
    }
    await this.initPromise;
  }

  private async loadModel(): Promise<void> {
    try {
      // Dynamic import — @xenova/transformers is a heavy module (ONNX runtime),
      // so we only load it when actually needed.
      const { pipeline } = await import("@xenova/transformers");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.pipe = (await pipeline("text-classification", this.modelName)) as any;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CrossEncoderReRanker: Failed to load model "${this.modelName}". ` +
        `Make sure @xenova/transformers is installed and the model is available ` +
        `on HuggingFace Hub. On first run, the model (~100–200 MB) is downloaded ` +
        `and cached automatically. Original error: ${message}`,
      );
    }
  }
}
