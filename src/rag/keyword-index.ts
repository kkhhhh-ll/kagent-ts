/**
 * In-memory BM25 keyword index.
 *
 * Builds an inverted index from chunk text during indexing and scores
 * documents against queries using the standard BM25 formula:
 *
 *   score(D, Q) = Σ IDF(qᵢ) · (f(qᵢ, D) · (k1+1)) / (f(qᵢ, D) + k1·(1 − b + b·|D|/avgdl))
 *
 * where:
 *   f(qᵢ, D) = term frequency of query term qᵢ in document D
 *   |D|       = document length (token count)
 *   avgdl     = average document length across the corpus
 *   k1        = term saturation parameter (default: 1.5)
 *   b         = length normalization parameter (default: 0.75)
 *   IDF(qᵢ)   = log((N − n(qᵢ) + 0.5) / (n(qᵢ) + 0.5) + 1)
 *
 * Zero external dependencies — pure TypeScript implementation suitable
 * for knowledge bases up to ~10K chunks.
 */

import type { RAGChunk } from "./rag-types";

// ─── BM25ScoredResult ───────────────────────────────────────────────────────

export interface BM25Result {
  chunk: RAGChunk;
  score: number;
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

/**
 * Simple multilingual tokenizer.
 *
 * Splits on word boundaries (Unicode-aware via lookbehind/lookahead for CJK
 * characters, plus standard whitespace/punctuation splitting for Latin text).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Insert spaces around CJK characters so they split into individual tokens,
  // then split on non-word characters.
  const spaced = text
    .replace(/[一-鿿㐀-䶿]/g, " $& ")
    .replace(/[぀-ゟ゠-ヿ]/g, " $& ") // Hiragana + Katakana
    .replace(/[가-힯]/g, " $& ") // Hangul
    .toLowerCase();

  for (const token of spaced.split(/[^a-z0-9一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯_]+/)) {
    const t = token.trim();
    if (t.length > 0) tokens.push(t);
  }
  return tokens;
}

// ─── BM25 Parameters ────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// ─── InMemoryKeywordIndex ────────────────────────────────────────────────────

export class InMemoryKeywordIndex {
  /** invertedIndex: word → Map<chunkId → term frequency> */
  private invertedIndex = new Map<string, Map<number, number>>();

  /** IDF values: word → idf */
  private idfValues = new Map<string, number>();

  /** Document lengths: chunkId → token count */
  private docLengths = new Map<number, number>();

  /** Average document length across the corpus. */
  private avgDocLength = 0;

  /** Total number of indexed chunks. */
  private totalDocs = 0;

  /** All chunks indexed (for retrieval). chunkId → RAGChunk */
  private chunks = new Map<number, RAGChunk>();

  /** Next chunkId. */
  private nextId = 0;

  // ─── Write ──────────────────────────────────────────────────────────────

  /**
   * Add chunks to the keyword index.
   * Recomputes IDF and avgDocLength incrementally.
   */
  add(newChunks: RAGChunk[]): void {
    for (const chunk of newChunks) {
      const id = this.nextId++;
      this.chunks.set(id, chunk);

      const tokens = tokenize(chunk.text);
      this.docLengths.set(id, tokens.length);

      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) || 0) + 1);
      }

      for (const [word, count] of tf) {
        let posting = this.invertedIndex.get(word);
        if (!posting) {
          posting = new Map();
          this.invertedIndex.set(word, posting);
        }
        posting.set(id, count);
      }
    }

    this.recomputeStats();
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /**
   * Search for the top-K chunks matching the query using BM25 scoring.
   */
  search(query: string, topK: number): BM25Result[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.totalDocs === 0) return [];

    // Aggregate BM25 scores: chunkId → score
    const scores = new Map<number, number>();

    for (const token of queryTokens) {
      const posting = this.invertedIndex.get(token);
      if (!posting) continue;

      const idf = this.idfValues.get(token) || 0;

      for (const [docId, tf] of posting) {
        const docLen = this.docLengths.get(docId) || 1;
        const numerator = tf * (BM25_K1 + 1);
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / this.avgDocLength));
        const score = idf * (numerator / denominator);

        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }

    // Sort by score descending, take top-K
    const ranked = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    // Map back to BM25Result
    return ranked
      .map(([docId, score]) => {
        const chunk = this.chunks.get(docId);
        if (!chunk) return null;
        return { chunk, score };
      })
      .filter((r): r is BM25Result => r !== null);
  }

  // ─── State ──────────────────────────────────────────────────────────────

  get size(): number {
    return this.totalDocs;
  }

  clear(): void {
    this.invertedIndex.clear();
    this.idfValues.clear();
    this.docLengths.clear();
    this.chunks.clear();
    this.avgDocLength = 0;
    this.totalDocs = 0;
    this.nextId = 0;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  private recomputeStats(): void {
    this.totalDocs = this.chunks.size;

    // Average doc length
    let totalLen = 0;
    for (const len of this.docLengths.values()) {
      totalLen += len;
    }
    this.avgDocLength = this.totalDocs > 0 ? totalLen / this.totalDocs : 1;

    // IDF
    this.idfValues.clear();
    for (const [word, posting] of this.invertedIndex) {
      const n = posting.size; // number of docs containing this word
      // Smooth IDF: log((N - n + 0.5) / (n + 0.5) + 1)
      const idf = Math.log((this.totalDocs - n + 0.5) / (n + 0.5) + 1);
      this.idfValues.set(word, idf);
    }
  }
}
