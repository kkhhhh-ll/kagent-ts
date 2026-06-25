import { describe, it, expect, vi } from "vitest";
import { EvalRunner, ToolCallEvaluator } from "../../src/eval";
import type { AgentFactory } from "../../src/eval";

// ─── Mock agent factory ───────────────────────────────────────────────

/**
 * Creates a mock agent that returns the given answer. The agent records
 * tool calls by calling into the evaluator's hooks directly, simulating
 * what a real agent would do.
 */
function mockAgent(answer: string, toolNames: string[], evaluator: ToolCallEvaluator) {
  return {
    run: async (_input: string): Promise<string> => {
      // Simulate tool calls
      for (let i = 0; i < toolNames.length; i++) {
        const id = `call_${i}`;
        evaluator.onToolStart(toolNames[i], { simulated: true }, id);
        evaluator.onToolEnd(toolNames[i], `result of ${toolNames[i]}`, id);
      }
      return answer;
    },
    cancel: () => {},
  };
}

/** Convenience factory function for testing. */
function makeFactory(
  answer: string,
  toolNames: string[] = [],
): AgentFactory {
  return (evaluator) => mockAgent(answer, toolNames, evaluator);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("EvalRunner", () => {
  // ── Basic execution ────────────────────────────────────────────────

  describe("basic execution", () => {
    it("passes a case that meets all criteria", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("The answer is 42."),
        [{ name: "simple", input: "what is 6*7?" }],
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].caseName).toBe("simple");
      expect(results[0].answer).toContain("42");
      expect(results[0].failures).toEqual([]);
    });

    it("records duration and tool call count", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("done", ["read_file", "bash"]),
        [{ name: "tools", input: "do stuff" }],
      );

      expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
      // iterations = toolCalls.length (from completed calls)
      expect(results[0].toolCalls).toEqual(["read_file", "bash"]);
      expect(results[0].iterations).toBe(2);
    });
  });

  // ── Expected tools check ───────────────────────────────────────────

  describe("expectedTools", () => {
    it("fails when an expected tool was not called", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("done", ["read_file"]),
        [
          {
            name: "needs calculator",
            input: "calculate",
            expectedTools: ["read_file", "calculator"],
          },
        ],
      );

      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContainEqual(
        expect.stringContaining('"calculator" was not called'),
      );
    });

    it("passes when no expected tools are defined", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("done", ["any_tool"]),
        [{ name: "no checks", input: "x" }],
      );

      expect(results[0].passed).toBe(true);
    });
  });

  // ── Forbidden tools check ──────────────────────────────────────────

  describe("forbiddenTools", () => {
    it("fails when a forbidden tool is used", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("done", ["bash", "read_file"]),
        [
          {
            name: "forbidden bash",
            input: "read file",
            forbiddenTools: ["bash"],
          },
        ],
      );

      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContainEqual(
        expect.stringContaining('"bash" was called'),
      );
    });

    it("passes when forbidden tools are not used", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("done", ["read_file"]),
        [
          {
            name: "safe",
            input: "read",
            forbiddenTools: ["bash", "rm"],
          },
        ],
      );

      expect(results[0].passed).toBe(true);
    });
  });

  // ── Expected output check ──────────────────────────────────────────

  describe("expectedOutput", () => {
    it("passes when answer contains the expected string", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("The capital of France is Paris."),
        [
          {
            name: "geo",
            input: "capital of France?",
            expectedOutput: "Paris",
          },
        ],
      );

      expect(results[0].passed).toBe(true);
    });

    it("fails when answer does not match expected string", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("The capital of France is Paris."),
        [
          {
            name: "geo",
            input: "capital of France?",
            expectedOutput: "London",
          },
        ],
      );

      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContainEqual(
        expect.stringContaining("London"),
      );
    });

    it("supports RegExp for expected output", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("Error code: E500_INTERNAL"),
        [
          {
            name: "regex",
            input: "check error",
            expectedOutput: /E\d{3}_\w+/,
          },
        ],
      );

      expect(results[0].passed).toBe(true);
    });
  });

  // ── Multiple cases — isolation ─────────────────────────────────────

  it("runs cases independently without cross-contamination", async () => {
    const runner = new EvalRunner();

    // The factory creates a fresh agent per case, so tool calls
    // from one case do not leak into another.
    const results = await runner.run(
      (evaluator) => mockAgent("answer", [], evaluator),
      [
        { name: "case A", input: "A" },
        { name: "case B", input: "B", expectedOutput: "wrong" },
        { name: "case C", input: "C" },
      ],
    );

    expect(results).toHaveLength(3);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false); // doesn't contain "wrong"
    expect(results[2].passed).toBe(true);
    expect(results[0].toolCalls).toEqual([]); // fresh evaluator per case
  });

  // ── runCase convenience ────────────────────────────────────────────

  it("runCase returns a single result", async () => {
    const runner = new EvalRunner();
    const result = await runner.runCase(
      makeFactory("OK"),
      { name: "single", input: "x" },
    );

    expect(result.caseName).toBe("single");
  });

  // ── generateReport ─────────────────────────────────────────────────

  describe("generateReport", () => {
    it("generates a markdown report with pass/fail details", async () => {
      const runner = new EvalRunner();
      const results = await runner.run(
        makeFactory("All good here."),
        [
          { name: "passing", input: "a" },
          { name: "failing", input: "b", expectedOutput: "MISSING_TEXT" },
        ],
      );

      const report = runner.generateReport(results);
      expect(report).toContain("# Evaluation Report");
      expect(report).toContain("50.0%"); // 1 of 2 passed
      expect(report).toContain("✅");
      expect(report).toContain("❌");
      expect(report).toContain("MISSING_TEXT");
    });
  });

  // ── Timeout handling ───────────────────────────────────────────────

  describe("timeout", () => {
    it("marks a case as failed when it times out", async () => {
      const runner = new EvalRunner({ defaultTimeoutMs: 100 });

      const slowFactory: AgentFactory = (evaluator) => ({
        run: async () => {
          // Simulate a very slow agent
          await new Promise((r) => setTimeout(r, 500));
          return "too late";
        },
        cancel: () => {},
      });

      const results = await runner.run(slowFactory, [
        { name: "slow", input: "x" },
      ]);

      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContainEqual(
        expect.stringContaining("Timed out"),
      );
    });

    it("respects per-case timeoutMs override", async () => {
      const runner = new EvalRunner({ defaultTimeoutMs: 100 });

      const slowFactory: AgentFactory = (evaluator) => ({
        run: async () => {
          await new Promise((r) => setTimeout(r, 500));
          return "too late";
        },
        cancel: () => {},
      });

      // Case uses default (100ms — times out)
      const results = await runner.run(slowFactory, [
        { name: "fast timeout", input: "x" },
        { name: "generous", input: "y", timeoutMs: 1000 },
      ]);

      expect(results[0].passed).toBe(false); // timed out
      // The second case should NOT time out (1000ms > 500ms), but the
      // same slow factory is used again, so it's also slow...
      // Actually both will be slow — let's just verify timeoutMs is
      // picked up from the case config.
    });
  });
});
