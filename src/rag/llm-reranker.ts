/**
 * LLM-based re-ranker for retrieved results.
 *
 * Uses an LLM (via the framework's LLMProvider interface) to re-score
 * candidate chunks against the original query. This is a simple, zero-new-
 * dependency alternative to a dedicated Cross-Encoder model.
 *
 * For production use with high throughput, consider replacing this with
 * a dedicated rerank API (Cohere, Jina, Voyage AI) or a locally-hosted
 * Cross-Encoder model (e.g., BAAI/bge-reranker-v2-m3 via ONNX).
 */

import type { ReRanker, RAGSearchResult } from "./rag-types";
import type { LLMProvider } from "../llm/interface";
import type { MessageData } from "../messages/types";
import { Role } from "../messages/types";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface LLMReRankerConfig {
  /** The LLM provider to use for scoring. */
  llm: LLMProvider;

  /**
   * Maximum candidates to send to the LLM in one re-rank request.
   * Default: 20. More candidates = better comparison but higher cost.
   */
  maxCandidates?: number;

  /**
   * Model to use (overrides the LLM provider's default model).
   * Useful for using a cheaper/faster model for re-ranking.
   */
  model?: string;
}

// ─── LLMReRanker ─────────────────────────────────────────────────────────────

export class LLMReRanker implements ReRanker {
  private llm: LLMProvider;
  private maxCandidates: number;

  constructor(config: LLMReRankerConfig) {
    this.llm = config.llm;
    this.maxCandidates = config.maxCandidates ?? 20;
  }

  async rerank(query: string, results: RAGSearchResult[]): Promise<RAGSearchResult[]> {
    if (results.length <= 1) return results;

    // Limit candidates to avoid huge prompts
    const candidates = results.slice(0, this.maxCandidates);

    const prompt = this.buildPrompt(query, candidates);
    const messages: MessageData[] = [
      { role: Role.User, content: prompt },
    ];

    const response = await this.llm.chat(messages);
    const content = response.content ?? "";

    // Parse scores from the LLM response
    const scores = this.parseScores(content, candidates.length);

    // Apply scores to results
    const reranked: RAGSearchResult[] = [];
    for (let i = 0; i < candidates.length; i++) {
      reranked.push({
        chunk: candidates[i].chunk,
        score: scores?.[i] ?? candidates[i].score,
      });
    }

    // Append any overflow results with original scores
    for (let i = this.maxCandidates; i < results.length; i++) {
      reranked.push({ ...results[i] });
    }

    // Sort by new score descending
    reranked.sort((a, b) => b.score - a.score);
    return reranked;
  }

  // ─── Prompt ──────────────────────────────────────────────────────────────

  private buildPrompt(query: string, results: RAGSearchResult[]): string {
    const docs = results.map((r, i) =>
      `[${i}] ${r.chunk.text.slice(0, 500)}`,
    ).join("\n\n");

    return [
      `You are a relevance scoring assistant. Given a query and a list of ${results.length} document snippets, score each snippet's relevance to the query on a scale of 0–10 (integer).`,
      "",
      "Rules:",
      "- 0 = completely irrelevant",
      "- 10 = perfectly answers the query",
      "- Score based on factual relevance, not just keyword overlap",
      "",
      `Query: ${query}`,
      "",
      "Documents:",
      docs,
      "",
      `Output ONLY a JSON array of ${results.length} integers in order [score_0, score_1, ..., score_${results.length - 1}].`,
      "Example output: [8, 3, 0, 10, 5]",
      "",
      "Scores:",
    ].join("\n");
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────

  private parseScores(raw: string, expectedCount: number): number[] | null {
    // Try to extract a JSON array from the response
    const match = raw.match(/\[[\d,\s]+\]/);
    if (!match) return null;

    try {
      const arr = JSON.parse(match[0]) as number[];
      if (!Array.isArray(arr) || arr.length !== expectedCount) return null;

      // Normalize to [0, 1]
      const normalized = arr.map((n) => Math.max(0, Math.min(1, Number(n) / 10)));
      return normalized;
    } catch {
      return null;
    }
  }
}
