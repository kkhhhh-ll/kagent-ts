/**
 * Lightweight BM25 retriever for memories and skills.
 *
 * Maintains two separate {@link InMemoryKeywordIndex} instances so memory
 * and skill retrieval are independent — same engine, different corpora.
 *
 * Memories are re-indexed every run (~0.5ms for 200 docs). Skills are
 * indexed once and reused via a dirty flag — call {@link invalidateSkillIndex}
 * when new skills are registered.
 *
 * Zero external dependencies — pure TypeScript + the existing BM25 index.
 */

import { InMemoryKeywordIndex } from "./keyword-index";
import type { Memory } from "../memory/memory-manager";
import type { Skill } from "../skills/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RetrievedSkill {
  skill: Skill;
  /** BM25 score (higher = more relevant). */
  score: number;
}

export interface RetrievedMemory {
  memory: Memory;
  /** BM25 score (higher = more relevant). */
  score: number;
}

/**
 * Two-pronged score filter to prevent injecting noise.
 *
 * A result is kept only when BOTH conditions hold:
 * 1. Relative: score >= topScore * MIN_SCORE_RATIO
 * 2. Absolute: score >= MIN_ABSOLUTE_SCORE
 *
 * The ratio filter removes long-tail results when there IS a strong match.
 * The absolute floor catches the "no match at all" case — when the best
 * score is 0.4 (common words only), ratio alone would keep everything;
 * the floor filters them all out.
 *
 * | Scenario                    | Top score | Ratio threshold | Kept |
 * |-----------------------------|-----------|-----------------|------|
 * | "用 pnpm 装 React"          | 12.4      | 1.24            | 3-4  |
 * | "帮我写个 for 循环" (无关)  | 0.4       | 1.0 (floor)     | 0    |
 */
const MIN_SCORE_RATIO = 0.1;
const MIN_ABSOLUTE_SCORE = 1.5;

// ─── Retriever ───────────────────────────────────────────────────────────────

export class Retriever {
  private memoryIdx = new InMemoryKeywordIndex();
  private skillIdx = new InMemoryKeywordIndex();

  /** Map sourcePath (memory name) → Memory. Rebuilt on each indexMemories(). */
  private memoryMap = new Map<string, Memory>();
  /** Map sourcePath (skill name) → Skill. Rebuilt on each indexSkills(). */
  private skillMap = new Map<string, Skill>();

  /**
   * Whether the skill index needs rebuilding.
   *
   * Skills are indexed once and reused across runs (they change rarely).
   * Call {@link invalidateSkillIndex} when new skills are registered via
   * `reloadFromDirectory()` to force a rebuild next time.
   */
  private skillIndexDirty = true;

  // ─── Indexing ───────────────────────────────────────────────────────────

  /**
   * Rebuild the memory index from the current MemoryManager state.
   *
   * Each memory is indexed as one document: `name + description + content`.
   * The `sourcePath` is the memory name, used to map results back.
   */
  indexMemories(memories: Memory[]): void {
    this.memoryIdx.clear();
    this.memoryMap.clear();

    if (memories.length === 0) return;

    const chunks = memories.map((m) => ({
      text: `${m.name}\n${m.description}\n${m.content}`,
      embedding: [] as number[],
      sourcePath: m.name,
      chunkIndex: 0,
    }));

    this.memoryIdx.add(chunks);
    for (const m of memories) {
      this.memoryMap.set(m.name, m);
    }
  }

  /**
   * Rebuild the skill index.
   *
   * Each skill is indexed as one document: `name + description + systemPrompt`.
   *
   * No-op when the index is already built and not dirty — skills change
   * infrequently, so we index once and reuse. Call {@link invalidateSkillIndex}
   * after `reloadFromDirectory()` to force a rebuild.
   */
  indexSkills(skills: Skill[]): void {
    if (!this.skillIndexDirty) return;

    this.skillIdx.clear();
    this.skillMap.clear();
    this.skillIndexDirty = false;

    if (skills.length === 0) return;

    // Include keywords in the indexed text so BM25 can match CJK queries
    // against English skills (e.g., "单元测试" → skill with keyword "测试").
    const chunks = skills.map((s) => {
      const kwText = s.keywords?.length ? "\n" + s.keywords.join(" ") : "";
      return {
        text: `${s.name}\n${s.description}${kwText}\n${s.systemPrompt ?? ""}`,
        embedding: [] as number[],
        sourcePath: s.name,
        chunkIndex: 0,
      };
    });

    this.skillIdx.add(chunks);
    for (const s of skills) {
      this.skillMap.set(s.name, s);
    }
  }

  // ─── Retrieval ──────────────────────────────────────────────────────────

  /**
   * BM25-retrieve the top-K most relevant memories.
   *
   * Two-pronged filter (see {@link MIN_SCORE_RATIO} / {@link MIN_ABSOLUTE_SCORE}):
   * - If a strong match exists (top score ~5+), only results within 10% are kept
   * - If nothing truly matches (top score < 1.0), nothing is returned
   *
   * @returns Memory-score pairs sorted by relevance (best match first).
   */
  retrieveMemories(query: string, topK: number = 5): RetrievedMemory[] {
    const results = this.memoryIdx.search(query, topK);
    if (results.length === 0) return [];

    const threshold = Math.max(results[0].score * MIN_SCORE_RATIO, MIN_ABSOLUTE_SCORE);

    return results
      .filter((r) => r.score >= threshold)
      .map((r) => {
        const memory = this.memoryMap.get(r.chunk.sourcePath);
        if (!memory) return null;
        return { memory, score: r.score };
      })
      .filter((m): m is RetrievedMemory => m !== null);
  }

  /**
   * BM25-retrieve the top-K most relevant skills.
   *
   * Same two-pronged filter as {@link retrieveMemories}.
   *
   * @returns Skill matches sorted by relevance (best match first).
   */
  retrieveSkills(query: string, topK: number = 5): RetrievedSkill[] {
    const results = this.skillIdx.search(query, topK);
    if (results.length === 0) return [];

    const threshold = Math.max(results[0].score * MIN_SCORE_RATIO, MIN_ABSOLUTE_SCORE);

    return results
      .filter((r) => r.score >= threshold)
      .map((r) => {
        const skill = this.skillMap.get(r.chunk.sourcePath);
        if (!skill) return null;
        return { skill, score: r.score };
      })
      .filter((m): m is RetrievedSkill => m !== null);
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  get memoryCount(): number {
    return this.memoryIdx.size;
  }

  get skillCount(): number {
    return this.skillIdx.size;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Mark the skill index as stale so the next {@link indexSkills} call
   * rebuilds it. Call this after `SkillManager.reloadFromDirectory()`.
   */
  invalidateSkillIndex(): void {
    this.skillIndexDirty = true;
  }
}
