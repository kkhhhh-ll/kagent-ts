import * as fs from "fs";
import * as path from "path";
import { SessionState, SessionStatus } from "./session-types";

/**
 * Configuration for the SessionManager.
 */
export interface SessionManagerConfig {
  /** Explicit session ID. Auto-generated if omitted. */
  sessionId?: string;
  /** Storage directory for session files (default: .kagent-sessions/). */
  sessionDir?: string;
}

/**
 * Manages session state persistence to disk.
 *
 * Each session is stored as a single JSON file in the configured directory.
 * Sessions are self-contained (messages are inline) so they survive any
 * memory/component lifecycle and can be resumed after process restarts.
 */

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid session ID: "${id}". ` +
      `Session IDs must only contain alphanumeric characters, hyphens, and underscores.`,
    );
  }
}

export class SessionManager {
  private sessionId: string;
  private sessionDir: string;

  constructor(config?: SessionManagerConfig) {
    this.sessionId =
      config?.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    validateSessionId(this.sessionId);
    this.sessionDir = path.resolve(config?.sessionDir ?? ".kagent-sessions");
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  // ─── Identity ──────────────────────────────────────────────────────────

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  /**
   * Set the session ID (used during resume to match the restored session).
   */
  setSessionId(id: string): void {
    validateSessionId(id);
    this.sessionId = id;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Get the file path for the current session.
   */
  private filePath(): string {
    return path.join(this.sessionDir, `${this.sessionId}.json`);
  }

  /**
   * Save a session checkpoint to disk.
   *
   * Preserves the original `createdAt` timestamp so resuming a session
   * retains the original creation time. Updates `updatedAt` to now.
   */
  saveCheckpoint(state: SessionState): void {
    // Preserve the original createdAt (don't overwrite with a later timestamp)
    const existing = this.loadSession(this.sessionId);
    const stateToSave: SessionState = {
      ...state,
      createdAt: existing?.createdAt ?? state.createdAt,
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(this.filePath(), JSON.stringify(stateToSave, null, 2), "utf-8");
  }

  /**
   * Load a session by ID. Returns null if the file is missing or corrupt.
   */
  loadSession(sessionId: string): SessionState | null {
    validateSessionId(sessionId);
    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
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

  /**
   * Return all persisted session states, sorted by `updatedAt` descending.
   */
  listSessions(): SessionState[] {
    const sessions: SessionState[] = [];

    try {
      const files = fs.readdirSync(this.sessionDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const sessionId = file.slice(0, -".json".length);
        const state = this.loadSession(sessionId);
        if (state) sessions.push(state);
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    sessions.sort(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    );
    return sessions;
  }

  /**
   * Delete a session file from disk.
   */
  deleteSession(sessionId: string): void {
    validateSessionId(sessionId);
    const filePath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File doesn't exist — that's fine
    }
  }

  /**
   * Update the status and timestamp of a session in-place.
   */
  markStatus(sessionId: string, status: SessionStatus): void {
    validateSessionId(sessionId);
    const state = this.loadSession(sessionId);
    if (state) {
      state.status = status;
      state.updatedAt = new Date().toISOString();
      this.saveCheckpoint(state);
    }
  }
}
