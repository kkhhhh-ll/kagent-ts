/**
 * RAG Evaluator — evaluates retrieval quality using both traditional IR
 * metrics (Precision@K, Recall@K, MRR, NDCG@K) and LLM-as-judge scoring.
 *
 * Two evaluation modes, usable independently or together:
 *
 * 1. **Ground-truth mode** (`relevantChunks` on each case):
 *    Compares retrieved chunk IDs against labeled relevant chunks.
 *    Fast, deterministic, zero LLM cost. Requires a labeled dataset.
 *
 * 2. **LLM-judge mode** (`judgeLLM` in config):
 *    Uses an LLM to score each retrieved chunk's relevance to the query.
 *    No labeled data needed — works on any query. Higher cost but more
 *    flexible.
 *
 * When both are provided, the result includes both sets of metrics
 * so you can measure judge/label agreement.
 *
 * Usage:
 * ```ts
 * const evaluator = new RAGEvaluator({ ragManager, judgeLLM: smallLLM });
 *
 * const result = await evaluator.evaluate([
 *   {
 *     name: "MCP config",
 *     query: "怎么配置 MCP？",
 *     relevantChunks: ["docs/advanced/mcp.md#3", "docs/advanced/mcp.md#5"],
 *     topK: 5,
 *   },
 *   {
 *     name: "Embedding setup",
 *     query: "How to set up embeddings?",
 *     topK: 5,  // no ground truth → LLM-judged only
 *   },
 * ]);
 *
 * console.log(evaluator.generateReport(result));
 * ```
 */

import { chunkKey } from "../rag/rrf";
import type { RAGManager } from "../rag/rag-manager";
import type { RAGSearchResult } from "../rag/rag-types";
import type { LLMProvider } from "../llm/interface";
import type { MessageData } from "../messages/types";
import { Role } from "../messages/types";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single RAG evaluation test case. */
export interface RAGEvalCase {
  /** Human-readable name. */
  name: string;
  /** The search query to evaluate. */
  query: string;
  /**
   * Ground-truth relevant chunk identifiers in `"sourcePath#chunkIndex"` format.
   *
   * Use the helper `chunkKey(chunk)` from `src/rag/rrf.ts` to generate these
   * from your labeled data.
   *
   * When provided, Precision@K / Recall@K / MRR / NDCG@K are computed
   * against this ground truth.
   */
  relevantChunks?: string[];
  /** Number of results to retrieve (default: uses evaluator's defaultTopK). */
  topK?: number;
}

/** LLM judgment for a single retrieved chunk. */
export interface ChunkJudgment {
  /** Chunk identifier in `"sourcePath#chunkIndex"` format. */
  chunkId: string;
  /** Source document path. */
  sourcePath: string;
  /** Zero-based chunk index within the document. */
  chunkIndex: number;
  /** Whether the LLM judge considers this chunk relevant. */
  relevant: boolean;
  /** Relevance score (0–10, integer). */
  score: number;
  /** Brief explanation of the judgment. */
  reasoning: string;
}

/** Metrics computed for a single evaluation case. */
export interface RAGRetrievalMetrics {
  // ── Ground-truth based (available when relevantChunks provided) ────
  /** Precision@K: |retrieved ∩ relevant| / K. */
  precisionAtK: number;
  /** Recall@K: |retrieved ∩ relevant| / |relevant|. */
  recallAtK: number;
  /** Mean Reciprocal Rank: 1 / rank of first relevant result (0 if none). */
  mrr: number;
  /** Normalized Discounted Cumulative Gain at K (binary relevance). */
  ndcgAtK: number;

  // ── LLM-judge based (available when judgeLLM configured) ──────────
  /** Precision@K using LLM judgments as relevance labels. */
  llmPrecisionAtK?: number;
  /** NDCG@K using LLM scores (0–10) as graded relevance. */
  llmNdcgAtK?: number;
  /** Average LLM relevance score (0–10) across the K retrieved chunks. */
  avgRelevanceScore?: number;

  // ── Agreement (when both ground truth and LLM judge available) ────
  /**
   * Cohen's kappa between ground-truth labels and LLM binary judgments.
   * Only computed when both sources are present.
   */
  judgeLabelAgreement?: number;
}

/** Result for a single RAG evaluation case. */
export interface RAGCaseResult {
  /** The case name (from RAGEvalCase). */
  caseName: string;
  /** The query that was searched. */
  query: string;
  /** Number of results requested. */
  topK: number;
  /** Retrieved chunks with scores (in order). */
  retrieved: RAGSearchResult[];
  /** Per-chunk LLM judgments (when judgeLLM configured). */
  judgments?: ChunkJudgment[];
  /** Computed metrics. */
  metrics: RAGRetrievalMetrics;
}

/** Aggregate summary across all evaluation cases. */
export interface RAGEvalSummary {
  /** Number of cases evaluated. */
  totalCases: number;
  /** Number of cases with ground-truth labels. */
  casesWithGroundTruth: number;
  /** Number of cases with LLM judgments. */
  casesWithLLMJudgments: number;

  // ── Averaged ground-truth metrics ─────────────────────────────────
  avgPrecisionAtK: number;
  avgRecallAtK: number;
  avgMRR: number;
  avgNdcgAtK: number;

  // ── Averaged LLM-judge metrics ────────────────────────────────────
  avgLlmPrecisionAtK?: number;
  avgLlmNdcgAtK?: number;
  avgRelevanceScore?: number;

  // ── Agreement ─────────────────────────────────────────────────────
  avgJudgeLabelAgreement?: number;
}

/** Full RAG evaluation result. */
export interface RAGEvalResult {
  summary: RAGEvalSummary;
  cases: RAGCaseResult[];
}

/** Configuration for the RAG evaluator. */
export interface RAGEvaluatorConfig {
  /** The RAG manager to evaluate (must already be indexed). */
  ragManager: RAGManager;

  /**
   * Optional LLM provider for judging chunk relevance.
   *
   * When provided, each retrieved chunk is independently scored by the
   * LLM for relevance to the query. Use a small/fast model here to
   * control cost (e.g. gpt-4o-mini, haiku).
   *
   * When omitted, only ground-truth metrics are computed. Cases without
   * `relevantChunks` will have zeroed ground-truth metrics.
   */
  judgeLLM?: LLMProvider;

  /** Default top-K for cases that don't specify it (default: 5). */
  defaultTopK?: number;
}

// ─── LLM Judge Prompt ───────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an impartial retrieval relevance judge. Your job is to assess
whether each retrieved document chunk is relevant to a search query.

For each chunk, determine:
- **relevant** (true/false): Does this chunk contain information that helps
  answer the query? Even partial relevance counts as true — only mark false
  if the chunk is completely unrelated.
- **score** (0–10 integer): How relevant is this chunk?
  0 = completely irrelevant
  10 = perfectly answers the query
- **reasoning**: One short sentence explaining the judgment.

Output a JSON array with one object per chunk:
[
  {"chunkIndex": 0, "relevant": true, "score": 8, "reasoning": "Explains MCP config steps clearly."},
  {"chunkIndex": 1, "relevant": false, "score": 1, "reasoning": "Discusses unrelated topic."}
]

Output ONLY the JSON array — no markdown fences, no extra text.`;

// ─── RAGEvaluator ───────────────────────────────────────────────────────────

export class RAGEvaluator {
  private ragManager: RAGManager;
  private judgeLLM?: LLMProvider;
  private defaultTopK: number;

  constructor(config: RAGEvaluatorConfig) {
    this.ragManager = config.ragManager;
    this.judgeLLM = config.judgeLLM;
    this.defaultTopK = config.defaultTopK ?? 5;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Evaluate retrieval quality across all test cases.
   *
   * For each case, calls `ragManager.search()` then computes metrics.
   * When `judgeLLM` is configured, also runs per-chunk relevance judgments.
   */
  async evaluate(cases: RAGEvalCase[]): Promise<RAGEvalResult> {
    const results: RAGCaseResult[] = [];

    for (const c of cases) {
      const topK = c.topK ?? this.defaultTopK;
      const retrieved = await this.ragManager.search(c.query, topK);

      // ── LLM judging (when configured) ──────────────────────────────
      let judgments: ChunkJudgment[] | undefined;
      if (this.judgeLLM && retrieved.length > 0) {
        try {
          judgments = await this.judgeChunks(c.query, retrieved);
        } catch {
          // Judge failed — leave judgments undefined
        }
      }

      // ── Compute metrics ────────────────────────────────────────────
      const metrics = this.computeMetrics(
        c.relevantChunks,
        retrieved,
        judgments,
        topK,
      );

      results.push({
        caseName: c.name,
        query: c.query,
        topK,
        retrieved: this.sanitizeResults(retrieved),
        judgments,
        metrics,
      });
    }

    const summary = this.buildSummary(results);

    return { summary, cases: results };
  }

  /**
   * Generate a Markdown report from evaluation results.
   */
  generateReport(result: RAGEvalResult): string {
    const s = result.summary;

    let report = `# RAG Retrieval Evaluation Report\n\n`;

    // Summary
    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Total Cases | ${s.totalCases} |\n`;
    report += `| Cases with Ground Truth | ${s.casesWithGroundTruth} |\n`;
    report += `| Cases with LLM Judgments | ${s.casesWithLLMJudgments} |\n`;
    report += `\n`;

    // Ground-truth metrics
    if (s.casesWithGroundTruth > 0) {
      report += `### Ground-Truth Metrics\n\n`;
      report += `| Metric | Average |\n`;
      report += `|--------|--------|\n`;
      report += `| Precision@K | ${s.avgPrecisionAtK.toFixed(3)} |\n`;
      report += `| Recall@K | ${s.avgRecallAtK.toFixed(3)} |\n`;
      report += `| MRR | ${s.avgMRR.toFixed(3)} |\n`;
      report += `| NDCG@K | ${s.avgNdcgAtK.toFixed(3)} |\n`;
      report += `\n`;
    }

    // LLM-judge metrics
    if (s.casesWithLLMJudgments > 0) {
      report += `### LLM-Judge Metrics\n\n`;
      report += `| Metric | Average |\n`;
      report += `|--------|--------|\n`;
      report += `| LLM Precision@K | ${(s.avgLlmPrecisionAtK ?? 0).toFixed(3)} |\n`;
      report += `| LLM NDCG@K | ${(s.avgLlmNdcgAtK ?? 0).toFixed(3)} |\n`;
      report += `| Avg Relevance Score | ${(s.avgRelevanceScore ?? 0).toFixed(1)} / 10 |\n`;
      report += `\n`;

      if (s.avgJudgeLabelAgreement !== undefined) {
        report += `| Judge-Label Agreement (κ) | ${s.avgJudgeLabelAgreement.toFixed(3)} |\n`;
        report += `\n`;
      }
    }

    // Per-case details
    report += `## Per-Case Results\n\n`;

    for (const r of result.cases) {
      const m = r.metrics;
      report += `### ${r.caseName}\n\n`;
      report += `**Query:** "${r.query}" | **K:** ${r.topK}\n\n`;

      // Metrics table
      report += `| Source | Precision@K | Recall@K | MRR | NDCG@K | Avg Score |\n`;
      report += `|--------|-------------|----------|-----|--------|----------|\n`;

      const gtRow =
        r.retrieved.length > 0 && r.caseName // ground truth available implicitly
          ? `| Ground Truth | ${m.precisionAtK.toFixed(3)} | ${m.recallAtK.toFixed(3)} | ${m.mrr.toFixed(3)} | ${m.ndcgAtK.toFixed(3)} | — |`
          : null;

      // Only show ground-truth row when relevantChunks was provided
      if (gtRow) {
        // We can't directly check if relevantChunks was provided since we
        // don't store it.  Show the row when metrics are non-zero or when
        // we have judgments (implying both modes ran).
        const hasGroundTruth = m.precisionAtK > 0 || m.recallAtK > 0 || m.mrr > 0;
        if (hasGroundTruth || r.judgments) {
          report += `| Ground Truth | ${m.precisionAtK.toFixed(3)} | ${m.recallAtK.toFixed(3)} | ${m.mrr.toFixed(3)} | ${m.ndcgAtK.toFixed(3)} | — |\n`;
        }
      }

      if (m.llmPrecisionAtK !== undefined) {
        report += `| LLM Judge | ${m.llmPrecisionAtK.toFixed(3)} | — | — | ${(m.llmNdcgAtK ?? 0).toFixed(3)} | ${(m.avgRelevanceScore ?? 0).toFixed(1)}/10 |\n`;
      }

      if (m.judgeLabelAgreement !== undefined) {
        report += `\n**Judge-Label Agreement (κ):** ${m.judgeLabelAgreement.toFixed(3)}\n`;
      }

      // Retrieved chunks
      report += `\n**Retrieved Chunks:**\n\n`;
      report += `| # | Source | Score |\n`;
      report += `|---|--------|-------|\n`;
      for (let i = 0; i < r.retrieved.length; i++) {
        const chunk = r.retrieved[i];
        const path = chunk.chunk.sourcePath;
        const idx = chunk.chunk.chunkIndex;
        report += `| ${i + 1} | \`${path}#${idx}\` | ${chunk.score.toFixed(3)} |\n`;
      }

      // LLM judgments (collapsed)
      if (r.judgments && r.judgments.length > 0) {
        report += `\n<details>\n<summary>LLM Judgments</summary>\n\n`;
        report += `| # | Chunk | Relevant | Score | Reasoning |\n`;
        report += `|---|-------|----------|-------|----------|\n`;
        for (const j of r.judgments) {
          const icon = j.relevant ? "✅" : "❌";
          report += `| ${j.chunkIndex} | \`${j.sourcePath}#${j.chunkIndex}\` | ${icon} | ${j.score}/10 | ${j.reasoning} |\n`;
        }
        report += `\n</details>\n`;
      }

      report += `\n`;
    }

    report += `---\n*Generated at ${new Date().toISOString()}*\n`;
    return report;
  }

  // ─── Private: LLM Judging ────────────────────────────────────────────────

  private async judgeChunks(
    query: string,
    retrieved: RAGSearchResult[],
  ): Promise<ChunkJudgment[]> {
    if (!this.judgeLLM) return [];

    const chunksForJudging = retrieved.map((r, i) =>
      `[Chunk ${i}] (${r.chunk.sourcePath}#${r.chunk.chunkIndex})\n${r.chunk.text.slice(0, 800)}`,
    ).join("\n\n---\n\n");

    const messages: MessageData[] = [
      { role: Role.System, content: JUDGE_SYSTEM_PROMPT },
      {
        role: Role.User,
        content: [
          `Query: ${query}`,
          ``,
          `Retrieved chunks (in rank order):`,
          ``,
          chunksForJudging,
          ``,
          `Judge each chunk's relevance. Output JSON array only.`,
        ].join("\n"),
      },
    ];

    const response = await this.judgeLLM.chat(messages);
    const parsed = this.parseJudgments(response.content, retrieved.length);

    return retrieved.map((r, i) => {
      const judgment = parsed[i];
      return {
        chunkId: chunkKey(r.chunk),
        sourcePath: r.chunk.sourcePath,
        chunkIndex: r.chunk.chunkIndex,
        relevant: judgment?.relevant ?? false,
        score: judgment?.score ?? 0,
        reasoning: judgment?.reasoning ?? "",
      };
    });
  }

  private parseJudgments(
    raw: string,
    expectedCount: number,
  ): Array<{ relevant: boolean; score: number; reasoning: string }> {
    // Try to extract JSON from the response (handles markdown fences and
    // leading/trailing text).
    try {
      let json = raw.trim();

      // Strip markdown code fences if present
      const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) json = fenceMatch[1];

      // Find the outermost JSON array
      const arrayMatch = json.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrayMatch) json = arrayMatch[0];

      const arr = JSON.parse(json) as Array<Record<string, unknown>>;

      if (!Array.isArray(arr)) return [];

      return arr.slice(0, expectedCount).map((item) => ({
        relevant: Boolean(item.relevant),
        score: Math.max(0, Math.min(10, Math.round(Number(item.score) || 0))),
        reasoning: String(item.reasoning ?? ""),
      }));
    } catch {
      return [];
    }
  }

  // ─── Private: Metrics ────────────────────────────────────────────────────

  private computeMetrics(
    relevantChunks: string[] | undefined,
    retrieved: RAGSearchResult[],
    judgments: ChunkJudgment[] | undefined,
    k: number,
  ): RAGRetrievalMetrics {
    const hasGroundTruth = relevantChunks && relevantChunks.length > 0;
    const hasJudgments = judgments && judgments.length > 0;

    // ── Ground-truth metrics ──────────────────────────────────────────
    let precisionAtK = 0;
    let recallAtK = 0;
    let mrr = 0;
    let ndcgAtK = 0;

    if (hasGroundTruth && retrieved.length > 0) {
      const relevantSet = new Set(relevantChunks);
      const retrievedIds = retrieved.map((r) => chunkKey(r.chunk));

      // Precision@K
      const hitCount = retrievedIds.filter((id) => relevantSet.has(id)).length;
      precisionAtK = hitCount / Math.min(k, retrieved.length);

      // Recall@K
      recallAtK = hitCount / relevantSet.size;

      // MRR
      for (let i = 0; i < retrievedIds.length; i++) {
        if (relevantSet.has(retrievedIds[i])) {
          mrr = 1 / (i + 1);
          break;
        }
      }

      // NDCG@K (binary relevance: 1 if relevant, 0 otherwise)
      ndcgAtK = this.computeBinaryNdcg(retrievedIds, relevantSet, k);
    }

    // ── LLM-judge metrics ─────────────────────────────────────────────
    let llmPrecisionAtK: number | undefined;
    let llmNdcgAtK: number | undefined;
    let avgRelevanceScore: number | undefined;
    let judgeLabelAgreement: number | undefined;

    if (hasJudgments) {
      const judgedRelevant = judgments.filter((j) => j.relevant).length;
      llmPrecisionAtK = judgedRelevant / Math.min(k, judgments.length);

      // LLM NDCG using relevance scores (0–10) as graded gains
      llmNdcgAtK = this.computeGradedNdcg(judgments, k);

      // Average relevance score
      const scores = judgments.map((j) => j.score);
      avgRelevanceScore =
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0;

      // Judge-label agreement (Cohen's kappa) when both available
      if (hasGroundTruth) {
        judgeLabelAgreement = this.computeAgreement(
          relevantChunks!,
          judgments,
        );
      }
    }

    return {
      precisionAtK,
      recallAtK,
      mrr,
      ndcgAtK,
      llmPrecisionAtK,
      llmNdcgAtK,
      avgRelevanceScore,
      judgeLabelAgreement,
    };
  }

  /**
   * Compute NDCG@K with binary relevance (1 = relevant, 0 = not).
   */
  private computeBinaryNdcg(
    retrievedIds: string[],
    relevantSet: Set<string>,
    k: number,
  ): number {
    const limit = Math.min(k, retrievedIds.length);
    if (limit === 0) return 0;

    // DCG: Σ (2^rel_i - 1) / log2(i + 2)   (i is 0-based rank)
    let dcg = 0;
    for (let i = 0; i < limit; i++) {
      const rel = relevantSet.has(retrievedIds[i]) ? 1 : 0;
      dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }

    // IDCG: ideal ordering (all relevant docs first)
    const idealRelCount = Math.min(relevantSet.size, limit);
    let idcg = 0;
    for (let i = 0; i < idealRelCount; i++) {
      idcg += 1 / Math.log2(i + 2); // rel=1 for each relevant doc
    }

    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Compute NDCG@K with graded relevance from LLM scores (0–10).
   *
   * Scores are normalized to [0, 1] before computing gains.
   */
  private computeGradedNdcg(judgments: ChunkJudgment[], k: number): number {
    const limit = Math.min(k, judgments.length);
    if (limit === 0) return 0;

    // Normalize scores to [0, 1]
    const gains = judgments.slice(0, limit).map((j) => j.score / 10);

    // DCG
    let dcg = 0;
    for (let i = 0; i < limit; i++) {
      dcg += (Math.pow(2, gains[i]) - 1) / Math.log2(i + 2);
    }

    // IDCG: sort gains descending for ideal ordering
    const ideal = [...gains].sort((a, b) => b - a);
    let idcg = 0;
    for (let i = 0; i < ideal.length; i++) {
      idcg += (Math.pow(2, ideal[i]) - 1) / Math.log2(i + 2);
    }

    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Compute Cohen's kappa between ground-truth labels and LLM binary judgments.
   *
   * κ = (p_o - p_e) / (1 - p_e)
   *
   * where p_o = observed agreement, p_e = expected agreement by chance.
   */
  private computeAgreement(
    relevantChunks: string[],
    judgments: ChunkJudgment[],
  ): number {
    const relevantSet = new Set(relevantChunks);
    const n = judgments.length;
    if (n === 0) return 0;

    // Build contingency table
    let a = 0; // both say relevant
    let b = 0; // ground truth: relevant, judge: not
    let c = 0; // ground truth: not, judge: relevant
    let d = 0; // both say not

    for (const j of judgments) {
      const gtRelevant = relevantSet.has(j.chunkId);
      const jRelevant = j.relevant;

      if (gtRelevant && jRelevant) a++;
      else if (gtRelevant && !jRelevant) b++;
      else if (!gtRelevant && jRelevant) c++;
      else d++;
    }

    // Observed agreement
    const p_o = (a + d) / n;

    // Expected agreement
    const p_gt_rel = (a + b) / n; // proportion GT says relevant
    const p_gt_not = (c + d) / n;
    const p_j_rel = (a + c) / n;  // proportion judge says relevant
    const p_j_not = (b + d) / n;
    const p_e = p_gt_rel * p_j_rel + p_gt_not * p_j_not;

    if (p_e >= 1) return 1;
    return (p_o - p_e) / (1 - p_e);
  }

  // ─── Private: Helpers ────────────────────────────────────────────────────

  /**
   * Strip embedding vectors from results to keep output sizes manageable.
   */
  private sanitizeResults(results: RAGSearchResult[]): RAGSearchResult[] {
    return results.map((r) => ({
      chunk: {
        ...r.chunk,
        embedding: [], // strip embedding vectors from eval output
      },
      score: r.score,
    }));
  }

  /**
   * Build the aggregate summary from individual case results.
   */
  private buildSummary(results: RAGCaseResult[]): RAGEvalSummary {
    const total = results.length;

    // Identify which cases have ground truth / LLM judgments
    const gtCases = results.filter(
      (r) => r.metrics.precisionAtK > 0 || r.metrics.recallAtK > 0 || r.metrics.mrr > 0,
    );
    const llmCases = results.filter((r) => r.metrics.llmPrecisionAtK !== undefined);

    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const summary: RAGEvalSummary = {
      totalCases: total,
      casesWithGroundTruth: gtCases.length,
      casesWithLLMJudgments: llmCases.length,

      avgPrecisionAtK: avg(results.map((r) => r.metrics.precisionAtK)),
      avgRecallAtK: avg(results.map((r) => r.metrics.recallAtK)),
      avgMRR: avg(results.map((r) => r.metrics.mrr)),
      avgNdcgAtK: avg(results.map((r) => r.metrics.ndcgAtK)),
    };

    if (llmCases.length > 0) {
      summary.avgLlmPrecisionAtK = avg(
        llmCases.map((r) => r.metrics.llmPrecisionAtK ?? 0),
      );
      summary.avgLlmNdcgAtK = avg(
        llmCases.map((r) => r.metrics.llmNdcgAtK ?? 0),
      );
      summary.avgRelevanceScore = avg(
        llmCases.map((r) => r.metrics.avgRelevanceScore ?? 0),
      );
    }

    // Agreement: only for cases that have both
    const agreementValues = results
      .filter((r) => r.metrics.judgeLabelAgreement !== undefined)
      .map((r) => r.metrics.judgeLabelAgreement!);
    if (agreementValues.length > 0) {
      summary.avgJudgeLabelAgreement = avg(agreementValues);
    }

    return summary;
  }
}
