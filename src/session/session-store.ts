import * as fs from "fs";
import * as path from "path";
import type { SessionState } from "./session-types";

// ─── SessionStore Interface ────────────────────────────────────────────────

/**
 * Storage backend for session state persistence.
 *
 * Implementations:
 * - {@link FileSystemSessionStore} — local `.kagent-sessions/` directory (default)
 * - Custom implementations (Postgres, Redis, etc.) by implementing this
 *   interface and passing to {@link SessionManager}.
 */
export interface SessionStore {
  /**
   * Ensure the storage directory exists. Idempotent.
   */
  ensureDir(): void;

  /**
   * Save a session state.
   */
  save(id: string, state: SessionState): void;

  /**
   * Load a session state by ID.
   * Returns `null` if the session file is missing or corrupt.
   */
  load(id: string): SessionState | null;

  /**
   * Delete a session by ID.
   * Does not throw if the session doesn't exist.
   */
  delete(id: string): void;

  /**
   * List all session IDs currently stored.
   */
  list(): string[];

  /**
   * Get the file path for a session ID.
   */
  getPath(id: string): string;

  /**
   * Get the storage directory path.
   */
  getDir(): string;
}

// ─── FileSystemSessionStore ────────────────────────────────────────────────

/**
 * File-system backed session storage.
 *
 * Each session is stored as a single JSON file:
 * ```
 * {sessionDir}/
 *   <sessionId>.json    ← session state
 * ```
 */
export class FileSystemSessionStore implements SessionStore {
  private sessionDir: string;

  constructor(sessionDir?: string) {
    this.sessionDir = path.resolve(sessionDir ?? ".kagent-sessions");
  }

  // ─── SessionStore Implementation ──────────────────────────────────────

  ensureDir(): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  save(id: string, state: SessionState): void {
    this.ensureDir();
    fs.writeFileSync(this.getPath(id), JSON.stringify(state, null, 2), "utf-8");
  }

  load(id: string): SessionState | null {
    try {
      const raw = fs.readFileSync(this.getPath(id), "utf-8");
      const parsed = JSON.parse(raw) as SessionState;

      // Basic structural validation
      if (!parsed.sessionId || !parsed.agentType || !parsed.messages) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    try {
      fs.unlinkSync(this.getPath(id));
    } catch {
      // File doesn't exist — that's fine
    }
  }

  list(): string[] {
    try {
      return fs
        .readdirSync(this.sessionDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  getPath(id: string): string {
    return path.join(this.sessionDir, `${id}.json`);
  }

  getDir(): string {
    return this.sessionDir;
  }
}
