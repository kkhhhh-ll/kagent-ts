import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pre-import to break circular dependency:
//   agent.ts → subagent-manager.ts → react-agent.ts → agent.ts
// Without this, ReActAgent sees Agent as undefined when PlanSolveAgent
// is loaded first (vitest CJS transform changes module evaluation order).
import "../../src/core/react-agent";

import { PlanSolveAgent } from "../../src/core/plan-solve-agent";
import { ContextManager } from "../../src/context/context-manager";
import { ToolRegistry } from "../../src/tools/tool-registry";
import { SilentLogger } from "../../src/logging/logger";
import { mockLLM, mockAnswerLLM, mockSequenceLLM } from "../mocks/mock-llm-provider";
import type { LLMProvider } from "../../src/llm/interface";

// ─── Plan-Solve JSON helpers ───────────────────────────────────────────

/** A direct answer, skipping the plan phase entirely. */
function answerJSON(answer: string, thought = "Done."): string {
  return JSON.stringify({ thought, answer });
}

/** Initial plan creation. */
function planJSON(steps: string[], thought = "Here's the plan:"): string {
  return JSON.stringify({ thought, plan: steps });
}

/** Revise remaining plan steps. */
function revisedPlanJSON(steps: string[], thought = "Revising plan:"): string {
  return JSON.stringify({ thought, revised_plan: steps });
}

/** Step progress update (no answer, no plan). */
function stepJSON(currentStep: number, thought = "Working on it."): string {
  return JSON.stringify({ thought, currentStep });
}

// ─── Convenience: create a PlanSolveAgent with a single-answer LLM ─────

function createAgent(answer: string) {
  return new PlanSolveAgent({
    llm: mockAnswerLLM(answer),
    toolRegistry: new ToolRegistry(),
    logger: new SilentLogger(),
    maxIterations: 5,
  });
}

// ─── Temp dir helper (for session/resume tests) ────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-plan-solve-test-"));
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("PlanSolveAgent", () => {
  // ── Basic behaviour ──────────────────────────────────────────────────

  describe("Basic run", () => {
    it("returns the LLM answer on a direct-answer run", async () => {
      const agent = createAgent("All done!");
      const result = await agent.run("do something");
      expect(result).toContain("All done!");
    });

    it("creates a plan and then answers", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: research", "Step 2: write", "Step 3: review"])],
        [stepJSON(2)],
        [answerJSON("Here is the final result.")],
      ]);

      const agent = new PlanSolveAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("complex task");
      expect(result).toContain("Here is the final result.");
    });

    it("revises the plan mid-execution", async () => {
      const llm = mockSequenceLLM([
        [planJSON(["Step 1: do A", "Step 2: do B", "Step 3: do C"])],
        [revisedPlanJSON(["Step 2: do B differently", "Step 3: do C"])],
        [stepJSON(1)],
        [answerJSON("Task complete after revision.")],
      ]);

      const agent = new PlanSolveAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      const result = await agent.run("tricky task");
      expect(result).toContain("Task complete after revision.");
    });
  });

  // ── Replan threshold ─────────────────────────────────────────────────

  describe("replanThreshold", () => {
    it("injects a replan hint after consecutive tool failures reach threshold", async () => {
      // The agent needs to experience tool failures.  We simulate this
      // by providing a tool-call that always fails, then an answer.
      const llm = mockSequenceLLM([
        // 1: Plan creation
        [planJSON(["Step 1: call failing tool", "Step 2: done"])],
        // 2: Attempt tool call — will fail
        [
          stepJSON(1, "Trying the tool..."),
          [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "nonexistent_tool", arguments: "{}" },
            },
          ],
        ],
        // 3: After first failure, try again — still fails
        [
          stepJSON(1, "Let me try again..."),
          [
            {
              id: "call_2",
              type: "function" as const,
              function: { name: "nonexistent_tool", arguments: "{}" },
            },
          ],
        ],
        // 4: After 2 failures (replanThreshold=2), LLM should see replan hint
        //    and output a revised_plan
        [revisedPlanJSON(["Step 1: use a different approach"])],
        // 5: Final answer
        [answerJSON("Switched approach and completed.")],
      ]);

      const agent = new PlanSolveAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 10,
        replanThreshold: 2,
      });

      const result = await agent.run("test replan");
      expect(result).toContain("Switched approach and completed.");
    });
  });

  // ── validateInputSize pre-flight ─────────────────────────────────────

  describe("validateInputSize", () => {
    it("rejects oversized input before calling init", async () => {
      // Use a ContextManager with a tiny max-token window so any
      // non-trivial input triggers the size check.
      const cm = new ContextManager({ maxTokens: 50 }, new SilentLogger());

      const agent = new PlanSolveAgent({
        llm: mockAnswerLLM("should not be called"),
        contextManager: cm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
      });

      // A long input that will certainly exceed 50 * 0.8 = 40 tokens
      const hugeInput = "word ".repeat(200);
      const result = await agent.run(hugeInput);

      // Should be the size-error message, NOT the LLM answer
      expect(result).toContain("input is too large");
      expect(result).not.toContain("should not be called");

      // Verify the LLM was never called — _mcpInitialized should be false
      // because validateInputSize returned early before init().
      expect((agent as any)._mcpInitialized).toBe(false);
    });
  });

  // ── _skipPlanReset flag ──────────────────────────────────────────────

  describe("_skipPlanReset flag", () => {
    let sessionDir: string;

    beforeEach(() => {
      sessionDir = tempDir();
    });

    afterEach(() => {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    it("preserves plan state when resuming a session", async () => {
      // ── First run: create a plan via run() ───────────────────────────
      const llm1 = mockSequenceLLM([
        [planJSON(["Step 1", "Step 2"])],
        [answerJSON("First session done.")],
      ]);

      const agent = new PlanSolveAgent({
        llm: llm1,
        sessionDir,
        enableCheckpointing: true,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      await agent.run("task one");

      // After first run, plan state should be set
      expect((agent as any).hasPlan).toBe(true);
      expect((agent as any).currentPlan).toEqual(["Step 1", "Step 2"]);

      // ── Resume: plan state should be preserved ──────────────────────
      const llm2 = mockAnswerLLM("Resumed answer.");
      // Replace the LLM so we get a fresh mock
      (agent as any).llm = llm2;

      const sid = (agent as any).sessionManager.getSessionId();
      await agent.resume(sid, "continue");

      // After resume, plan state should STILL be preserved
      // (the _skipPlanReset flag prevented the reset)
      expect((agent as any).hasPlan).toBe(true);
      expect((agent as any).currentPlan).toEqual(["Step 1", "Step 2"]);
    });

    it("resets plan state on a fresh run after resume", async () => {
      // ── First session ───────────────────────────────────────────────
      const agent = new PlanSolveAgent({
        llm: mockAnswerLLM("First."),
        sessionDir,
        enableCheckpointing: true,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      await agent.run("first");

      // Manually simulate a plan being set
      (agent as any).currentPlan = ["Old step"];
      (agent as any).hasPlan = true;

      // ── Second fresh run (no resume) — should reset plan ────────────
      (agent as any).llm = mockAnswerLLM("Second.");
      await agent.run("second");

      // Plan state should be reset because _skipPlanReset was false
      expect((agent as any).hasPlan).toBe(false);
      expect((agent as any).currentPlan).toEqual([]);
    });

    it("consumes _skipPlanReset even on early return (oversized input)", async () => {
      const cm = new ContextManager({ maxTokens: 50 }, new SilentLogger());

      const agent = new PlanSolveAgent({
        llm: mockAnswerLLM("should not be called"),
        contextManager: cm,
        sessionDir,
        enableCheckpointing: true,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
      });

      // Manually set the flag as if resume() had been called
      (agent as any)._skipPlanReset = true;

      // Send oversized input → run() returns early
      const result = await agent.run("word ".repeat(200));
      expect(result).toContain("input is too large");

      // The critical check: _skipPlanReset must be consumed (false)
      // even though run() returned early.  If it leaked (stayed true),
      // the next fresh run() would incorrectly skip plan reset.
      expect((agent as any)._skipPlanReset).toBe(false);

      // A subsequent normal run should reset plan state (proving the
      // flag didn't leak).
      (agent as any).currentPlan = ["Stale plan"];
      (agent as any).hasPlan = true;
      (agent as any).llm = mockAnswerLLM("Clean run.");

      await agent.run("normal input");

      expect((agent as any).hasPlan).toBe(false);
      expect((agent as any).currentPlan).toEqual([]);
    });
  });

  // ── pollSubAgentResults in loop ──────────────────────────────────────

  describe("pollSubAgentResults", () => {
    it("polls for sub-agent results each iteration", async () => {
      // Simulate a sub-agent manager that returns a result.
      // We don't need a real SubAgentManager — just mock pollCompleted.

      const agent = new PlanSolveAgent({
        llm: mockAnswerLLM("Task done."),
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
      });

      let pollCount = 0;
      const originalPoll = (agent as any).pollSubAgentResults;
      (agent as any).pollSubAgentResults = async () => {
        pollCount++;
        return [];
      };

      await agent.run("test");

      // pollSubAgentResults should have been called at least once
      // (once per iteration until answer is produced)
      expect(pollCount).toBeGreaterThanOrEqual(1);

      // Restore (not strictly necessary, but clean)
      (agent as any).pollSubAgentResults = originalPoll;
    });
  });

  // ── maxPlanSteps truncation ──────────────────────────────────────────

  describe("maxPlanSteps", () => {
    it("truncates plans that exceed maxPlanSteps", async () => {
      const longPlan = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`);
      const llm = mockSequenceLLM([
        [planJSON(longPlan)],
        [answerJSON("Done with truncated plan.")],
      ]);

      const agent = new PlanSolveAgent({
        llm,
        toolRegistry: new ToolRegistry(),
        logger: new SilentLogger(),
        maxIterations: 5,
        maxPlanSteps: 5,
      });

      const result = await agent.run("big task");
      expect(result).toContain("Done with truncated plan.");
      // Plan should be truncated to maxPlanSteps
      expect((agent as any).currentPlan.length).toBe(5);
    });
  });
});
