import * as fs from "fs";
import * as path from "path";

// ─── PreferencesStore Interface ────────────────────────────────────────────

/**
 * Result of reading a preferences file from the store.
 */
export interface PreferencesReadResult {
  /** The file content (trimmed). */
  content: string;
  /** Last modified timestamp in milliseconds. */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
}

/**
 * Storage backend for user preferences.
 *
 * Implementations:
 * - {@link FileSystemPreferencesStore} — local markdown file (default)
 * - Custom implementations (database, remote config, etc.) by implementing
 *   this interface and passing to {@link PreferenceManager}.
 */
export interface PreferencesStore {
  /**
   * Try to read the preferences file.
   * Returns `null` if the file doesn't exist or can't be read.
   */
  tryRead(): PreferencesReadResult | null;

  /**
   * Get the file path (for display/debug purposes).
   */
  getPath(): string;
}

// ─── FileSystemPreferencesStore ────────────────────────────────────────────

/**
 * File-system backed preferences storage.
 *
 * Reads from a single markdown file:
 * ```
 * .kagent/preferences.md    ← key: value lines
 * ```
 */
export class FileSystemPreferencesStore implements PreferencesStore {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = path.resolve(filePath ?? ".kagent/preferences.md");
  }

  // ─── PreferencesStore Implementation ──────────────────────────────────

  tryRead(): PreferencesReadResult | null {
    try {
      const stat = fs.statSync(this.filePath);
      const raw = fs.readFileSync(this.filePath, "utf-8").trim();
      return { content: raw, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  getPath(): string {
    return this.filePath;
  }
}
