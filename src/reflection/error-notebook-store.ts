import * as fs from "fs";
import * as path from "path";

// ─── ErrorNotebookStore Interface ──────────────────────────────────────────

/**
 * Storage backend for the Error Notebook (错题本).
 *
 * Implementations:
 * - {@link FileSystemErrorNotebookStore} — local `.error-notebook/` directory (default)
 * - Custom implementations (Postgres, Redis, etc.) by implementing this
 *   interface and passing to {@link ErrorNotebook}.
 */
export interface ErrorNotebookStore {
  /**
   * Ensure the storage directory and entries subdirectory exist. Idempotent.
   */
  ensureDirs(): void;

  /**
   * Read the README.md index file.
   * Returns an empty string if the file doesn't exist.
   */
  readIndex(): string;

  /**
   * Write the README.md index file.
   */
  writeIndex(raw: string): void;

  /**
   * Read an entry file by ID.
   * Returns the raw file content (frontmatter + markdown body),
   * or `null` if the file doesn't exist.
   */
  readEntry(id: string): string | null;

  /**
   * Write an entry file.
   */
  writeEntry(id: string, content: string): void;

  /**
   * Delete an entry file by ID.
   * Returns `false` if the file didn't exist.
   */
  deleteEntry(id: string): boolean;

  /**
   * List all entry file IDs (without `.md` extension).
   */
  listEntries(): string[];

  /**
   * Get the storage directory path.
   */
  getDir(): string;
}

// ─── FileSystemErrorNotebookStore ──────────────────────────────────────────

/**
 * File-system backed error notebook storage.
 *
 * Layout:
 * ```
 * {storageDir}/
 *   README.md            ← index (markdown link list)
 *   entries/
 *     nb_xxx.md          ← full entry (frontmatter + markdown body)
 * ```
 */
export class FileSystemErrorNotebookStore implements ErrorNotebookStore {
  private storageDir: string;
  private entriesDir: string;
  private indexFile: string;

  constructor(storageDir?: string) {
    this.storageDir = path.resolve(storageDir ?? ".error-notebook");
    this.entriesDir = path.join(this.storageDir, "entries");
    this.indexFile = path.join(this.storageDir, "README.md");
  }

  // ─── ErrorNotebookStore Implementation ────────────────────────────────

  ensureDirs(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.entriesDir)) {
      fs.mkdirSync(this.entriesDir, { recursive: true });
    }
  }

  readIndex(): string {
    try {
      return fs.readFileSync(this.indexFile, "utf-8");
    } catch {
      return "";
    }
  }

  writeIndex(raw: string): void {
    this.ensureDirs();
    fs.writeFileSync(this.indexFile, raw, "utf-8");
  }

  readEntry(id: string): string | null {
    try {
      return fs.readFileSync(this.entryPath(id), "utf-8");
    } catch {
      return null;
    }
  }

  writeEntry(id: string, content: string): void {
    this.ensureDirs();
    fs.writeFileSync(this.entryPath(id), content, "utf-8");
  }

  deleteEntry(id: string): boolean {
    try {
      fs.unlinkSync(this.entryPath(id));
      return true;
    } catch {
      return false;
    }
  }

  listEntries(): string[] {
    try {
      return fs
        .readdirSync(this.entriesDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -".md".length));
    } catch {
      return [];
    }
  }

  getDir(): string {
    return this.storageDir;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private entryPath(id: string): string {
    return path.join(this.entriesDir, `${id}.md`);
  }
}
