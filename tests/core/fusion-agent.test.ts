import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pre-import to break circular dependency (same pattern as plan-solve-agent tests)
import "../../src/core/react-agent";
import "../../src/core/plan-solve-agent";

import { FusionAgent } from "../../src/core/fusion-agent";
import type { FusionAgentConfig } from "../../src/core/fusion-agent";
import { ContextManager } from "../../src/context/context-manager";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { ErrorNotebook } from "../../src/reflection/error-notebook";
import {
  mockLLM,
  mockAnswerLLM,
  mockSequenceLLM,
} from "../mocks/mock-llm-provider";
import type { LLMProvider } from "../../src/llm/interface";
import { INLINE_REFLECTION_PROMPT } from "../../src/core/response-schema";
import type { Tool } from "../../src/tools/types";

// ─── Test tools ──────────────────────────────────────────────────────────

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

const failTool: Tool = {
  name: "fail",
  description: "Always fails.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  func: async () => {
    throw new Error("Tool failed intentionally.");
  },
};

// ─── JSON helpers ────────────────────────────────────────────────────────

function routeJSON(complexity: "simple" | "complex", reason = "test"): string {
  return JSON.stringify({ complexity, reason });
}

function answerJSON(answer: string, thought = "Done."): string {
  return JSON.stringify({ thought, answer });
}

function planJSON(steps: string[], thought = "Here is the plan:"): string {
  return JSON.stringify({ thought, plan: steps });
}

function revisedPlanJSON(steps: string[], thought = "Revising:"): string {
  return JSON.stringify({ thought, revised_plan: steps });
}

function stepJSON(currentStep: number, thought = "Working..."): string {
  return JSON.stringify({ thought, currentStep });
}

// ─── Temp dir helper ─────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-fusion-test-"));
}

// ─── Convenience agent factories ─────────────────────────────────────────

function createSimpleAgent(config: Partial<FusionAgentConfig> = {}) {
  return new FusionAgent({
    llm: mockAnswerLLM("Direct answer."),
    toolRegistry: new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: 5,
    ...config,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("FusionAgent", () => {
  // ══════════════════════════════════════════════════════════════════════
  // Routing
  // ══════════════════════════════════════════════════════════════════════

  describe("routing", () => {
    it("force-react: skips routing and plan, executes directly", async () => {
      const agent = new FusionAgent({
        llm: mockAnswerLLM("Quick answer."),
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-react",
        maxIterations: 5,
      });

      const result = await agent.run("simple question");
      expect(result).toContain("Quick answer.");
    });

    it("force-plan: skips routing, goes directly to plan + execute", async () => {
      const llm = mockSequenceLLM([
        // Plan phase: LLM generates a plan
        [planJSON(["Step 1: do research", "Step 2: write answer"])],
        // Execute phase: final answer (skips tool calls)
        [answerJSON("Plan executed successfully.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        maxIterations: 5,
      });

      const result = await agent.run("complex task");
      expect(result).toContain("Plan executed successfully.");
    });

    it("auto: routes simple tasks to direct ReAct", async () => {
      const llm = mockSequenceLLM([
        // Route: classify as simple
        [routeJSON("simple", "This is straightforward.")],
        // Execute: direct answer
        [answerJSON("Simple answer.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
      });

      const result = await agent.run("what is 2+2");
      expect(result).toContain("Simple answer.");
    });

    it("auto: routes complex tasks to plan → execute", async () => {
      const llm = mockSequenceLLM([
        // Route: classify as complex
        [routeJSON("complex", "This requires multiple steps.")],
        // Plan: generate steps
        [planJSON(["Step 1: analyze", "Step 2: implement"])],
        // Execute: final answer
        [answerJSON("Complex task completed.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
      });

      const result = await agent.run("build a complete web app");
      expect(result).toContain("Complex task completed.");
    });

    it("auto: defaults to complex when route LLM call fails", async () => {
      // Mock that throws on first call (route), then works for plan + execute
      let callCount = 0;
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("Network failure during routing.");
          }
          if (callCount === 2) {
            return {
              content: planJSON(["Fallback plan step"]),
            };
          }
          return {
            content: answerJSON("Completed via fallback."),
          };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
      });

      const result = await agent.run("anything");
      // Should default to complex, create a plan, and execute
      expect(result).toContain("Completed via fallback.");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Plan phase
  // ══════════════════════════════════════════════════════════════════════

  describe("plan phase", () => {
    it("trims plan to maxPlanSteps", async () => {
      const longPlan = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`);

      const llm = mockSequenceLLM([
        [planJSON(longPlan)],
        [answerJSON("Done.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        maxPlanSteps: 5,
        maxIterations: 5,
      });

      await agent.run("big task");
      // Plan should be trimmed to 5 steps
      expect((agent as any).currentPlan.length).toBe(5);
    });

    it("plan confirmation: always — calls onPlanConfirm", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: do X", "Step 2: do Y"])],
        // If confirmed, execute
        [answerJSON("Executed after confirmation.")],
      ]);

      let confirmedPlan: string[] | null = null;

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        planConfirmation: "always",
        onPlanConfirm: async (plan) => {
          confirmedPlan = plan;
          return true; // approve
        },
        maxIterations: 5,
      });

      const result = await agent.run("task needing confirmation");
      expect(confirmedPlan).toEqual(["Step 1: do X", "Step 2: do Y"]);
      expect(result).toContain("Executed after confirmation.");
    });

    it("plan confirmation: rejection returns the plan as answer", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: delete database", "Step 2: drop tables"])],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        planConfirmation: "always",
        onPlanConfirm: async () => false, // reject
        maxIterations: 5,
      });

      const result = await agent.run("dangerous task");
      expect(result).toContain("delete database");
      expect(result).toContain("drop tables");
      expect(result).not.toContain("Executed");
    });

    it("plan confirmation: no callback configured returns plan as answer", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: important step"])],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        planConfirmation: "always",
        // no onPlanConfirm
        maxIterations: 5,
      });

      const result = await agent.run("important task");
      expect(result).toContain("important step");
      expect(result).toContain("confirmation");
    });

    it("falls back to direct ReAct when LLM produces no plan", async () => {
      const llm = mockSequenceLLM([
        // Plan phase but no plan returned
        [JSON.stringify({ thought: "I don't need a plan for this." })],
        // Execute phase (falls back to ReAct)
        [answerJSON("Direct answer without plan.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        maxIterations: 5,
      });

      const result = await agent.run("simple-ish task");
      expect(result).toContain("Direct answer without plan.");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Execute loop (ReAct + Plan tracking)
  // ══════════════════════════════════════════════════════════════════════

  describe("execute loop", () => {
    it("calls tools within the ReAct loop (simple path)", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const llm = mockSequenceLLM([
        // Route: simple
        [routeJSON("simple", "just an echo")],
        // Step 1: call echo
        [
          JSON.stringify({ thought: "Calling echo." }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "hello"}' },
            },
          ],
        ],
        // Step 2: final answer
        [answerJSON("Echo returned: ECHO: hello")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
      });

      const result = await agent.run("echo hello");
      expect(result).toContain("ECHO: hello");
    });

    it("calls tools within the ReAct loop (complex path with plan)", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.registerMany([echoTool, addTool]);

      const llm = mockSequenceLLM([
        // Route
        [routeJSON("complex", "multi-step")],
        // Plan
        [planJSON(["Step 1: echo input", "Step 2: add numbers", "Step 3: finalize"])],
        // Execute step 1: call echo
        [
          JSON.stringify({ thought: "Step 1...", currentStep: 1 }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "start"}' },
            },
          ],
        ],
        // Execute step 2: call add
        [
          JSON.stringify({ thought: "Step 2...", currentStep: 2 }),
          [
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "add", arguments: '{"a": 3, "b": 4}' },
            },
          ],
        ],
        // Final answer
        [answerJSON("All steps completed. Result: 7.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 10,
      });

      const result = await agent.run("echo and add");
      expect(result).toContain("7");
    });

    it("revises the plan mid-execution", async () => {
      const llm = mockSequenceLLM([
        // Route
        [routeJSON("complex", "needs plan")],
        // Plan: initial 3-step plan
        [planJSON(["Step 1: try approach A", "Step 2: do B", "Step 3: finish"])],
        // Step 1 executes, finds issue, revises
        [revisedPlanJSON(["Step 2: try approach C instead", "Step 3: finish"])],
        // Continue with revised plan
        [stepJSON(1)],
        // Final answer
        [answerJSON("Task complete with revised approach.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 10,
      });

      const result = await agent.run("problem that needs replanning");
      expect(result).toContain("Task complete with revised approach.");
    });

    it("injects replan hint on consecutive tool failures", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(failTool);

      const llm = mockSequenceLLM([
        // Route
        [routeJSON("complex", "needs tools")],
        // Plan
        [planJSON(["Step 1: call failing tool", "Step 2: recover"])],
        // Attempt 1: call fail → fails
        [
          JSON.stringify({ thought: "Let me try the failing tool.", currentStep: 1 }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "fail", arguments: "{}" },
            },
          ],
        ],
        // Attempt 2: call fail again → second consecutive failure
        [
          JSON.stringify({ thought: "Trying again...", currentStep: 1 }),
          [
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "fail", arguments: "{}" },
            },
          ],
        ],
        // After 2 failures, replan hint is injected → LLM revises plan
        [revisedPlanJSON(["Step 1: use a different approach"])],
        // Final answer
        [answerJSON("Fixed by revising the approach.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 10,
        replanThreshold: 2,
      });

      const result = await agent.run("task with failing tool");
      expect(result).toContain("Fixed by revising the approach.");
      // Verify replan was triggered
      expect((agent as any).consecutiveFailures).toBe(0); // Reset after replan
    });

    it("injects inline reflection prompt at configured interval", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      // Inline reflection triggers after tool-call iterations at the
      // configured interval. We use 3 iterations with tool calls so
      // iteration index 2 (third iteration) hits interval=3.
      const llm = mockSequenceLLM([
        // Route
        [routeJSON("complex", "needs reflection")],
        // Plan
        [planJSON(["Step 1", "Step 2", "Step 3", "Step 4"])],
        // Iteration 0: tool call
        [
          JSON.stringify({ thought: "Executing step 1.", currentStep: 1 }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "a"}' },
            },
          ],
        ],
        // Iteration 1: tool call
        [
          JSON.stringify({ thought: "Executing step 2.", currentStep: 2 }),
          [
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "b"}' },
            },
          ],
        ],
        // Iteration 2: tool call — (iteration+1) % 3 === 0 triggers reflection
        [
          JSON.stringify({ thought: "Executing step 3.", currentStep: 3 }),
          [
            {
              id: "call_3",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "c"}' },
            },
          ],
        ],
        // Final answer
        [answerJSON("Completed with inline reflection checks.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        reflection: "inline",
        reflectionInterval: 3,
        maxIterations: 10,
      });

      const addMessageSpy = vi.spyOn(
        (agent as any).contextManager,
        "addMessage",
      );

      await agent.run("task with inline reflection");

      // The INLINE_REFLECTION_PROMPT should have been injected during
      // the third tool-call iteration
      const reflectionCalls = addMessageSpy.mock.calls.filter(
        (call: any[]) =>
          typeof call[0]?.content === "string" &&
          call[0].content.includes("Internal Reflection"),
      );
      expect(reflectionCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Reflection
  // ══════════════════════════════════════════════════════════════════════

  describe("reflection", () => {
    let notebookDir: string;

    beforeEach(() => {
      notebookDir = tempDir();
    });

    afterEach(() => {
      fs.rmSync(notebookDir, { recursive: true, force: true });
    });

    it("off: no reflection occurs", async () => {
      const llm = mockSequenceLLM([
        [routeJSON("simple", "easy")],
        [answerJSON("Quick answer.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        reflection: "off",
        maxIterations: 5,
      });

      const result = await agent.run("simple question");
      expect(result).toContain("Quick answer.");
      // No notebook, no reflection — should complete normally
    });

    it("post-hoc: runs ReflectionAgent after execution", async () => {
      const notebook = new ErrorNotebook({
        storageDir: notebookDir,
      });

      // We need a mock where the post-hoc reflection LLM call also works.
      // The ReflectionAgent uses `this.llm.chat()` internally for reflection.
      // We'll use a mock that handles both execute and reflect calls.
      let callCount = 0;
      const llm: LLMProvider = {
        model: "mock",
        chat: async () => {
          callCount++;
          if (callCount <= 2) {
            // Route + answer
            if (callCount === 1) {
              return { content: routeJSON("simple", "easy") };
            }
            return { content: answerJSON("Direct answer.") };
          }
          // ReflectionAgent calls — return empty findings (score 100)
          return {
            content: JSON.stringify({
              analysis: "Flawless execution.",
              score: 100,
              findings: [],
              improvements: [],
            }),
          };
        },
        chatStream: async function* () { yield { type: "done" as const }; },
        getTokenCount: () => 10,
      };

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        reflection: "post-hoc",
        notebook,
        maxIterations: 5,
      });

      const result = await agent.run("test post-hoc");
      expect(result).toContain("Direct answer.");
    });

    it("post-hoc: throws if notebook is missing", () => {
      expect(() => {
        new FusionAgent({
          llm: mockAnswerLLM("test"),
          toolRegistry: new ToolRegistry(),
          logger: new SilentLogger(),
          reflection: "post-hoc",
          // no notebook
          maxIterations: 5,
        });
      }).toThrow(/notebook/);
    });

    it("both: requires notebook", () => {
      expect(() => {
        new FusionAgent({
          llm: mockAnswerLLM("test"),
          toolRegistry: new ToolRegistry(),
          logger: new SilentLogger(),
          reflection: "both",
          // no notebook
          maxIterations: 5,
        });
      }).toThrow(/notebook/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Edge cases & lifecycle
  // ══════════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("returns timeout when max iterations reached", async () => {
      // Endless thought-only responses
      const llm = mockSequenceLLM(
        Array.from({ length: 20 }, () => [
          JSON.stringify({ thought: "Still thinking..." }),
        ]),
      );

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-react",
        maxIterations: 3,
      });

      const result = await agent.run("endless task");
      expect(result).toContain("unable to complete");
      expect(result).toContain("3 iterations");
    });

    it("cancels mid-run", async () => {
      const agent = createSimpleAgent({ routing: "force-react" });
      agent.cancel();

      const result = await agent.run("anything");
      expect(result).toContain("Execution cancelled by user");
    });

    it("rejects oversized input", async () => {
      const cm = new ContextManager({ maxTokens: 50 }, new SilentLogger());

      const agent = new FusionAgent({
        llm: mockAnswerLLM("should not be called"),
        contextManager: cm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-react",
        maxIterations: 5,
      });

      const hugeInput = "word ".repeat(200);
      const result = await agent.run(hugeInput);

      expect(result).toContain("input is too large");
    });

    it("bails out on consecutive empty iterations", async () => {
      const llm = mockSequenceLLM(
        Array.from({ length: 10 }, () => [
          JSON.stringify({ thought: "Hmm..." }),
        ]),
      );

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-react",
        maxIterations: 15,
      });

      const result = await agent.run("anything");
      expect(result).toContain("difficulty making progress");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Hooks
  // ══════════════════════════════════════════════════════════════════════

  describe("hooks", () => {
    it("emits onPlanCreated when a plan is generated", async () => {
      let plan: string[] | null = null;

      const llm = mockSequenceLLM([
        [routeJSON("complex", "needs plan")],
        [planJSON(["Step A", "Step B"])],
        [answerJSON("Done.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
        hooks: [
          {
            onPlanCreated: (p: string[]) => {
              plan = p;
            },
          },
        ],
      });

      await agent.run("complex task");
      expect(plan).toEqual(["Step A", "Step B"]);
    });

    it("emits onPlanRevised when plan is revised", async () => {
      let revisedPlan: string[] | null = null;

      const llm = mockSequenceLLM([
        [routeJSON("complex", "needs plan")],
        [planJSON(["Old step"])],
        [revisedPlanJSON(["New step"])],
        [answerJSON("Done.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
        hooks: [
          {
            onPlanRevised: (p: string[]) => {
              revisedPlan = p;
            },
          },
        ],
      });

      await agent.run("task needing revision");
      expect(revisedPlan).toEqual(["New step"]);
    });

    it("emits onFinish with the final answer", async () => {
      let finalAnswer = "";

      const agent = new FusionAgent({
        llm: mockAnswerLLM("Target answer."),
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-react",
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

    it("emits onThought during tool call iterations", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      const thoughts: string[] = [];

      const llm = mockSequenceLLM([
        [routeJSON("simple", "just echo")],
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
        [answerJSON("Echo done.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 5,
        hooks: [
          {
            onThought: (t: string) => thoughts.push(t),
          },
        ],
      });

      await agent.run("echo test");
      expect(thoughts.length).toBeGreaterThanOrEqual(1);
      expect(thoughts[0]).toContain("echo");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Session persistence & resume
  // ══════════════════════════════════════════════════════════════════════

  describe("session persistence", () => {
    let sessionDir: string;

    beforeEach(() => {
      sessionDir = tempDir();
    });

    afterEach(() => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    it("saves and resumes a session with full fusion state", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(echoTool);

      // ── First run: echo a message ───────────────────────────────────
      const llm1 = mockSequenceLLM([
        [routeJSON("complex", "multi-step task")],
        [planJSON(["Step 1: echo"])],
        [
          JSON.stringify({ thought: "Calling echo.", currentStep: 1 }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "echo", arguments: '{"message": "first run"}' },
            },
          ],
        ],
        [answerJSON("First run complete.")],
      ]);

      const agent = new FusionAgent({
        llm: llm1,
        toolRegistry,
        sessionDir,
        enableCheckpointing: true,
        logger: new SilentLogger(),
        routing: "auto",
        maxIterations: 10,
      });

      const result1 = await agent.run("echo first");
      expect(result1).toContain("First run complete.");
      expect((agent as any).hasPlan).toBe(true);

      const sid = (agent as any).sessionManager.getSessionId();

      // ── Resume with new LLM ─────────────────────────────────────────
      const llm2 = mockAnswerLLM("Resumed session output.");
      (agent as any).llm = llm2;

      const result2 = await agent.resume(sid, "continue please");
      expect(result2).toContain("Resumed session output.");
    });

    it("getAgentType returns 'fusion'", () => {
      const agent = createSimpleAgent();
      expect((agent as any).getAgentType()).toBe("fusion");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Plan confirmation: auto mode (risky keyword detection)
  // ══════════════════════════════════════════════════════════════════════

  describe("plan confirmation auto mode", () => {
    it("auto-confirms plans without risky keywords", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: read a file", "Step 2: write a report"])],
        [answerJSON("Report written.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        planConfirmation: "auto",
        maxIterations: 5,
      });

      // Should execute without asking for confirmation
      const result = await agent.run("write a report");
      expect(result).toContain("Report written.");
    });

    it("triggers confirmation for plans with risky keywords", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: deploy to production", "Step 2: verify deployment"])],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        routing: "force-plan",
        planConfirmation: "auto",
        // No onPlanConfirm → when auto detects risky keywords, plan is returned
        maxIterations: 5,
      });

      const result = await agent.run("deploy the app");
      // Should contain the plan text (confirmation required, no callback)
      expect(result).toContain("deploy to production");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Inline reflection on first failure
  // ══════════════════════════════════════════════════════════════════════

  describe("inline reflection on tool failure", () => {
    it("triggers inline reflection on first tool failure when mode is inline", async () => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(failTool);

      const llm = mockSequenceLLM([
        [routeJSON("complex", "may fail")],
        [planJSON(["Step 1: try something risky"])],
        // Tool call that will fail
        [
          JSON.stringify({ thought: "Let me try.", currentStep: 1 }),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "fail", arguments: "{}" },
            },
          ],
        ],
        // After reflection prompt is injected (not a separate LLM call),
        // the next iteration continues with the reflection prompt as context
        [revisedPlanJSON(["Step 1: use safer approach"])],
        [answerJSON("Recovered after reflection.")],
      ]);

      const agent = new FusionAgent({
        llm,
        toolRegistry,
        logger: new SilentLogger(),
        routing: "auto",
        reflection: "inline",
        reflectionInterval: 5, // high interval so only first-failure triggers
        maxIterations: 10,
      });

      const result = await agent.run("risky task");
      expect(result).toContain("Recovered after reflection.");
      // Verify inline reflection was triggered by the failure
      expect((agent as any).inlineReflectionsDone).toBeGreaterThanOrEqual(1);
    });
  });
});
