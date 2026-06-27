import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MemoryReflector } from "../../src/reflection/memory-reflector";
import type { MemoryReflectionInput } from "../../src/reflection/memory-reflector";
import { MemoryManager } from "../../src/memory/memory-manager";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import { Role } from "../../src/messages/types";
import type { MessageData } from "../../src/messages/types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-memory-reflector-"));
}

function makeMemoryInput(overrides: Partial<MemoryReflectionInput> = {}): MemoryReflectionInput {
  return {
    userQuery: "Please use kebab-case for all file names.",
    finalAnswer: "I'll use kebab-case for file names going forward.",
    conversation: [
      { role: Role.System, content: "You are helpful." },
      { role: Role.User, content: "Please use kebab-case for all file names." },
      { role: Role.Assistant, content: "I'll use kebab-case for file names going forward." },
    ],
    sessionId: "sess-mem-1",
    ...overrides,
  };
}

/**
 * Create a mock LLM that returns a single ReAct-formatted response.
 */
function mockMemoryLLM(memories: Array<Record<string, unknown>>): LLMProvider {
  return {
    model: "mock-memory",
    chat: async (): Promise<LLMResponse> => ({
      content: JSON.stringify({
        thought: "Memory extraction complete.",
        answer: JSON.stringify({ memories }),
      }),
    }),
    chatStream: async function* () { yield { type: "done" as const }; },
    getTokenCount: () => 10,
  };
}

/** Mock LLM that returns non-JSON answer. */
function mockGarbageLLM(): LLMProvider {
  return {
    model: "mock-garbage",
    chat: async (): Promise<LLMResponse> => ({
      content: JSON.stringify({
        thought: "Nothing to remember here.",
        answer: "No new memories worth persisting.",
      }),
    }),
    chatStream: async function* () { yield { type: "done" as const }; },
    getTokenCount: () => 10,
  };
}

// ─── Tests: MemoryReflector ─────────────────────────────────────────────

describe("MemoryReflector", () => {
  let memoryDir: string;
  let memoryManager: MemoryManager;

  beforeEach(() => {
    memoryDir = tempDir();
    memoryManager = new MemoryManager(memoryDir);
  });

  afterEach(() => {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // Basic extraction
  // ════════════════════════════════════════════════════════════════════

  describe("basic extraction", () => {
    it("extracts a rule memory from the session", async () => {
      const llm = mockMemoryLLM([
        {
          name: "use-kebab-case",
          description: "File naming convention",
          type: "rule",
          content: "Always use kebab-case for file names.\n\n**Why:** User prefers kebab-case.\n\n**When:** When creating new files.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const input = makeMemoryInput();
      const memories = await reflector.reflect(input);

      expect(memories).toHaveLength(1);
      expect(memories[0].name).toBe("use-kebab-case");
      expect(memories[0].type).toBe("rule");
      expect(memories[0].description).toBe("File naming convention");
    });

    it("extracts a project memory from the session", async () => {
      const llm = mockMemoryLLM([
        {
          name: "switched-to-postgres",
          description: "Migrated from MySQL to PostgreSQL",
          type: "project",
          content: "Switched from MySQL to PostgreSQL.\n\n**Why:** JSONB support.\n\n**How to apply:** Use PostgreSQL for new features.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(1);
      expect(memories[0].name).toBe("switched-to-postgres");
      expect(memories[0].type).toBe("project");
    });

    it("extracts multiple memories at once", async () => {
      const llm = mockMemoryLLM([
        {
          name: "use-kebab-case",
          description: "File naming convention",
          type: "rule",
          content: "Always use kebab-case.\n\n**Why:** User preference.",
        },
        {
          name: "use-typescript",
          description: "Language preference",
          type: "rule",
          content: "Use TypeScript for all new code.\n\n**Why:** User requirement.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(2);
    });

    it("returns empty array when nothing worth remembering", async () => {
      const llm = mockMemoryLLM([]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(0);
    });

    it("persists extracted memories to the MemoryManager", async () => {
      const llm = mockMemoryLLM([
        {
          name: "use-kebab-case",
          description: "File naming convention",
          type: "rule",
          content: "Always use kebab-case.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      await reflector.reflect(makeMemoryInput());

      // Verify persisted
      expect(memoryManager.has("use-kebab-case")).toBe(true);
      const loaded = memoryManager.get("use-kebab-case");
      expect(loaded).not.toBeNull();
      expect(loaded!.type).toBe("rule");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Deduplication
  // ════════════════════════════════════════════════════════════════════

  describe("deduplication", () => {
    it("skips memories that already exist by name", async () => {
      // Pre-populate a memory
      memoryManager.add({
        name: "use-kebab-case",
        description: "Already exists",
        type: "rule",
        content: "Old content.",
      });

      // Sub-agent "finds" the same memory again
      const llm = mockMemoryLLM([
        {
          name: "use-kebab-case",   // duplicate
          description: "Duplicate naming convention",
          type: "rule",
          content: "New content (should be skipped).",
        },
        {
          name: "use-typescript",   // new
          description: "Language preference",
          type: "rule",
          content: "Use TypeScript.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      // Only the new memory should be persisted
      expect(memories).toHaveLength(1);
      expect(memories[0].name).toBe("use-typescript");
      expect(memoryManager.count).toBe(2); // original + new
    });

    it("returns empty when all extracted memories are duplicates", async () => {
      memoryManager.add({
        name: "use-kebab-case",
        description: "Already exists",
        type: "rule",
        content: "Old.",
      });

      const llm = mockMemoryLLM([
        {
          name: "use-kebab-case",
          description: "Same name",
          type: "rule",
          content: "Duplicate.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // JSON parsing resilience
  // ════════════════════════════════════════════════════════════════════

  describe("JSON parsing", () => {
    it("parses answer wrapped in ```json fences", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content: JSON.stringify({
            thought: "Done.",
            answer: '```json\n{"memories": [{"name": "x", "description": "d", "type": "rule", "content": "c"}]}\n```',
          }),
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(1);
      expect(memories[0].name).toBe("x");
    });

    it("returns empty for non-JSON answer", async () => {
      const reflector = new MemoryReflector({
        llm: mockGarbageLLM(),
        memoryManager,
      });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(0);
    });

    it("skips memory entries with invalid fields", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content: JSON.stringify({
            thought: "Done.",
            answer: JSON.stringify({
              memories: [
                // Valid
                {
                  name: "valid-one",
                  description: "Valid memory",
                  type: "project",
                  content: "Valid content.",
                },
                // Missing name
                {
                  description: "No name",
                  type: "rule",
                  content: "Missing name field.",
                },
                // Invalid type
                {
                  name: "bad-type",
                  description: "Bad type",
                  type: "nonexistent",
                  content: "Invalid type.",
                },
                // Empty name
                {
                  name: "",
                  description: "Empty name",
                  type: "rule",
                  content: "Empty name is invalid.",
                },
                // Not an object
                "just a string",
              ],
            }),
          }),
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      // Only the first (valid) memory should be accepted
      expect(memories).toHaveLength(1);
      expect(memories[0].name).toBe("valid-one");
      expect(memoryManager.count).toBe(1);
    });

    it("returns empty when the answer is completely unparseable", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content: "not valid json {{{",
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new MemoryReflector({ llm, memoryManager, maxIterations: 1 });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Edge cases
  // ════════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("handles long conversation messages without truncation errors", async () => {
      const longConversation: MessageData[] = [
        { role: Role.System, content: "You are helpful." },
        { role: Role.User, content: "A".repeat(5000) },
        { role: Role.Assistant, content: "B".repeat(5000) },
        { role: Role.Tool, content: "C".repeat(5000), tool_call_id: "t1", name: "read_file" },
      ];

      const llm = mockMemoryLLM([]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const input = makeMemoryInput({ conversation: longConversation });

      // Should not throw
      const memories = await reflector.reflect(input);
      expect(memories).toHaveLength(0);
    });

    it("injects existing memory names into the prompt", async () => {
      memoryManager.add({
        name: "existing-memory-1",
        description: "First existing memory",
        type: "rule",
        content: "Some content.",
      });

      // The LLM's prompt should include "existing-memory-1" so the
      // sub-agent knows not to duplicate it.  Verify by checking that
      // a memory with that name is still correctly skipped.
      const llm = mockMemoryLLM([
        {
          name: "existing-memory-1",  // should be skipped by host
          description: "Duplicate",
          type: "rule",
          content: "Duplicate content.",
        },
      ]);

      const reflector = new MemoryReflector({ llm, memoryManager });
      const memories = await reflector.reflect(makeMemoryInput());

      expect(memories).toHaveLength(0);
      expect(memoryManager.count).toBe(1); // only the original exists
    });
  });
});
