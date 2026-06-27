/**
 * Recursive priority-based text splitter.
 *
 * Splits text into chunks by trying separators in priority order:
 *   1. Markdown heading boundaries  (##, ###)
 *   2. Paragraph boundaries         (double newline)
 *   3. Sentence endings             (。！？. ! ? + single newline)
 *   4. Clause pauses                (；，、, ; :)
 *   5. Hard cutoff                  (character-level, last resort)
 *
 * At each level the splitter finds the last separator within the chunk_size
 * window and breaks there. If no separator is found, it falls back to the
 * next priority level.
 *
 * Chunks overlap: adjacent chunks share `chunkOverlap` characters of context.
 * The overlap boundary also respects separator priorities.
 */

// ─── Separator definitions ───────────────────────────────────────────────────

/**
 * Separators at each priority level (ordered highest → lowest).
 * Each entry is a list of equivalent separators.
 */
const SEPARATOR_PRIORITIES: string[][] = [
  // Priority 1: Markdown heading boundaries
  ["\n## ", "\n### ", "\n#### ", "\n# "],
  // Priority 2: Paragraph boundaries
  ["\n\n", "\r\n\r\n"],
  // Priority 3: Sentence endings (Chinese + English)
  ["。", "！", "？", ". ", "! ", "? ", "\n", ".\n", "!\n", "?\n"],
  // Priority 4: Clause pauses
  ["；", "，", "：", "、", "; ", ", ", ": ", ";\n", ",\n"],
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Split `text` into chunks not exceeding `chunkSize` characters,
 * with `chunkOverlap` characters of context between adjacent chunks.
 *
 * Returns an array of chunk text strings (no empty strings).
 */
export function splitText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    // How far ahead we can look for a split point
    const windowEnd = Math.min(start + chunkSize, text.length);

    // If the remainder fits in one chunk, take it all
    if (windowEnd >= text.length) {
      const remainder = text.slice(start).trim();
      if (remainder.length > 0) chunks.push(remainder);
      break;
    }

    // Find the best split point within [start, windowEnd]
    const splitAt = findSplitPoint(text, start, windowEnd);

    const chunk = text.slice(start, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);

    // Advance start: split point minus overlap, bounded by previous start
    const overlapStart = findOverlapStart(text, splitAt, start, chunkOverlap);
    start = overlapStart;
  }

  return chunks;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Find the best split position within the window [start, windowEnd].
 *
 * Tries each priority level; returns the position of the *last* matching
 * separator + its length (so the separator stays with the left chunk).
 * Falls back to `windowEnd` (hard cut) if no separator is found.
 */
function findSplitPoint(
  text: string,
  start: number,
  windowEnd: number,
): number {
  for (const separators of SEPARATOR_PRIORITIES) {
    let bestPos = -1;
    let bestSepLen = 0;

    for (const sep of separators) {
      // Search backwards from windowEnd for the last occurrence of this separator
      let pos = text.lastIndexOf(sep, windowEnd);
      while (pos >= start && pos + sep.length > windowEnd) {
        // Separator straddles the window boundary — try earlier
        pos = text.lastIndexOf(sep, pos - 1);
      }
      if (pos >= start && pos > bestPos) {
        bestPos = pos;
        bestSepLen = sep.length;
      }
    }

    if (bestPos >= start) {
      return bestPos + bestSepLen; // Include the separator in the left chunk
    }
  }

  // Last resort: hard cut at windowEnd
  return windowEnd;
}

/**
 * Calculate the start position for the next chunk, accounting for overlap.
 *
 * From `splitAt`, step back by approximately `chunkOverlap` characters,
 * then walk further back to the nearest high-priority separator so the
 * overlap starts at a natural boundary.
 */
function findOverlapStart(
  text: string,
  splitAt: number,
  minStart: number,
  chunkOverlap: number,
): number {
  if (chunkOverlap <= 0) return splitAt;

  const target = Math.max(minStart, splitAt - chunkOverlap);
  if (target <= minStart) return target;

  // Look for a natural boundary near the target position
  for (const separators of SEPARATOR_PRIORITIES) {
    let bestPos = -1;
    for (const sep of separators) {
      // Search forward from target
      let pos = text.indexOf(sep, target);
      if (pos >= target && pos < splitAt && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
      }
      // Also try backward from target
      pos = text.lastIndexOf(sep, target);
      if (pos >= minStart && (bestPos === -1 || Math.abs(pos - target) < Math.abs(bestPos - target))) {
        bestPos = pos;
      }
    }
    if (bestPos >= minStart) {
      return bestPos + 1; // Start after the separator
    }
  }

  return target;
}
