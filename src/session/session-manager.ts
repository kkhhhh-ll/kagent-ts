import { SessionState, SessionStatus } from "./session-types";
import { SessionStore, FileSystemSessionStore } from "./session-store";

/**
 * Configuration for the SessionManager.
 */
export interface SessionManagerConfig {
  /** Explicit session ID. Auto-generated if omitted. */
  sessionId?: string;
  /** Storage directory for session files (default: .kagent-sessions/). */
  sessionDir?: string;
  /**
   * Storage backend. When provided, `sessionDir` is ignored.
   * Omit to use the default file-system store.
   */
  store?: SessionStore;
}

/**
 * Manages session state persistence.
 *
 * Each session is stored via a pluggable {@link SessionStore}. The default
 * file-system store writes one JSON file per session under `sessionDir/`.
 *
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
  private store: SessionStore;

  constructor(config?: SessionManagerConfig) {
    this.sessionId =
      config?.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    validateSessionId(this.sessionId);
    this.store =
      config?.store ??
      new FileSystemSessionStore(config?.sessionDir ?? ".kagent-sessions");
    this.store.ensureDir();
  }

  // ─── Identity ──────────────────────────────────────────────────────────

  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the underlying storage backend.
   * Useful for host systems that need direct access (e.g. session management UIs).
   */
  getStore(): SessionStore {
    return this.store;
  }

  /**
   * Get the session directory path.
   * Delegates to the store when it exposes a directory path.
   */
  getSessionDir(): string {
    return this.store.getDir();
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
   * Save a session checkpoint via the store.
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

    this.store.save(this.sessionId, stateToSave);
  }

  /**
   * Load a session by ID. Returns null if the file is missing or corrupt.
   */
  loadSession(sessionId: string): SessionState | null {
    validateSessionId(sessionId);
    return this.store.load(sessionId);
  }

  /**
   * Return all persisted session states, sorted by `updatedAt` descending.
   */
  listSessions(): SessionState[] {
    const sessions: SessionState[] = [];
    const ids = this.store.list();

    for (const id of ids) {
      const state = this.store.load(id);
      if (state) sessions.push(state);
    }

    sessions.sort(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    );
    return sessions;
  }

  /**
   * Delete a session from the store.
   */
  deleteSession(sessionId: string): void {
    validateSessionId(sessionId);
    this.store.delete(sessionId);
  }

  /**
   * Update the status and timestamp of the current session in-place.
   */
  markStatus(status: SessionStatus): void {
    const state = this.loadSession(this.sessionId);
    if (state) {
      state.status = status;
      state.updatedAt = new Date().toISOString();
      this.saveCheckpoint(state);
    }
  }
}
