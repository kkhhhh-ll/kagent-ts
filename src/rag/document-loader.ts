/**
 * Document loader — scans a directory and loads supported files.
 *
 * Supported formats:
 * - .md   (Markdown)
 * - .txt  (Plain text)
 * - .json (treated as text — useful for structured data dumps)
 *
 * Recurses into subdirectories. Files/directories starting with "." are skipped.
 */

import * as fs from "fs";
import * as path from "path";
import type { RAGDocument, RAGChunk } from "./rag-types";
import { splitText } from "./text-splitter";

/** Max file size to load (5 MiB). Larger files are skipped. */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Supported file extensions. */
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json"]);

/**
 * Load all supported documents from a directory (recursive).
 *
 * @param dir      Root directory to scan.
 * @param chunkSize     Max characters per chunk.
 * @param chunkOverlap  Overlap characters between adjacent chunks.
 * @returns An array of RAGDocuments with populated (but not yet embedded) chunks.
 */
export function loadDocuments(
  dir: string,
  chunkSize: number,
  chunkOverlap: number,
): RAGDocument[] {
  const resolved = path.resolve(dir);
  const documents: RAGDocument[] = [];

  walk(resolved, resolved, documents, chunkSize, chunkOverlap);
  return documents;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function walk(
  root: string,
  current: string,
  out: RAGDocument[],
  chunkSize: number,
  chunkOverlap: number,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      walk(root, fullPath, out, chunkSize, chunkOverlap);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const doc = loadFile(fullPath, root, chunkSize, chunkOverlap);
      if (doc) out.push(doc);
    }
  }
}

function loadFile(
  filePath: string,
  root: string,
  chunkSize: number,
  chunkOverlap: number,
): RAGDocument | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (stat.size > MAX_FILE_SIZE) return null;
  if (stat.size === 0) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  if (raw.trim().length === 0) return null;

  const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
  const textChunks = splitText(raw, chunkSize, chunkOverlap);

  const chunks: RAGChunk[] = textChunks.map((text, i) => ({
    text,
    embedding: [], // Populated later by RAGManager
    sourcePath: relativePath,
    chunkIndex: i,
  }));

  return {
    path: relativePath,
    content: raw,
    chunks,
  };
}
