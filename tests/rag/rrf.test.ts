import { describe, it, expect } from "vitest";
import { rrfFusion, chunkKey } from "../../src/rag/rrf";
import type { RankedResult } from "../../src/rag/rrf";

let _id = 0;

function makeChunk(text: string, source?: string, idx?: number) {
  const id = _id++;
  return {
    text,
    embedding: [0],
    sourcePath: source ?? `doc${id}.md`,
    chunkIndex: idx ?? id,
  };
}

function makeResult(chunk: ReturnType<typeof makeChunk>, score: number): RankedResult {
  return { chunk, score };
}

describe("chunkKey", () => {
  it("generates unique keys from sourcePath + chunkIndex", () => {
    const a = makeChunk("a", "file1.md", 0);
    const b = makeChunk("b", "file1.md", 1);
    const c = makeChunk("c", "file2.md", 0);
    expect(chunkKey(a)).toBe("file1.md#0");
    expect(chunkKey(b)).toBe("file1.md#1");
    expect(chunkKey(c)).toBe("file2.md#0");
  });
});

describe("rrfFusion", () => {
  it("returns empty array for empty input", () => {
    const result = rrfFusion([], 60, 10);
    expect(result).toEqual([]);
  });

  it("returns empty array when all rankings are empty", () => {
    const result = rrfFusion([[], []], 60, 10);
    expect(result).toEqual([]);
  });

  it("returns results from a single ranking", () => {
    const chunks = [makeChunk("a"), makeChunk("b"), makeChunk("c")];
    const ranking: RankedResult[] = chunks.map((c, i) => makeResult(c, 1 - i * 0.1));

    const result = rrfFusion([ranking], 60, 3);
    expect(result).toHaveLength(3);
    expect(result[0].chunk.text).toBe("a");
    expect(result[1].chunk.text).toBe("b");
    expect(result[2].chunk.text).toBe("c");
  });

  it("merges two rankings and reorders by RRF score", () => {
    const a = makeChunk("alpha");
    const b = makeChunk("beta");
    const c = makeChunk("gamma");

    // Ranking 1: alpha > beta > gamma
    const r1: RankedResult[] = [
      makeResult(a, 0.9),
      makeResult(b, 0.5),
      makeResult(c, 0.1),
    ];

    // Ranking 2: gamma > alpha > beta (alpha appears high in both)
    const r2: RankedResult[] = [
      makeResult(c, 0.9),
      makeResult(a, 0.5),
      makeResult(b, 0.1),
    ];

    const fused = rrfFusion([r1, r2], 60, 3);
    expect(fused).toHaveLength(3);
    // alpha ranks 1st in r1 and 2nd in r2 → highest combined RRF
    expect(fused[0].chunk.text).toBe("alpha");
    // sources bitmask: 0b11 = both rankings
    expect(fused[0].sources).toBe(0b11);
  });

  it("handles a chunk appearing in only one ranking", () => {
    const a = makeChunk("alpha");
    const b = makeChunk("beta");

    const r1: RankedResult[] = [makeResult(a, 0.9)];
    const r2: RankedResult[] = [makeResult(b, 0.9)];

    const fused = rrfFusion([r1, r2], 60, 2);
    expect(fused).toHaveLength(2);
    // Each appears only in one ranking → similar scores
    expect(fused[0].sources).toBe(1); // bit 0 only
    expect(fused[1].sources).toBe(2); // bit 1 only
  });

  it("respects topN parameter", () => {
    const chunks = Array.from({ length: 10 }, (_, i) => makeChunk(`c${i}`));
    const ranking: RankedResult[] = chunks.map((c, i) => makeResult(c, 1 - i * 0.1));

    const fused = rrfFusion([ranking], 60, 5);
    expect(fused).toHaveLength(5);
  });

  it("deduplicates the same chunk across rankings", () => {
    const a = makeChunk("dup", "file.md", 0);

    const r1: RankedResult[] = [makeResult(a, 0.9)];
    const r2: RankedResult[] = [makeResult(a, 0.8)];

    const fused = rrfFusion([r1, r2], 60, 2);
    // Should only appear once with combined score
    expect(fused).toHaveLength(1);
    expect(fused[0].chunk.text).toBe("dup");
    expect(fused[0].sources).toBe(0b11);
  });
});
