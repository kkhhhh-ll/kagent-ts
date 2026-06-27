import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadDocuments } from "../../src/rag/document-loader";

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-rag-test-"));
}

function writeFile(dir: string, filename: string, content: string): void {
  const filePath = path.join(dir, filename);
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("DocumentLoader (loadDocuments)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tempDir();
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("loads a single markdown file", () => {
    writeFile(testDir, "readme.md", "# Hello\n\nThis is a test document.");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe("readme.md");
    expect(docs[0].chunks.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].chunks[0].text).toContain("Hello");
    expect(docs[0].chunks[0].sourcePath).toBe("readme.md");
    expect(docs[0].chunks[0].chunkIndex).toBe(0);
  });

  it("loads multiple files of different types", () => {
    writeFile(testDir, "a.md", "# Doc A\n\nContent A.");
    writeFile(testDir, "b.txt", "Content B.");
    writeFile(testDir, "c.json", '{"key": "value"}');

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(3);
    const paths = docs.map((d) => d.path).sort();
    expect(paths).toEqual(["a.md", "b.txt", "c.json"]);
  });

  it("recurses into subdirectories", () => {
    writeFile(testDir, "root.md", "# Root");
    writeFile(testDir, "sub/deep.md", "# Deep");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(2);
    const paths = docs.map((d) => d.path).sort();
    expect(paths).toEqual(["root.md", "sub/deep.md"]);
  });

  it("skips unsupported file extensions", () => {
    writeFile(testDir, "valid.md", "# Valid");
    writeFile(testDir, "image.png", "binary stuff");
    writeFile(testDir, "style.css", ".class { color: red; }");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe("valid.md");
  });

  it("skips hidden files and directories (starting with '.')", () => {
    writeFile(testDir, "visible.md", "# Visible");
    // This won't be found because walk() skips entries starting with "."
    const hiddenDir = path.join(testDir, ".hidden_dir");
    fs.mkdirSync(hiddenDir);
    fs.writeFileSync(path.join(hiddenDir, "hidden_doc.md"), "# Hidden", "utf-8");

    // Also a hidden file at root
    fs.writeFileSync(path.join(testDir, ".hidden_file.md"), "# Hidden File", "utf-8");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe("visible.md");
  });

  it("skips empty files", () => {
    writeFile(testDir, "empty.md", "");
    writeFile(testDir, "real.md", "# Real content");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe("real.md");
  });

  it("skips whitespace-only files", () => {
    writeFile(testDir, "blank.md", "   \n\n  ");
    writeFile(testDir, "real.txt", "Real");

    const docs = loadDocuments(testDir, 500, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].path).toBe("real.txt");
  });

  it("chunks documents according to chunkSize", () => {
    // Create content that will produce >1 chunk at chunkSize=50
    const longContent = "A".repeat(200);
    writeFile(testDir, "long.md", longContent);

    const docs = loadDocuments(testDir, 50, 0);

    expect(docs).toHaveLength(1);
    expect(docs[0].chunks.length).toBeGreaterThanOrEqual(3);
    // Verify chunk indices
    for (let i = 0; i < docs[0].chunks.length; i++) {
      expect(docs[0].chunks[i].chunkIndex).toBe(i);
    }
  });

  it("chunk embeddings are initially empty", () => {
    writeFile(testDir, "doc.md", "# Test\n\nSome content here.");

    const docs = loadDocuments(testDir, 100, 0);

    expect(docs).toHaveLength(1);
    for (const chunk of docs[0].chunks) {
      expect(chunk.embedding).toEqual([]);
    }
  });

  it("returns empty array for empty directory", () => {
    const docs = loadDocuments(testDir, 500, 0);
    expect(docs).toHaveLength(0);
  });

  it("returns empty array for non-existent directory", () => {
    const docs = loadDocuments(path.join(testDir, "nope"), 500, 0);
    expect(docs).toHaveLength(0);
  });
});
