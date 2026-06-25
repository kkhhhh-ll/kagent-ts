import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ReActAgent } from "../../src/core/react-agent";
import { ContextManager } from "../../src/context/context-manager";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import {
  mockAnswerLLM,
  mockSequenceLLM,
  answerContent,
} from "../mocks/mock-llm-provider";
import type { Tool } from "../../src/tools/types";

// ─── Test tools ────────────────────────────────────────────────────────

const echoTool: Tool = {
  name: "echo",
  description: "Echoes the input message.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  func: async (args: Record<string, unknown>) =>
    `ECHO: ${args.message ?? ""}`,
};

const addTool: Tool = {
  name: "add",
  description: "Adds two numbers.",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  func: async (args: Record<string, unknown>) =>
    String(Number(args.a) + Number(args.b)),
};

// ─── Convenience ───────────────────────────────────────────────────────

function createAgent(llm: ReturnType<typeof mockAnswerLLM>, extra?: {
  maxIterations?: number;
  toolRegistry?: ToolRegistry;
  contextManager?: ContextManager;
}) {
  return new ReActAgent({
    llm,
    toolRegistry: extra?.toolRegistry ?? new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: extra?.maxIterations ?? 5,
    contextManager: extra?.contextManager,
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-react-test-"));
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("ReActAgent", () => {
  // ── Basic ReAct loop ────────────────────────────────────────────────

  describe("ReAct loop", () => {
    it("calls a single tool and returns the final answer", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const llm = mockSequenceLLM([
        // Step 1: Call echo tool
        [
          JSON.stringify({ thought: "I'll echo the message." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: {
                name: "echo",
                arguments: '{"message": "hello world"}',
              },
            },
          ],
        ],
        // Step 2: Final answer
        [answerContent("The echo returned: ECHO: hello world")],
      ]);

      const agent = new ReActAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("echo hello");
      expect(result).toContain("ECHO: hello world");
    });

    it("calls multiple tools across iterations", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.registerMany([echoTool, addTool]);

      const llm = mockSequenceLLM([
        // Step 1: Call echo
        [
          JSON.stringify({ thought: "First, echo the input." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "start"}' },
            },
          ],
        ],
        // Step 2: Call add
        [
          JSON.stringify({ thought: "Now add the numbers." }),
          [
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "add", arguments: '{"a": 3, "b": 5}' },
            },
          ],
        ],
        // Step 3: Final answer
        [answerContent("The result is 8.")],
      ]);

      const agent = new ReActAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("echo then add");
      expect(result).toContain("8");
    });

    it("executes multiple tools from a single LLM response (parallel batch)", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.registerMany([echoTool, addTool]);

      const llm = mockSequenceLLM([
        // One response with TWO tool calls
        [
          JSON.stringify({ thought: "Do both at once." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "hi"}' },
            },
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "add", arguments: '{"a": 2, "b": 3}' },
            },
          ],
        ],
        // Final answer
        [answerContent("Both tools completed.")],
      ]);

      const agent = new ReActAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("echo and add");
      expect(result).toContain("Both tools completed.");
    });
  });

  // ── Loop termination ────────────────────────────────────────────────

  describe("loop termination", () => {
    it("returns a timeout message when max iterations are reached", async () => {
      // Every response has thought-only (no answer, no tool calls) —
      // the loop never terminates naturally.
      const llm = mockSequenceLLM(
        Array.from({ length: 10 }, () => [
          JSON.stringify({ thought: "Still thinking..." }),
        ]),
      );

      const agent = new ReActAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 3,
      });

      const result = await agent.run("something");
      expect(result).toContain("unable to complete");
      expect(result).toContain("3 iterations");
    });

    it("bails out after consecutive empty thought-only iterations", async () => {
      // 5 consecutive thought-only responses should trigger the stuck bailout
      const llm = mockSequenceLLM(
        Array.from({ length: 10 }, () => [
          JSON.stringify({ thought: "Hmm, let me think more..." }),
        ]),
      );

      const agent = new ReActAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 10,
      });

      const result = await agent.run("help");
      expect(result).toContain("difficulty making progress");
    });

    it("returns answer immediately when no tools are needed", async () => {
      const agent = createAgent(mockAnswerLLM("Here is a direct answer."));
      const result = await agent.run("simple question");
      expect(result).toContain("Here is a direct answer.");
    });
  });

  // ── Cancel mid-run ──────────────────────────────────────────────────

  describe("cancellation", () => {
    it("returns a cancellation message when cancel() is called before run", async () => {
      const agent = createAgent(mockAnswerLLM("should not be returned"));
      agent.cancel(); // Simulate SIGINT

      const result = await agent.run("some input");
      expect(result).toContain("Execution cancelled by user");
    });
  });

  // ── validateInputSize pre-flight ────────────────────────────────────

  describe("validateInputSize", () => {
    it("rejects oversized input before calling init", async () => {
      const cm = new ContextManager({ maxTokens: 50 }, new SilentLogger());

      const agent = new ReActAgent({
        llm: mockAnswerLLM("should not be called"),
        contextManager: cm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
      });

      const hugeInput = "word ".repeat(200);
      const result = await agent.run(hugeInput);

      expect(result).toContain("input is too large");
      expect(result).not.toContain("should not be called");
      expect((agent as any)._mcpInitialized).toBe(false);
    });
  });

  // ── max_tokens truncation ───────────────────────────────────────────

  describe("max_tokens truncation", () => {
    it("injects a continuation instruction and continues after truncation", async () => {
      // A custom mock that returns a truncated response first,
      // then a complete answer on the next call.
      let callCount = 0;
      const llm = {
        model: "mock",
        chat: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              content: JSON.stringify({
                thought: "Almost done...",
                answer: "The answer is 42",
              }),
              tool_calls: undefined,
              responseError: {
                code: "max_tokens" as any,
                message: "Output truncated.",
              },
            };
          }
          return {
            content: answerContent("The complete answer is 42."),
            tool_calls: undefined,
          };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const agent = new ReActAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("big question");
      // The first response triggers truncation handling — agent should
      // continue and eventually get the final answer.
      expect(result).toContain("42");
    });
  });

  // ── Retry counter reset ─────────────────────────────────────────────

  describe("loop counters", () => {
    it("resets consecutive empty counter after a tool call", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const llm = mockSequenceLLM([
        // Thought only (empty iteration 1)
        [JSON.stringify({ thought: "Let me analyze..." })],
        // Thought only (empty iteration 2)
        [JSON.stringify({ thought: "Still analyzing..." })],
        // Tool call — should reset the empty counter
        [
          JSON.stringify({ thought: "I'll use echo." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "test"}' },
            },
          ],
        ],
        // Thought only — counter is now 1 (was reset after tool call)
        [JSON.stringify({ thought: "Echo worked." })],
        // Answer
        [answerContent("All good.")],
      ]);

      const agent = new ReActAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        maxIterations: 10,
      });

      const result = await agent.run("test");
      expect(result).toContain("All good.");
    });
  });

  // ── Resume ──────────────────────────────────────────────────────────

  describe("resume", () => {
    let sessionDir: string;

    beforeEach(() => {
      sessionDir = tempDir();
    });

    afterEach(() => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    it("resumes a session and continues the conversation", async () => {
      // ── First run ──────────────────────────────────────────────────
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const llm1 = mockSequenceLLM([
        [
          JSON.stringify({ thought: "Calling echo." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "first"}' },
            },
          ],
        ],
        [answerContent("First session complete.")],
      ]);

      const agent = new ReActAgent({
        llm: llm1,
        toolRegistry,
        sessionDir,
        enableCheckpointing: true,
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result1 = await agent.run("echo first");
      expect(result1).toContain("First session complete.");

      const sid = (agent as any).sessionManager.getSessionId();

      // ── Resume with new LLM ────────────────────────────────────────
      const llm2 = mockAnswerLLM("Resumed session output.");
      (agent as any).llm = llm2;

      const result2 = await agent.resume(sid, "continue please");
      expect(result2).toContain("Resumed session output.");
    });
  });

  // ── Thought logging ─────────────────────────────────────────────────

  describe("thought logging", () => {
    it("emits thought via hooks when tool calls are made", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const thoughts: string[] = [];

      const llm = mockSequenceLLM([
        [
          JSON.stringify({ thought: "I will call the echo tool." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "test"}' },
            },
          ],
        ],
        [answerContent("Done.")],
      ]);

      const agent = new ReActAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        maxIterations: 5,
        hooks: [
          {
            onThought: (t: string) => thoughts.push(t),
          },
        ],
      });

      await agent.run("echo test");
      // onThought fires for the tool-call iteration
      expect(thoughts.length).toBeGreaterThanOrEqual(1);
      expect(thoughts[0]).toContain("echo");
    });

    it("emits onFinish with the final answer", async () => {
      let finalAnswer = "";
      const agent = new ReActAgent({
        llm: mockAnswerLLM("Target answer."),
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
        hooks: [
          {
            onFinish: (a: string) => {
              finalAnswer = a;
            },
          },
        ],
      });

      await agent.run("hello");
      expect(finalAnswer).toContain("Target answer.");
    });
  });
});
