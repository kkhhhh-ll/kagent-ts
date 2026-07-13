import * as fs from "fs";
import * as path from "path";

// ─── RulesStore Interface ──────────────────────────────────────────────────

/**
 * Result of stating a single file.
 */
export interface FileStat {
  /** File size in bytes. */
  size: number;
  /** Last modified timestamp in milliseconds. */
  mtimeMs: number;
}

/**
 * Storage backend for project rules.
 *
 * Implementations:
 * - {@link FileSystemRulesStore} — local file or directory (default)
 * - Custom implementations (database, remote config, etc.) by implementing
 *   this interface and passing to {@link ProjectRules}.
 */
export interface RulesStore {
  /**
   * Whether this store represents a directory (multi-file rules).
   */
  isDirectory(): boolean;

  /**
   * Whether this store represents a single file.
   */
  isFile(): boolean;

  /**
   * Get the file path (for single-file rules) or directory path (for multi-file rules).
   */
  getPath(): string;

  /**
   * Stat a single file. Returns `null` if the file doesn't exist.
   */
  statFile(filePath: string): FileStat | null;

  /**
   * Read a file's content (trimmed). Returns `null` if it can't be read.
   */
  readFile(filePath: string): string | null;

  /**
   * List `.md` files in the directory, sorted by name.
   * Returns empty array if the directory doesn't exist or can't be read.
   */
  listDir(): string[];
}

// ─── FileSystemRulesStore ──────────────────────────────────────────────────

/**
 * File-system backed rules storage.
 *
 * Supports two modes:
 * - **Single file**: `RULES.md` (or custom path) — one markdown file.
 * - **Directory**: `.rules/` (or custom path) — multiple `.md` files.
 */
export class FileSystemRulesStore implements RulesStore {
  private resolvedPath: string;
  private mode: "file" | "directory" | "none";

  /**
   * @param rulesPath Path to a rules file or directory.
   */
  constructor(rulesPath?: string) {
    this.resolvedPath = path.resolve(rulesPath ?? ".kagent/rules/");
    this.mode = this.detectMode();
  }

  // ─── RulesStore Implementation ────────────────────────────────────────

  isDirectory(): boolean {
    return this.mode === "directory";
  }

  isFile(): boolean {
    return this.mode === "file";
  }

  getPath(): string {
    return this.resolvedPath;
  }

  statFile(filePath: string): FileStat | null {
    try {
      const stat = fs.statSync(filePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      return null;
    }
  }

  listDir(): string[] {
    try {
      return fs
        .readdirSync(this.resolvedPath)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private detectMode(): "file" | "directory" | "none" {
    try {
      const stat = fs.statSync(this.resolvedPath);
      if (stat.isDirectory()) return "directory";
      if (stat.isFile()) return "file";
    } catch {
      // ENOENT — path doesn't exist
    }
    return "none";
  }
}
