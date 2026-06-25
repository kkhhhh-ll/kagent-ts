import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Benchmark, EvalRunner, ToolCallEvaluator } from "../../src/eval";
import type { AgentFactory, EvalCase } from "../../src/eval";
import type { BenchmarkResult } from "../../src/eval/types";

// ─── Helpers ───────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kagent-benchmark-test-"));
}

/** Create a predictable agent factory. */
function makeFactory(
  answers: string[],
  toolNames: string[] = [],
): AgentFactory {
  let callIndex = 0;
  return (evaluator) => {
    const answer = answers[Math.min(callIndex, answers.length - 1)];
    callIndex++;
    return {
      run: async (): Promise<string> => {
        for (let i = 0; i < toolNames.length; i++) {
          const id = `call_${i}`;
          evaluator.onToolStart(toolNames[i], { idx: i }, id);
          evaluator.onToolEnd(toolNames[i], `result`, id);
        }
        return answer;
      },
      cancel: () => {},
    };
  };
}

const sampleCases: EvalCase[] = [
  { name: "case-A", input: "input A", expectedTools: ["read_file"] },
  { name: "case-B", input: "input B", expectedOutput: "Paris" },
];

// ─── Tests ────────────────────────────────────────────────────────────

describe("Benchmark", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  // ── Basic run ──────────────────────────────────────────────────────

  describe("basic run", () => {
    it("runs cases and returns results with summary", async () => {
      const benchmark = new Benchmark({
        name: "my-benchmark",
        agentFactory: makeFactory(["answer A", "answer B"], ["read_file"]),
        cases: sampleCases,
        outputDir,
      });

      const result = await benchmark.run();
      expect(result.cases).toHaveLength(2);
      expect(result.summary.name).toBe("my-benchmark");
      expect(result.summary.total).toBe(2);
      expect(result.summary.timestamp).toBeTruthy();
    });

    it("persists results to disk", async () => {
      const benchmark = new Benchmark({
        name: "persist-test",
        agentFactory: makeFactory(["ok"], []),
        cases: [{ name: "one", input: "x" }],
        outputDir,
      });

      const result = await benchmark.run();
      // A JSON file should exist in the output directory
      const files = fs.readdirSync(outputDir);
      const jsonFile = files.find((f) => f.endsWith(".json"));
      expect(jsonFile).toBeTruthy();

      const content = JSON.parse(
        fs.readFileSync(path.join(outputDir, jsonFile!), "utf-8"),
      );
      expect(content.summary.name).toBe("persist-test");
    });
  });

  // ── Pass/fail tracking ─────────────────────────────────────────────

  describe("pass/fail tracking", () => {
    it("tracks case-A as PASS and case-B as FAIL", async () => {
      // case-A expects read_file → provided ✓
      // case-B expects "Paris" → answer is "answer B" → ✗
      const benchmark = new Benchmark({
        name: "pass-fail",
        agentFactory: makeFactory(["answer A", "answer B"], ["read_file"]),
        cases: sampleCases,
        outputDir,
      });

      const result = await benchmark.run();
      expect(result.summary.passed).toBe(1);
      expect(result.summary.total).toBe(2);
      expect(result.summary.passRate).toBeCloseTo(0.5);
      expect(result.cases[0].passed).toBe(true);
      expect(result.cases[1].passed).toBe(false);
    });
  });

  // ── Baseline comparison ────────────────────────────────────────────

  describe("baseline comparison", () => {
    it("detects no regressions when results match baseline", async () => {
      // First run — establish baseline
      const run1 = new Benchmark({
        name: "stable",
        agentFactory: makeFactory(["pass A", "pass B"], ["read_file"]),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B", expectedOutput: "pass B" },
        ],
        outputDir,
      });

      const baseline = await run1.run();
      // The first run persists the baseline; get its filename
      const files = fs.readdirSync(outputDir);
      const baselineFile = files.find((f) => f.endsWith(".json"));
      const baselinePath = path.join(outputDir, baselineFile!);

      // Second run with same factory → same results
      const run2 = new Benchmark({
        name: "stable",
        agentFactory: makeFactory(["pass A", "pass B"], ["read_file"]),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B", expectedOutput: "pass B" },
        ],
        outputDir,
        baselinePath,
      });

      const current = await run2.run();
      expect(current.summary.passed).toBe(2);
      expect(current.summary.regressions).toEqual([]);
    });

    it("detects a regression when a case flips from PASS to FAIL", async () => {
      // Baseline: all pass
      const run1 = new Benchmark({
        name: "regression-test",
        agentFactory: makeFactory(
          ["pass A", "pass B"],  // case-B answer contains "pass B"
          ["read_file"],
        ),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B", expectedOutput: "pass B" },
        ],
        outputDir,
      });

      await run1.run();
      const files = fs.readdirSync(outputDir);
      const baselinePath = path.join(outputDir, files.find((f) => f.endsWith(".json"))!);

      // Current: case B fails (missing tool + wrong output)
      const run2 = new Benchmark({
        name: "regression-test",
        agentFactory: makeFactory(
          ["ok A", "wrong answer"],
          [] /* NO read_file — case A also fails now */,
        ),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B", expectedOutput: "pass B" },
        ],
        outputDir,
        baselinePath,
      });

      const current = await run2.run();
      expect(current.summary.regressions.length).toBeGreaterThan(0);

      // At least one regression for case A (flipped from pass to fail)
      const regACase = current.summary.regressions.find(
        (r) => r.target === "A",
      );
      expect(regACase).toBeTruthy();
      expect(regACase!.metric).toBe("passed");
    });

    it("detects a pass rate regression", async () => {
      // Baseline: 2/2 pass
      const run1 = new Benchmark({
        name: "pass-rate-test",
        agentFactory: makeFactory(["A", "B"], ["read_file"]),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B" },
        ],
        outputDir,
      });

      await run1.run();
      const files = fs.readdirSync(outputDir);
      const baselinePath = path.join(outputDir, files.find((f) => f.endsWith(".json"))!);

      // Current: 0/2 pass
      const run2 = new Benchmark({
        name: "pass-rate-test",
        agentFactory: makeFactory(["A", "not B"]),
        cases: [
          { name: "A", input: "A", expectedTools: ["read_file"] },
          { name: "B", input: "B", expectedOutput: "B"},
        ],
        outputDir,
        baselinePath,
      });

      const current = await run2.run();
      const rateReg = current.summary.regressions.find(
        (r) => r.metric === "passRate",
      );
      expect(rateReg).toBeTruthy();
    });

    it("handles missing baseline file gracefully", async () => {
      const benchmark = new Benchmark({
        name: "no-baseline",
        agentFactory: makeFactory(["ok"]),
        cases: [{ name: "x", input: "x" }],
        outputDir,
        baselinePath: path.join(outputDir, "nonexistent.json"),
      });

      const result = await benchmark.run();
      // Should complete without error — no regressions (nothing to compare)
      expect(result.summary.regressions).toEqual([]);
    });
  });

  // ── Report generation ──────────────────────────────────────────────

  describe("generateReport", () => {
    it("generates a markdown report with summary and per-case table", async () => {
      const benchmark = new Benchmark({
        name: "report-test",
        agentFactory: makeFactory(["answer 1", "answer 2"]),
        cases: [
          { name: "first", input: "q1" },
          { name: "second", input: "q2", expectedOutput: "MISSING" },
        ],
        outputDir,
      });

      const result = await benchmark.run();
      const report = benchmark.generateReport(result);

      expect(report).toContain("# Benchmark: report-test");
      expect(report).toContain("## Summary");
      expect(report).toContain("50.0%"); // 1 of 2 passed
      expect(report).toContain("## Per-Case Results");
      expect(report).toContain("✅");
      expect(report).toContain("❌");
    });

    it("shows no regressions when none detected", async () => {
      const benchmark = new Benchmark({
        name: "clean",
        agentFactory: makeFactory(["ok"]),
        cases: [{ name: "passing", input: "x" }],
        outputDir,
      });

      const result = await benchmark.run();
      const report = benchmark.generateReport(result);
      expect(report).toContain("No Regressions");
    });
  });
});
