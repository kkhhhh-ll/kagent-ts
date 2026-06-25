import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ReflectionAgent } from "../../src/reflection/reflection-agent";
import type { ReflectionInput } from "../../src/reflection/reflection-agent";
import { ErrorNotebook } from "../../src/reflection/error-notebook";
import type { ErrorNotebookEntry } from "../../src/reflection/error-notebook";
import type { LLMProvider, LLMResponse } from "../../src/llm/interface";
import { Role } from "../../src/messages/types";
import type { MessageData } from "../../src/messages/types";

// ─── Helpers ─────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-reflection-test-"));
}

function makeReflectionInput(overrides: Partial<ReflectionInput> = {}): ReflectionInput {
  return {
    userQuery: "What is 2+2?",
    finalAnswer: "The answer is 4.",
    conversation: [
      { role: Role.System, content: "You are helpful." },
      { role: Role.User, content: "What is 2+2?" },
      { role: Role.Assistant, content: "The answer is 4." },
    ],
    sessionId: "sess-test-1",
    ...overrides,
  };
}

function mockReflectionLLM(response: object): LLMProvider {
  return {
    model: "mock-reflection",
    chat: async (): Promise<LLMResponse> => ({
      content: JSON.stringify(response),
    }),
    chatStream: async function* () { yield { type: "done" as const }; },
    getTokenCount: () => 10,
  };
}

function mockSequenceReflectionLLM(responses: Array<object | string>): LLMProvider {
  let callCount = 0;
  return {
    model: "mock-reflection",
    chat: async (): Promise<LLMResponse> => {
      const idx = Math.min(callCount, responses.length - 1);
      const raw = responses[idx];
      callCount++;
      const content = typeof raw === "string" ? raw : JSON.stringify(raw);
      return { content };
    },
    chatStream: async function* () { yield { type: "done" as const }; },
    getTokenCount: () => 10,
  };
}

// ─── Tests: ReflectionAgent ─────────────────────────────────────────────

describe("ReflectionAgent", () => {
  let notebookDir: string;
  let notebook: ErrorNotebook;

  beforeEach(() => {
    notebookDir = tempDir();
    notebook = new ErrorNotebook({ storageDir: notebookDir });
  });

  afterEach(() => {
    fs.rmSync(notebookDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // Basic reflection
  // ════════════════════════════════════════════════════════════════════

  describe("basic reflect", () => {
    it("returns findings after a single reflection pass", async () => {
      const llm = mockReflectionLLM({
        analysis: "The agent answered correctly but could elaborate.",
        score: 70,
        findings: [
          {
            category: "incomplete_answer",
            description: "Answer is too brief.",
            cause: "Agent didn't explain the reasoning.",
            suggestion: "Include step-by-step explanation.",
          },
        ],
        improvements: ["Add more detail to answers."],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      const input = makeReflectionInput();

      const entries = await reflector.reflect(input);
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("incomplete_answer");
      expect(entries[0].description).toBe("Answer is too brief.");
      expect(entries[0].sessionId).toBe("sess-test-1");
    });

    it("returns empty array for a perfect session (score 100, no findings)", async () => {
      const llm = mockReflectionLLM({
        analysis: "Flawless execution.",
        score: 100,
        findings: [],
        improvements: [],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      const input = makeReflectionInput();

      const entries = await reflector.reflect(input);
      expect(entries).toHaveLength(0);
    });

    it("persists findings to the ErrorNotebook", async () => {
      const llm = mockReflectionLLM({
        analysis: "Two issues found.",
        score: 65,
        findings: [
          {
            category: "tool_misuse",
            description: "Used the wrong tool.",
            cause: "Confused 'read' with 'write'.",
            suggestion: "Double-check tool names before calling.",
          },
          {
            category: "hallucination",
            description: "Fabricated an API endpoint.",
            cause: "LLM guessed instead of checking docs.",
            suggestion: "Always verify APIs before calling.",
          },
        ],
        improvements: ["Be more careful.", "Verify before acting."],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      await reflector.reflect(makeReflectionInput());

      const all = notebook.getAll();
      expect(all).toHaveLength(2);
      expect(all[0].category).toBe("tool_misuse");
      expect(all[1].category).toBe("hallucination");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Multi-iteration refinement
  // ════════════════════════════════════════════════════════════════════

  describe("multi-iteration refinement", () => {
    it("runs multiple iterations when maxIterations > 1", async () => {
      const llm = mockSequenceReflectionLLM([
        // Iteration 1: first finding
        {
          analysis: "First pass — found one issue.",
          score: 70,
          findings: [
            {
              category: "reasoning_error",
              description: "Flawed deduction in step 2.",
              cause: "Incorrect assumption about data format.",
              suggestion: "Validate data format before processing.",
            },
          ],
          improvements: ["Check assumptions."],
        },
        // Iteration 2: finds another issue
        {
          analysis: "Second pass — found another issue.",
          score: 65,
          findings: [
            {
              category: "missed_optimization",
              description: "Could have batched two calls.",
              cause: "Agent made sequential calls unnecessarily.",
              suggestion: "Batch independent tool calls together.",
            },
          ],
          improvements: ["Batch calls."],
        },
      ]);

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });
      const entries = await reflector.reflect(makeReflectionInput());

      // Both iterations' findings should be present (dedup'd by description)
      expect(entries.length).toBe(2);
      const categories = entries.map((e) => e.category);
      expect(categories).toContain("reasoning_error");
      expect(categories).toContain("missed_optimization");
    });

    it("deduplicates findings with the same category and description", async () => {
      const llm = mockSequenceReflectionLLM([
        {
          analysis: "Found issue.",
          score: 70,
          findings: [
            {
              category: "incomplete_answer",
              description: "Missing details.",
              cause: "Agent rushed.",
              suggestion: "Take more time.",
            },
          ],
          improvements: ["Be thorough."],
        },
        // Iteration 2: same finding again (should be deduplicated)
        {
          analysis: "Same issue again.",
          score: 70,
          findings: [
            {
              category: "incomplete_answer",
              description: "Missing details.",
              cause: "Same cause.",
              suggestion: "Same suggestion.",
            },
          ],
          improvements: ["Still be thorough."],
        },
      ]);

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });
      const entries = await reflector.reflect(makeReflectionInput());

      expect(entries).toHaveLength(1);
    });

    it("exits early when score >= 95 and no new findings", async () => {
      let callCount = 0;
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => {
          callCount++;
          return {
            content: JSON.stringify({
              analysis: "Almost perfect.",
              score: 96,
              findings: [],
              improvements: [],
            }),
          };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 5 });
      const entries = await reflector.reflect(makeReflectionInput());

      expect(entries).toHaveLength(0);
      // Should exit after the first iteration (score 96 >= 95, no findings)
      expect(callCount).toBe(1);
    });

    it("continues refining when score is high but findings exist", async () => {
      const llm = mockSequenceReflectionLLM([
        {
          analysis: "Good, but one small issue.",
          score: 96,
          findings: [
            {
              category: "other",
              description: "Minor formatting inconsistency.",
              cause: "No formatting rules in prompt.",
              suggestion: "Add formatting guidelines.",
            },
          ],
          improvements: ["Format consistently."],
        },
        // Iteration 2: now perfect
        {
          analysis: "All resolved.",
          score: 100,
          findings: [],
          improvements: [],
        },
      ]);

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });
      const entries = await reflector.reflect(makeReflectionInput());

      // First iteration had a finding → should be recorded
      // Second iteration is perfect → exits early
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("other");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // JSON parsing resilience
  // ════════════════════════════════════════════════════════════════════

  describe("JSON parsing", () => {
    it("parses responses wrapped in ```json fences", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content:
            '```json\n{"analysis": "ok", "score": 80, "findings": [], "improvements": []}\n```',
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new ReflectionAgent({ llm, notebook });
      const entries = await reflector.reflect(makeReflectionInput());
      expect(entries).toHaveLength(0);
    });

    it("parses raw JSON without markdown fences", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content:
            '{"analysis": "Found issues.", "score": 50, "findings": [{"category": "other", "description": "Weird bug.", "cause": "Unknown.", "suggestion": "Investigate further."}], "improvements": ["Debug more."]}',
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new ReflectionAgent({ llm, notebook });
      const entries = await reflector.reflect(makeReflectionInput());
      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe("Weird bug.");
    });

    it("skips malformed JSON responses gracefully (iteration continues)", async () => {
      const llm = mockSequenceReflectionLLM([
        // Iteration 1: garbage
        "not valid json at all {{{",
        // Iteration 2: valid
        {
          analysis: "Recovered.",
          score: 80,
          findings: [
            {
              category: "context_mismanagement",
              description: "Context grew too large.",
              cause: "No compression step.",
              suggestion: "Compress after each iteration.",
            },
          ],
          improvements: ["Compress context."],
        },
      ]);

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });
      const entries = await reflector.reflect(makeReflectionInput());
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("context_mismanagement");
    });

    it("skips findings with invalid/missing fields", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content: JSON.stringify({
            analysis: "Mixed findings.",
            score: 50,
            findings: [
              // Valid finding
              {
                category: "other",
                description: "Valid finding.",
                cause: "Known.",
                suggestion: "Fix it.",
              },
              // Missing required fields — should be skipped
              { category: "other" },
              // Wrong category — should be skipped
              {
                category: "nonexistent_category",
                description: "Bad category.",
                cause: "?",
                suggestion: "?",
              },
              // Not an object
              "just a string",
            ],
            improvements: ["Better validation."],
          }),
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new ReflectionAgent({ llm, notebook });
      const entries = await reflector.reflect(makeReflectionInput());
      // Only the first (valid) finding should be accepted
      expect(entries).toHaveLength(1);
      expect(entries[0].description).toBe("Valid finding.");
    });

    it("returns empty findings for completely unparseable responses", async () => {
      const llm: LLMProvider = {
        model: "mock",
        chat: async (): Promise<LLMResponse> => ({
          content: "I cannot analyze this session. It is too complex.",
        }),
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 1 });
      const entries = await reflector.reflect(makeReflectionInput());
      expect(entries).toHaveLength(0);
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

      const llm = mockReflectionLLM({
        analysis: "Long conversation handled.",
        score: 85,
        findings: [],
        improvements: [],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      const input = makeReflectionInput({ conversation: longConversation });

      // Should not throw
      const entries = await reflector.reflect(input);
      expect(entries).toHaveLength(0);
    });

    it("handles missing errorTraces gracefully", async () => {
      const llm = mockReflectionLLM({
        analysis: "No traces provided.",
        score: 90,
        findings: [],
        improvements: [],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      const input = makeReflectionInput();
      delete (input as any).errorTraces;

      const entries = await reflector.reflect(input);
      expect(entries).toHaveLength(0);
    });

    it("writes entries with all optional fields populated", async () => {
      const llm = mockReflectionLLM({
        analysis: "Complex issue.",
        score: 55,
        findings: [
          {
            category: "tool_misuse",
            description: "Wrong arguments passed.",
            cause: "Parameter confusion.",
            suggestion: "Check parameter schema.",
            relatedTraceIds: ["trace_abc123", "trace_def456"],
          },
        ],
        improvements: ["Verify parameters."],
      });

      const reflector = new ReflectionAgent({ llm, notebook });
      const input = makeReflectionInput({ userQuery: "Execute the migration." });

      const entries = await reflector.reflect(input);
      expect(entries).toHaveLength(1);
      expect(entries[0].userQuery).toBe("Execute the migration.");
      expect(entries[0].relatedTraceIds).toEqual(["trace_abc123", "trace_def456"]);
    });
  });
});

// ─── Tests: ErrorNotebook ───────────────────────────────────────────────

describe("ErrorNotebook", () => {
  let notebookDir: string;
  let notebook: ErrorNotebook;

  beforeEach(() => {
    notebookDir = tempDir();
    notebook = new ErrorNotebook({ storageDir: notebookDir });
  });

  afterEach(() => {
    fs.rmSync(notebookDir, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // CRUD
  // ════════════════════════════════════════════════════════════════════

  describe("add and retrieve", () => {
    it("adds an entry and returns it with generated id and timestamp", () => {
      const entry = notebook.add({
        sessionId: "sess-1",
        category: "reasoning_error",
        description: "Bad logic.",
        cause: "Wrong assumption.",
        suggestion: "Verify assumptions.",
      });

      expect(entry.id).toMatch(/^nb_/);
      expect(entry.timestamp).toBeTruthy();
      expect(entry.sessionId).toBe("sess-1");
      expect(entry.category).toBe("reasoning_error");
    });

    it("addMany adds multiple entries at once", () => {
      notebook.addMany([
        { sessionId: "sess-1", category: "tool_misuse", description: "D1", cause: "C1", suggestion: "S1" },
        { sessionId: "sess-1", category: "hallucination", description: "D2", cause: "C2", suggestion: "S2" },
        { sessionId: "sess-2", category: "other", description: "D3", cause: "C3", suggestion: "S3" },
      ]);

      expect(notebook.count).toBe(3);
    });

    it("remove deletes an entry by id", () => {
      const entry = notebook.add({
        sessionId: "sess-1",
        category: "other",
        description: "Temp.",
        cause: "T",
        suggestion: "S",
      });

      expect(notebook.count).toBe(1);
      const removed = notebook.remove(entry.id);
      expect(removed).toBe(true);
      expect(notebook.count).toBe(0);
    });

    it("remove returns false for non-existent id", () => {
      expect(notebook.remove("nb_nonexistent")).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Queries
  // ════════════════════════════════════════════════════════════════════

  describe("queries", () => {
    beforeEach(() => {
      notebook.addMany([
        { sessionId: "sess-A", category: "reasoning_error", description: "D1", cause: "C1", suggestion: "S1" },
        { sessionId: "sess-A", category: "tool_misuse", description: "D2", cause: "C2", suggestion: "S2" },
        { sessionId: "sess-B", category: "reasoning_error", description: "D3", cause: "C3", suggestion: "S3" },
        { sessionId: "sess-B", category: "incomplete_answer", description: "D4", cause: "C4", suggestion: "S4" },
        { sessionId: "sess-B", category: "hallucination", description: "D5", cause: "C5", suggestion: "S5" },
      ]);
    });

    it("getAll returns all entries", () => {
      const all = notebook.getAll();
      expect(all).toHaveLength(5);
    });

    it("getBySession filters by sessionId", () => {
      const sessA = notebook.getBySession("sess-A");
      expect(sessA).toHaveLength(2);
      expect(sessA.every((e) => e.sessionId === "sess-A")).toBe(true);
    });

    it("getRecent returns most recent entries first", () => {
      const recent = notebook.getRecent(3);
      expect(recent).toHaveLength(3);
      // Timestamps should be in descending order
      for (let i = 1; i < recent.length; i++) {
        expect(recent[i - 1].timestamp >= recent[i].timestamp).toBe(true);
      }
    });

    it("getByCategory filters by error category", () => {
      const reasoning = notebook.getByCategory("reasoning_error");
      expect(reasoning).toHaveLength(2);
      expect(reasoning.every((e) => e.category === "reasoning_error")).toBe(true);
    });

    it("count returns the number of entries", () => {
      expect(notebook.count).toBe(5);
    });

    it("getCategoryStats returns distribution", () => {
      const stats = notebook.getCategoryStats();
      expect(stats.reasoning_error).toBe(2);
      expect(stats.tool_misuse).toBe(1);
      expect(stats.incomplete_answer).toBe(1);
      expect(stats.hallucination).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // buildRulesPrompt
  // ════════════════════════════════════════════════════════════════════

  describe("buildRulesPrompt", () => {
    it("returns empty string when no entries exist", () => {
      const prompt = notebook.buildRulesPrompt();
      expect(prompt).toBe("");
    });

    it("builds a prompt from recent entries", () => {
      notebook.add({
        sessionId: "sess-1",
        category: "tool_misuse",
        description: "Used read instead of write.",
        cause: "Typo in tool name.",
        suggestion: "Always double-check tool names before calling.",
      });

      const prompt = notebook.buildRulesPrompt();
      expect(prompt).toContain("Error Notebook");
      expect(prompt).toContain("错题本");
      expect(prompt).toContain("Tool Misuse");
      expect(prompt).toContain("double-check tool names");
    });

    it("groups repeated entries with a count marker", () => {
      // Add the same error three times
      for (let i = 0; i < 3; i++) {
        notebook.add({
          sessionId: `sess-${i}`,
          category: "hallucination",
          description: "Made up an API.",
          cause: "No API docs reference.",
          suggestion: "Only use documented APIs.",
        });
      }

      const prompt = notebook.buildRulesPrompt(10, 1);
      expect(prompt).toContain("×3");
    });

    it("filters out entries below minRepetitions threshold", () => {
      // Add one entry once, another entry twice
      // Use different descriptions so they don't get grouped together
      notebook.add({ sessionId: "s1", category: "other", description: "Rare bug happened once.", cause: "C", suggestion: "Handle rare bug." });
      notebook.add({ sessionId: "s2", category: "tool_misuse", description: "Same wrong tool used again.", cause: "C", suggestion: "Check tool name before calling." });
      notebook.add({ sessionId: "s3", category: "tool_misuse", description: "Same wrong tool used again.", cause: "C", suggestion: "Check tool name before calling." });

      const prompt = notebook.buildRulesPrompt(10, 2); // minRepetitions = 2
      // The prompt shows suggestion text, and the (×2) repetition marker
      expect(prompt).toContain("(×2)");
      expect(prompt).toContain("Check tool name before calling.");
      expect(prompt).not.toContain("Rare bug");
    });

    it("respects maxEntries limit", () => {
      // Add 5 different entries
      for (let i = 0; i < 5; i++) {
        notebook.add({ sessionId: "s", category: "other", description: `Issue ${i}`, cause: "C", suggestion: "S" });
      }

      const prompt = notebook.buildRulesPrompt(2, 1);
      // Should only contain 2 entries
      const matches = prompt.match(/❓ Other/g);
      expect(matches?.length ?? 0).toBeLessThanOrEqual(2);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Pruning
  // ════════════════════════════════════════════════════════════════════

  describe("pruning", () => {
    it("prunes oldest entries when exceeding maxEntries", () => {
      const smallBook = new ErrorNotebook({ storageDir: tempDir(), maxEntries: 3 });

      for (let i = 0; i < 5; i++) {
        smallBook.add({ sessionId: "s", category: "other", description: `Issue ${i}`, cause: "C", suggestion: "S" });
      }

      expect(smallBook.count).toBe(3);
      const all = smallBook.getAll();
      const descriptions = all.map((e) => e.description);
      // Oldest entries (Issue 0, Issue 1) should be pruned
      expect(descriptions).not.toContain("Issue 0");
      expect(descriptions).not.toContain("Issue 1");
      expect(descriptions).toContain("Issue 2");
      expect(descriptions).toContain("Issue 3");
      expect(descriptions).toContain("Issue 4");

      fs.rmSync((smallBook as any).storageDir, { recursive: true, force: true });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Markdown report
  // ════════════════════════════════════════════════════════════════════

  describe("generateMarkdownReport", () => {
    it("returns a placeholder when no entries exist", () => {
      const report = notebook.generateMarkdownReport();
      expect(report).toContain("No errors recorded");
    });

    it("generates a report with category distribution", () => {
      notebook.addMany([
        { sessionId: "sess-1", category: "reasoning_error", description: "D1", cause: "C1", suggestion: "S1" },
        { sessionId: "sess-1", category: "reasoning_error", description: "D2", cause: "C2", suggestion: "S2" },
        { sessionId: "sess-2", category: "tool_misuse", description: "D3", cause: "C3", suggestion: "S3" },
      ]);

      const report = notebook.generateMarkdownReport();
      expect(report).toContain("**Total entries:** 3");
      expect(report).toContain("Reasoning Error");
      expect(report).toContain("Tool Misuse");
      expect(report).toContain("D1");
      expect(report).toContain("sess-1");
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // Persistence
  // ════════════════════════════════════════════════════════════════════

  describe("persistence", () => {
    it("survives a reload from disk (loads index and entries)", () => {
      notebook.add({
        sessionId: "persist-test",
        category: "hallucination",
        description: "Made up a function signature.",
        cause: "Overconfident guess.",
        suggestion: "Verify with docs first.",
      });

      // Create a new notebook with the same directory — it should load the index
      const reloaded = new ErrorNotebook({ storageDir: notebookDir });
      expect(reloaded.count).toBe(1);

      const all = reloaded.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].sessionId).toBe("persist-test");
      expect(all[0].category).toBe("hallucination");
      expect(all[0].description).toBe("Made up a function signature.");
    });

    it("handles empty/corrupt index gracefully (starts fresh)", () => {
      // Write garbage to the index file
      const indexFile = path.join(notebookDir, "index.json");
      fs.writeFileSync(indexFile, "garbage{{{not json", "utf-8");

      const fresh = new ErrorNotebook({ storageDir: notebookDir });
      expect(fresh.count).toBe(0);
    });

    it("handles missing entry files gracefully", () => {
      // Add an entry, then manually delete the entry file
      const entry = notebook.add({
        sessionId: "ghost",
        category: "other",
        description: "Ghost entry.",
        cause: "?",
        suggestion: "?",
      });

      const entryFile = path.join(notebookDir, "entries", `${entry.id}.json`);
      fs.unlinkSync(entryFile);

      // getBySession should skip the missing file
      const results = notebook.getBySession("ghost");
      expect(results).toHaveLength(0);
    });
  });
});
