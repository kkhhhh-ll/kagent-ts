/**
 * Document loaders — scan directories, fetch URLs, load text.
 *
 * Supported formats:
 * - .md   (Markdown)
 * - .txt  (Plain text)
 * - .json (treated as text — useful for structured data dumps)
 *
 * Each loader implements the {@link DocumentLoader} interface from rag-types.ts.
 */

import * as fs from "fs";
import * as path from "path";
import type { DocumentLoader, RAGDocument, RAGChunk } from "./rag-types";
import { splitText } from "./text-splitter";

/** Max file size to load (5 MiB). Larger files are skipped. */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Supported file extensions. */
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json"]);

/** Timeout for URL fetches (ms). */
const URL_FETCH_TIMEOUT_MS = 30_000;

// ─── DirectoryLoader ──────────────────────────────────────────────────────────

/**
 * Load all supported documents from a local directory (recursive).
 *
 * Skips files/directories starting with "." and files larger than 5 MiB.
 */
export class DirectoryLoader implements DocumentLoader {
  private dir: string;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(dir: string, chunkSize = 1000, chunkOverlap = 200) {
    this.dir = path.resolve(dir);
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  async load(): Promise<RAGDocument[]> {
    const documents: RAGDocument[] = [];
    walk(this.dir, this.dir, documents, this.chunkSize, this.chunkOverlap);
    return documents;
  }
}

// ─── UrlLoader ────────────────────────────────────────────────────────────────

/**
 * Fetch a web page by URL, strip HTML, and convert to a single RAGDocument.
 *
 * Uses the built-in `fetch` API. Non-text content types are rejected.
 * The document path is set to the URL itself.
 */
export class UrlLoader implements DocumentLoader {
  private url: string;
  private title?: string;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(url: string, opts?: { title?: string; chunkSize?: number; chunkOverlap?: number }) {
    this.url = url;
    this.title = opts?.title;
    this.chunkSize = opts?.chunkSize ?? 1000;
    this.chunkOverlap = opts?.chunkOverlap ?? 200;
  }

  async load(): Promise<RAGDocument[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(this.url, {
        headers: {
          "User-Agent": "kagent-ts/1.0 (rag url loader)",
          Accept: "text/html, application/xhtml+xml, text/plain",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      const contentType = response.headers.get("content-type") ?? "";

      // Reject binary responses
      const binaryPrefixes = [
        "application/octet-stream", "application/pdf", "application/zip",
        "application/gzip", "application/x-tar", "application/x-rar-compressed",
      ];
      const isBinary = binaryPrefixes.some((t) => contentType.startsWith(t)) ||
        contentType.startsWith("image/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/");

      if (isBinary) {
        throw new Error(`Cannot fetch binary content (Content-Type: ${contentType}).`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const raw = await response.text();

      // Extract title
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const detectedTitle = this.title ?? titleMatch?.[1]?.trim() ?? new URL(this.url).hostname;

      // Strip HTML
      const text = stripHtml(raw);

      if (text.trim().length === 0) {
        throw new Error("Fetched page contains no extractable text.");
      }

      const doc = buildDocument(text, this.url, this.chunkSize, this.chunkOverlap);
      // Override path to include title for display clarity
      doc.path = `${detectedTitle} (${this.url})`;

      return [doc];
    } catch (err: unknown) {
      if (err instanceof DOMException || (err instanceof Error && err.name === "AbortError")) {
        throw new Error(`URL fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s: ${this.url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─── TextLoader ────────────────────────────────────────────────────────────────

/**
 * Convert inline text into a single RAGDocument.
 *
 * Useful for programmatic ingestion, user-provided content, or LLM-generated
 * summaries that should be searchable later.
 */
export class TextLoader implements DocumentLoader {
  private content: string;
  private title: string;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(opts: { content: string; title: string; chunkSize?: number; chunkOverlap?: number }) {
    this.content = opts.content;
    this.title = opts.title;
    this.chunkSize = opts.chunkSize ?? 1000;
    this.chunkOverlap = opts.chunkOverlap ?? 200;
  }

  async load(): Promise<RAGDocument[]> {
    if (this.content.trim().length === 0) {
      return [];
    }

    const doc = buildDocument(this.content, this.title, this.chunkSize, this.chunkOverlap);
    return [doc];
  }
}

// ─── FileLoader ────────────────────────────────────────────────────────────────

/**
 * Load a single local file by path (for runtime ingestion of new files).
 *
 * Same format support as DirectoryLoader (.md / .txt / .json).
 */
export class FileLoader implements DocumentLoader {
  private filePath: string;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(filePath: string, chunkSize = 1000, chunkOverlap = 200) {
    this.filePath = path.resolve(filePath);
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  async load(): Promise<RAGDocument[]> {
    const ext = path.extname(this.filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported file type "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
      );
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      throw new Error(`File not found: ${this.filePath}`);
    }

    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MiB > 5 MiB limit).`);
    }
    if (stat.size === 0) {
      return [];
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      throw new Error(`Cannot read file: ${this.filePath}`);
    }

    if (raw.trim().length === 0) return [];

    const doc = buildDocument(raw, this.filePath, this.chunkSize, this.chunkOverlap);
    return [doc];
  }
}

// ─── Legacy convenience wrapper ───────────────────────────────────────────────

/**
 * Load all supported documents from a directory (backward-compatible wrapper).
 *
 * @deprecated Use `new DirectoryLoader(dir, chunkSize, chunkOverlap).load()` instead.
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
  return buildDocument(raw, relativePath, chunkSize, chunkOverlap);
}

function buildDocument(
  raw: string,
  displayPath: string,
  chunkSize: number,
  chunkOverlap: number,
): RAGDocument {
  const textChunks = splitText(raw, chunkSize, chunkOverlap);

  const chunks: RAGChunk[] = textChunks.map((text, i) => ({
    text,
    embedding: [], // Populated later by RAGManager
    sourcePath: displayPath,
    chunkIndex: i,
  }));

  return {
    path: displayPath,
    content: raw,
    chunks,
  };
}

// ─── HTML stripping ───────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n");
}
