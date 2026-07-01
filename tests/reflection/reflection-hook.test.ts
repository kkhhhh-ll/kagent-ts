import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createReflectionHook } from "../../src/reflection/reflection-hook";
import { ErrorNotebook } from "../../src/reflection/error-notebook";
import { MemoryManager } from "../../src/memory/memory-manager";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import { SilentLogger } from "../../src/logging/logger";
import { Role } from "../../src/messages/types";
import type { MessageData } from "../../src/messages/types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-hook-test-"));
}

function makeMessages(userQuery: string): MessageData[] {
  return [
    { role: Role.User, content: userQuery },
    { role: Role.Assistant, content: `Response to: ${userQuery}` },
  ];
}

/**
 * Mock LLM shared by both forks — alternates between error and memory responses.
 * With maxIterations=1, each fork calls chat() exactly once and returns immediately.
 */
function mockDualReflectionLLM(
  errorResponse: object,
  memoryResponse: object,
): LLMProvider {
  let errorDone = false;
  let memoryDone = false;

  return {
    model: "mock-dual",
    chat: async (): Promise<LLMResponse> => {
      if (!errorDone) {
        errorDone = true;
        return {
          content: JSON.stringify({
            thought: "Error reflection complete.",
            answer: JSON.stringify(errorResponse),
          }),
        };
      }
      if (!memoryDone) {
        memoryDone = true;
        return {
          content: JSON.stringify({
            thought: "Memory extraction complete.",
            answer: JSON.stringify(memoryResponse),
          }),
        };
      }
      return {
        content: JSON.stringify({ thought: "No more work.", answer: "{}" }),
      };
    },
    chatStream: async function* () { yield { type: "done" as const }; },
    getTokenCount: () => 10,
  };
}

// ─── Tests: createReflectionHook ────────────────────────────────────────

describe("createReflectionHook", () => {
  let notebookDir: string;
  let notebook: ErrorNotebook;
  let memoryDir: string;
  let memoryManager: MemoryManager;

  beforeEach(() => {
    notebookDir = tempDir();
    notebook = new ErrorNotebook({ storageDir: notebookDir });
    memoryDir = tempDir();
    memoryManager = new MemoryManager(memoryDir);
  });

  afterEach(() => {
    fs.rmSync(notebookDir, { recursive: true, force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // Basic hook creation
  // ════════════════════════════════════════════════════════════════════

  describe("hook creation", () => {
    it("creates a hook with notebook and memoryManager", () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => ({ content: "{}" }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      expect(hook.notebook).toBe(notebook);
      expect(hook.memoryManager).toBe(memoryManager);
      expect(hook.onLLMStart).toBeDefined();
      expect(hook.onFinish).toBeDefined();
    });

    it("marks safeForSubAgent=false to prevent unbounded recursion", () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => ({ content: "{}" }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        notebook,
        maxErrorIterations: 1,
        logger: new SilentLogger(),
      });

      // The hook spawns sub-agents in onFinish — if passed to sub-agents
      // it would cause infinite recursion. This flag lets SubAgentManager
      // automatically filter it out.
      expect(hook.safeForSubAgent).toBe(false);
    });

    it("creates a hook with notebook only (no memoryManager)", () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => ({ content: "{}" }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        notebook,
        maxErrorIterations: 1,
        logger: new SilentLogger(),
      });

      expect(hook.notebook).toBe(notebook);
      expect(hook.memoryManager).toBeNull();
    });

    it("creates a hook with memoryManager only (no notebook)", () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => ({ content: "{}" }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        memoryManager,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      expect(hook.notebook).toBeNull();
      expect(hook.memoryManager).toBe(memoryManager);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // onFinish: parallel forks
  // ════════════════════════════════════════════════════════════════════

  describe("onFinish parallel forks", () => {
    it("runs both error and memory reflectors and persists results", async () => {
      const llm = mockDualReflectionLLM(
        // Error response
        {
          analysis: "Found one issue.",
          score: 75,
          findings: [
            {
              category: "incomplete_answer",
              description: "Missing detail.",
              cause: "Rushed.",
              suggestion: "Add more detail.",
            },
          ],
        },
        // Memory response
        {
          memories: [
            {
              name: "use-prettier",
              description: "Code formatting preference",
              type: "rule",
              content: "Always use Prettier for formatting.\n\n**Why:** User likes consistency.",
            },
          ],
        },
      );

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      // Simulate the agent lifecycle
      const messages = makeMessages("Use Prettier for formatting.");
      hook.onLLMStart!(messages, []);
      await hook.onFinish!("Final answer: I'll use Prettier.");

      // Verify error notebook
      expect(notebook.count).toBe(1);
      const entries = notebook.getAll();
      expect(entries[0].category).toBe("incomplete_answer");

      // Verify memory manager
      expect(memoryManager.count).toBe(1);
      expect(memoryManager.has("use-prettier")).toBe(true);
    });

    it("skips memory extraction when no memoryManager configured", async () => {
      let memoryCalled = false;
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => {
          memoryCalled = true;
          return {
            content: JSON.stringify({
              thought: "Done.",
              answer: JSON.stringify({
                analysis: "All good.",
                score: 100,
                findings: [],
              }),
            }),
          };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        notebook,
        // No memoryManager
        maxErrorIterations: 1,
        logger: new SilentLogger(),
      });

      const messages = makeMessages("Hello.");
      hook.onLLMStart!(messages, []);
      await hook.onFinish!("Hi.");

      // Error reflector ran (called the LLM once)
      expect(memoryCalled).toBe(true);
    });

    it("error reflector failure does not block memory reflector", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => {
          // Throw on every call — both forks will fail
          throw new Error("Simulated LLM outage.");
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      const messages = makeMessages("Test.");
      hook.onLLMStart!(messages, []);

      // Should not throw
      await hook.onFinish!("Answer.");

      // Neither persisted (LLM threw)
      expect(notebook.count).toBe(0);
      expect(memoryManager.count).toBe(0);
    });

    it("calls onReflectionComplete with entry and memory counts", async () => {
      let errorCount = -1;
      let memoryCount = -1;

      const llm = mockDualReflectionLLM(
        // Error: 2 findings
        {
          analysis: "Two issues.",
          score: 60,
          findings: [
            { category: "other", description: "Issue 1.", cause: "c", suggestion: "s" },
            { category: "other", description: "Issue 2.", cause: "c", suggestion: "s" },
          ],
        },
        // Memory: 1 memory
        {
          memories: [
            { name: "test-mem", description: "Test.", type: "rule", content: "Test." },
          ],
        },
      );

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
        onReflectionComplete: (errCount, memCount) => {
          errorCount = errCount;
          memoryCount = memCount;
        },
      });

      const messages = makeMessages("Test.");
      hook.onLLMStart!(messages, []);
      await hook.onFinish!("Done.");

      expect(errorCount).toBe(2);
      expect(memoryCount).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // onLLMStart: conversation capture
  // ════════════════════════════════════════════════════════════════════

  describe("onLLMStart conversation capture", () => {
    it("captures the first user message as the original query", async () => {
      const llm = mockDualReflectionLLM(
        { analysis: "ok", score: 100, findings: [] },
        { memories: [] },
      );

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      // Simulate two LLM calls — the first user message should stick
      hook.onLLMStart!([
        { role: Role.User, content: "First real query." },
      ], []);
      hook.onLLMStart!([
        { role: Role.User, content: "First real query." },
        { role: Role.Assistant, content: "Response." },
        { role: Role.User, content: "Follow-up." },
      ], []);

      // onFinish should have the first query captured
      await hook.onFinish!("Final.");

      // No error — hook completed without crashing
      expect(notebook.count).toBe(0);
    });

    it("skips sub-agent system messages when detecting user query", async () => {
      const llm = mockDualReflectionLLM(
        { analysis: "ok", score: 100, findings: [] },
        { memories: [] },
      );

      const hook = createReflectionHook({
        llm,
        notebook,
        memoryManager,
        maxErrorIterations: 1,
        maxMemoryIterations: 1,
        logger: new SilentLogger(),
      });

      // First user message starts with [Sub-agent — should be skipped
      // and the next real user message should be used instead
      hook.onLLMStart!([
        { role: Role.User, content: "[Sub-agent explorer] result data." },
        { role: Role.Assistant, content: "Processing." },
        { role: Role.User, content: "What is the capital of France?" },
      ], []);

      await hook.onFinish!("Paris.");

      // No crash — query was captured correctly
      expect(notebook.count).toBe(0);
    });
  });
});
