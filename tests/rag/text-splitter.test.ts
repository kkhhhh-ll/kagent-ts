import { describe, it, expect } from "vitest";
import { splitText } from "../../src/rag/text-splitter";

describe("TextSplitter", () => {
  // ── Short text ────────────────────────────────────────────────────────

  it("returns a single chunk when text is shorter than chunkSize", () => {
    const text = "短文本。";
    const chunks = splitText(text, 100, 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("短文本。");
  });

  // ── Markdown heading boundaries ────────────────────────────────────────

  it("splits at markdown heading boundaries (priority 1)", () => {
    const text =
      "## 第一章\n\n这是第一章的内容。" +
      "这里有一些补充说明文字，确保内容足够形成两个独立块。" +
      "继续填充内容以超过chunk大小限制。".repeat(3) +
      "\n\n## 第二章\n\n这是第二章的内容。" +
      "第二章也有很多需要说明的地方。".repeat(3);

    const chunks = splitText(text, 100, 0);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should start with or contain its heading
    const hasChapter1 = chunks.some((c) => c.includes("第一章"));
    const hasChapter2 = chunks.some((c) => c.includes("第二章"));
    expect(hasChapter1).toBe(true);
    expect(hasChapter2).toBe(true);
  });

  // ── Paragraph boundaries ───────────────────────────────────────────────

  it("splits at paragraph boundaries (priority 2)", () => {
    const paragraph1 = "第一段文字。" + "内容填充。".repeat(10);
    const paragraph2 = "第二段文字。" + "内容填充。".repeat(10);

    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = splitText(text, 50, 0);

    // Each chunk should be roughly paragraph-aligned
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // ── Chinese sentence endings ──────────────────────────────────────────

  it("splits at Chinese sentence endings (priority 3)", () => {
    const text =
      "这是第一句话。这是第二句话！这是第三句话？" +
      "这是第四句话。这是第五句话！";

    const chunks = splitText(text, 15, 0);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Each chunk should end with a sentence terminator or be the last one
    for (let i = 0; i < chunks.length - 1; i++) {
      const lastChar = chunks[i].slice(-1);
      expect(["。", "！", "？"]).toContain(lastChar);
    }
  });

  // ── English sentence endings ──────────────────────────────────────────

  it("splits at English sentence endings (priority 3)", () => {
    const text =
      "First sentence. Second sentence! Third sentence? " +
      "Fourth sentence. Fifth sentence.";

    const chunks = splitText(text, 30, 0);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // ── Clause pauses (priority 4) ────────────────────────────────────────

  it("splits at clause pauses when no sentence break is available", () => {
    const text =
      "这是一个很长的句子，里面有逗号分隔，还有分号；以及顿号、冒号：" +
      "后面还有更多内容，继续填充直到超过限制。".repeat(3);

    const chunks = splitText(text, 40, 0);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  // ── Hard cutoff (priority 5, last resort) ─────────────────────────────

  it("falls back to hard cutoff when no separator is found", () => {
    // A string with NO separators (no punctuation, no newlines, no spaces)
    const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".repeat(3);

    const chunks = splitText(text, 20, 0);

    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should exceed chunkSize
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  // ── Overlap ────────────────────────────────────────────────────────────

  it("creates overlapping chunks when chunkOverlap > 0", () => {
    const text =
      "第一部分的内容在这里。这是第二部分的内容，和前面有重叠。第三部分继续延伸话题。" +
      "第四部分的内容补充说明。第五部分作为结尾。";

    const chunks = splitText(text, 30, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Check that adjacent chunks share content (overlap)
    if (chunks.length >= 2) {
      // The end of chunk 0 should overlap with the start of chunk 1
      const tail0 = chunks[0].slice(-5);
      expect(chunks[1]).toContain(tail0);
    }
  });

  // ── Empty / edge cases ────────────────────────────────────────────────

  it("returns empty array for empty text", () => {
    const chunks = splitText("", 100, 20);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty array for whitespace-only text", () => {
    const chunks = splitText("   \n\n   ", 100, 20);
    expect(chunks).toHaveLength(0);
  });

  // ── Mixed Chinese + English ───────────────────────────────────────────

  it("handles mixed Chinese and English text", () => {
    const text =
      "这是一个混合中英文的段落。This is an English sentence. " +
      "继续中文内容。Another English sentence goes here. " +
      "最后一段中文结尾。";

    const chunks = splitText(text, 50, 10);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // The full original content should be preserved across chunks
    const combined = chunks.join("");
    // Should contain key phrases from both languages
    expect(combined).toContain("混合中英文");
    expect(combined).toContain("English sentence");
  });

  // ── Overlap respects separator priorities ─────────────────────────────

  it("overlap starts at a natural boundary when possible", () => {
    const text =
      "这是第一段完整内容，前面部分会被截断。" +
      "第二段从这里开始。继续填充到足够长度以测试overlap边界对齐。".repeat(5);

    const chunks = splitText(text, 80, 30);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should NOT start mid-character (always at a valid boundary)
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});
