import * as fs from "fs";
import * as path from "path";

// ─── MemoryStore Interface ────────────────────────────────────────────────

/**
 * Storage backend for long-term memories.
 *
 * Implementations:
 * - {@link FileSystemMemoryStore} — local `.memory/` directory (default)
 * - Custom implementations (Postgres, Redis, SQLite, etc.) by implementing
 *   this interface and passing to {@link MemoryManager}.
 */
export interface MemoryStore {
  /**
   * Ensure the storage directory exists.
   * Called before any write operation. Idempotent.
   */
  ensureDir(): void;

  /**
   * Read the MEMORY.md index file content.
   * Returns an empty string if the file doesn't exist.
   */
  readIndex(): string;

  /**
   * Write the MEMORY.md index file content.
   */
  writeIndex(raw: string): void;

  /**
   * Read a memory file by name.
   * Returns the raw file content (frontmatter + markdown body),
   * or `null` if the file doesn't exist.
   */
  read(name: string): string | null;

  /**
   * Write a memory file.
   * Creates parent directories if needed.
   */
  write(name: string, content: string): void;

  /**
   * Delete a memory file by name.
   * Returns `false` if the file didn't exist.
   */
  delete(name: string): boolean;

  /**
   * Check if a memory file exists.
   */
  exists(name: string): boolean;

  /**
   * Get the file path for a memory name.
   * Useful for path-aware operations.
   */
  getPath(name: string): string;

  /**
   * Get the absolute path of the storage directory.
   */
  getDir(): string;
}

// ─── FileSystemMemoryStore ────────────────────────────────────────────────

/**
 * File-system backed memory storage.
 *
 * Layout:
 * ```
 * {storageDir}/
 *   MEMORY.md          ← index (markdown link list)
 *   <name>.md          ← individual memory files (frontmatter + body)
 * ```
 */
export class FileSystemMemoryStore implements MemoryStore {
  private storageDir: string;
  private indexFile: string;

  constructor(storageDir?: string) {
    this.storageDir = path.resolve(storageDir ?? ".memory");
    this.indexFile = path.join(this.storageDir, "MEMORY.md");
  }

  // ─── MemoryStore Implementation ──────────────────────────────────────

  ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
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
    this.ensureDir();
    fs.writeFileSync(this.indexFile, raw, "utf-8");
  }

  read(name: string): string | null {
    try {
      return fs.readFileSync(this.getPath(name), "utf-8");
    } catch {
      return null;
    }
  }

  write(name: string, content: string): void {
    this.ensureDir();
    fs.writeFileSync(this.getPath(name), content, "utf-8");
  }

  delete(name: string): boolean {
    try {
      fs.unlinkSync(this.getPath(name));
      return true;
    } catch {
      return false;
    }
  }

  exists(name: string): boolean {
    return fs.existsSync(this.getPath(name));
  }

  getPath(name: string): string {
    return path.join(this.storageDir, `${name}.md`);
  }

  getDir(): string {
    return this.storageDir;
  }

  // ─── File-specific helpers (used by MemoryManager) ───────────────────

  /**
   * Get the mtime of the index file in milliseconds.
   * Returns `0` if the file doesn't exist.
   */
  getIndexMtimeMs(): number {
    try {
      const stat = fs.statSync(this.indexFile);
      if (!stat.isFile()) return 0; // directory, socket, etc.
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }
}
