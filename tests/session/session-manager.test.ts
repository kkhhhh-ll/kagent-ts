import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SessionManager } from "../../src/session/session-manager";
import type { SessionState } from "../../src/session/session-types";
import { Role } from "../../src/messages/types";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-test-"));
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "sess-1",
    agentType: "react",
    systemPrompt: "You are helpful.",
    messages: [
      { role: Role.System, content: "sys" },
      { role: Role.User, content: "hello" },
      { role: Role.Assistant, content: "hi!" },
    ],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    status: "active",
    ...overrides,
  };
}

describe("SessionManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates session directory on construction", () => {
    const sm = new SessionManager({ sessionDir: dir });
    expect(fs.existsSync(dir)).toBe(true);
    expect(sm.getSessionDir()).toBe(dir);
  });

  it("generates a session ID if not provided", () => {
    const sm = new SessionManager({ sessionDir: dir });
    expect(sm.getSessionId()).toBeTruthy();
  });

  it("saveCheckpoint and loadSession round-trip", () => {
    const sm = new SessionManager({ sessionId: "sess-1", sessionDir: dir });
    const state = makeState({ sessionId: "sess-1" });
    sm.saveCheckpoint(state);

    const loaded = sm.loadSession("sess-1")!;
    expect(loaded).not.toBeNull();
    expect(loaded.sessionId).toBe("sess-1");
    expect(loaded.agentType).toBe("react");
    expect(loaded.systemPrompt).toBe("You are helpful.");
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.status).toBe("active");
  });

  it("returns null for missing session", () => {
    const sm = new SessionManager({ sessionDir: dir });
    expect(sm.loadSession("nonexistent")).toBeNull();
  });

  it("returns null for corrupt session file", () => {
    const sm = new SessionManager({ sessionId: "bad", sessionDir: dir });
    sm.saveCheckpoint(makeState());
    fs.writeFileSync(path.join(dir, "bad.json"), "not json");
    expect(sm.loadSession("bad")).toBeNull();
  });

  it("preserves createdAt on re-save", () => {
    const sm = new SessionManager({ sessionId: "sess-1", sessionDir: dir });
    sm.saveCheckpoint(makeState({ createdAt: "2025-06-01T00:00:00Z" }));
    // Save again
    sm.saveCheckpoint(makeState({ createdAt: "SHOULD-BE-OVERWRITTEN" }));
    const loaded = sm.loadSession("sess-1")!;
    expect(loaded.createdAt).toBe("2025-06-01T00:00:00Z");
  });

  it("listSessions returns all saved sessions", () => {
    const sm1 = new SessionManager({ sessionId: "a", sessionDir: dir });
    const sm2 = new SessionManager({ sessionId: "b", sessionDir: dir });
    sm1.saveCheckpoint(makeState({ sessionId: "a" }));
    sm2.saveCheckpoint(makeState({ sessionId: "b" }));

    const sessions = sm1.listSessions();
    expect(sessions.length).toBe(2);
  });

  it("deleteSession removes the file", () => {
    const sm = new SessionManager({ sessionId: "sess-1", sessionDir: dir });
    sm.saveCheckpoint(makeState());
    sm.deleteSession("sess-1");
    expect(sm.loadSession("sess-1")).toBeNull();
  });

  it("markStatus updates status in-place", () => {
    const sm = new SessionManager({ sessionId: "sess-1", sessionDir: dir });
    sm.saveCheckpoint(makeState({ status: "active" }));
    sm.markStatus("sess-1", "completed");
    const loaded = sm.loadSession("sess-1")!;
    expect(loaded.status).toBe("completed");
  });

  it("setSessionId changes the session identity", () => {
    const sm = new SessionManager({ sessionDir: dir });
    sm.setSessionId("new-id");
    expect(sm.getSessionId()).toBe("new-id");
  });
});
