/**
 * Reciprocal Rank Fusion (RRF) — merge multiple ranked result sets
 * into a single combined ranking.
 *
 * RRF is a simple, hyperparameter-free method for combining rankings
 * from different retrieval systems (e.g. vector search + BM25).
 *
 * Formula:
 *   RRFscore(d) = Σ_{r ∈ R} 1 / (k + rank_r(d))
 * where `k` is a smoothing constant (default 60) and `rank_r(d)` is the
 * 1-based rank position of document `d` in ranking `r`.
 *
 * Reference: Cormack et al. "Reciprocal Rank Fusion outperforms Condorcet
 * and individual rank learning methods" (SIGIR 2009).
 */

import type { RAGChunk } from "./rag-types";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single result from one retrieval system. */
export interface RankedResult {
  chunk: RAGChunk;
  score: number;
}

/** The output of RRF fusion. */
export interface RRFFusionResult {
  chunk: RAGChunk;
  rrfScore: number;
  /** Which rankings contributed to this result (bitmask: 1<<0 = vec, 1<<1 = bm25, etc.). */
  sources: number;
}

// ─── Chunk key ───────────────────────────────────────────────────────────────

/**
 * Generate a unique key for a chunk.
 * Uses sourcePath + chunkIndex to uniquely identify a chunk across rankings.
 */
export function chunkKey(chunk: RAGChunk): string {
  return `${chunk.sourcePath}#${chunk.chunkIndex}`;
}

// ─── RRF ─────────────────────────────────────────────────────────────────────

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * Each element of `rankings` is one ranked result list (best first).
 * Results from the same chunk (identified by `chunkKey`) across different
 * rankings have their RRF scores summed.
 *
 * @param rankings  Array of ranked result lists, one per retrieval system.
 * @param k         RRF smoothing constant (default: 60).
 * @param topN      Number of top results to return (default: 10).
 * @returns         Combined results sorted by RRF score descending.
 */
export function rrfFusion(
  rankings: RankedResult[][],
  k: number = 60,
  topN: number = 10,
): RRFFusionResult[] {
  // Map chunkKey → { chunk, accumulated RRF score, source bitmask }
  const fused = new Map<string, { chunk: RAGChunk; rrfScore: number; sources: number }>();

  for (let r = 0; r < rankings.length; r++) {
    const ranking = rankings[r];
    const sourceBit = 1 << r;

    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      const key = chunkKey(item.chunk);
      const rank = i + 1; // 1-based rank

      const existing = fused.get(key);
      if (existing) {
        existing.rrfScore += 1 / (k + rank);
        existing.sources |= sourceBit;
      } else {
        fused.set(key, {
          chunk: item.chunk,
          rrfScore: 1 / (k + rank),
          sources: sourceBit,
        });
      }
    }
  }

  // Sort by RRF score descending, take top-N
  return Array.from(fused.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topN);
}
