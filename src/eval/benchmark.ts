import * as fs from "fs";
import * as path from "path";
import { EvalRunner, summarizeEvalResults } from "./eval-runner";
import type { AgentFactory } from "./eval-runner";
import type { EvalCase, EvalResult, BenchmarkResult, BenchmarkSummary } from "./types";

/**
 * Configuration for a benchmark run.
 */
export interface BenchmarkConfig {
  /** Human-readable benchmark name. */
  name: string;

  /**
   * Agent factory — creates a fresh agent for each case.
   * Receives a ToolCallEvaluator hook to attach.
   */
  agentFactory: AgentFactory;

  /** Test cases to run. */
  cases: EvalCase[];

  /**
   * Path to a baseline JSON file from a previous run.
   * When set, results are compared against this baseline and
   * regressions / improvements are flagged.
   */
  baselinePath?: string;

  /**
   * Directory for persisting benchmark results.
   * Default: `.kagent-benchmarks/`.
   */
  outputDir?: string;

  /**
   * EvalRunner instance (shared across cases).
   * When omitted, a default EvalRunner is created (no LLM judge).
   */
  runner?: EvalRunner;
}

// ─── Regression Detection Thresholds ─────────────────────────────────────

/** Minimum drop in success rate to flag as a regression (percentage points). */
const SUCCESS_RATE_REGRESSION_THRESHOLD = 0.05;

/** Minimum increase in failures to flag as a regression (absolute count). */
const FAILURE_COUNT_REGRESSION_THRESHOLD = 2;

/** Factor by which latency must increase to flag as a regression. */
const LATENCY_REGRESSION_FACTOR = 1.5;

/** Minimum absolute latency increase to flag (ms). */
const LATENCY_MIN_ABSOLUTE_INCREASE_MS = 1000;

/**
 * Benchmark — runs evaluation cases against an agent, compares with
 * baseline results, and flags regressions & improvements.
 *
 * Usage:
 * ```ts
 * const benchmark = new Benchmark({
 *   name: "tool-calling-v2",
 *   agentFactory: (evaluator) => new ReActAgent({ llm, hooks: [evaluator] }),
 *   cases: myEvalCases,
 *   baselinePath: ".kagent-benchmarks/tool-calling-v1.json",
 * });
 *
 * const result = await benchmark.run();
 * console.log(benchmark.generateReport(result));
 * ```
 */
export class Benchmark {
  private config: BenchmarkConfig;
  private outputDir: string;

  constructor(config: BenchmarkConfig) {
    this.config = config;
    this.outputDir = path.resolve(config.outputDir ?? ".kagent-benchmarks");
  }

  /**
   * Run the benchmark and return results.
   *
   * Results are automatically persisted to disk so they can serve
   * as the baseline for future runs.
   */
  async run(): Promise<BenchmarkResult> {
    const runner = this.config.runner ?? new EvalRunner();
    const cases = this.config.cases;
    const timestamp = new Date().toISOString();

    // Run all cases
    const results = await runner.run(this.config.agentFactory, cases);

    // Build summary
    const summary = this.buildSummary(results, timestamp);

    // Compare against baseline if available
    if (this.config.baselinePath) {
      const baseline = this.loadBaseline();
      if (baseline) {
        this.compareWithBaseline(summary, baseline, results);
      }
    }

    const result: BenchmarkResult = { summary, cases: results };

    // Persist for future baseline use
    this.persistResult(result);

    return result;
  }

  /**
   * Generate a Markdown comparison report.
   */
  generateReport(result: BenchmarkResult): string {
    const s = result.summary;
    const passRate = (s.passRate * 100).toFixed(1);

    let report = `# Benchmark: ${s.name}\n\n`;
    report += `**Run at:** ${s.timestamp}\n\n`;

    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Pass Rate | ${passRate}% (${s.passed}/${s.total}) |\n`;
    report += `| Avg Tool Calls / Case | ${s.avgToolCallsPerCase.toFixed(1)} |\n`;
    report += `| Avg Duration | ${s.avgCaseDurationMs}ms |\n\n`;

    // Regressions (most important — show first)
    if (s.regressions.length > 0) {
      report += `## ⚠️ Regressions\n\n`;
      report += `| Target | Metric | Baseline | Current | Details |\n`;
      report += `|--------|--------|----------|---------|----------|\n`;
      for (const r of s.regressions) {
        report += `| ${r.target} | ${r.metric} | ${r.baseline} | ${r.current} | ${r.description} |\n`;
      }
      report += `\n`;
    } else {
      report += `## ✅ No Regressions\n\n`;
    }

    // Improvements
    if (s.improvements.length > 0) {
      report += `## 📈 Improvements\n\n`;
      report += `| Target | Metric | Baseline | Current |\n`;
      report += `|--------|--------|----------|--------|\n`;
      for (const imp of s.improvements) {
        report += `| ${imp.target} | ${imp.metric} | ${imp.baseline} | ${imp.current} |\n`;
      }
      report += `\n`;
    }

    // Per-case results
    report += `## Per-Case Results\n\n`;
    report += `| Case | Status | Duration | Tool Calls | Success Rate |\n`;
    report += `|------|--------|----------|------------|-------------|\n`;
    for (const r of result.cases) {
      const icon = r.passed ? "✅" : "❌";
      const sr = (r.scorecard.overallSuccessRate * 100).toFixed(0);
      report += `| ${icon} ${r.caseName} | ${r.passed ? "PASS" : "FAIL"} | ${r.durationMs}ms | ${r.scorecard.totalCalls} | ${sr}% |\n`;
    }
    report += `\n`;

    // Failure details
    const failures = result.cases.filter((r) => !r.passed);
    if (failures.length > 0) {
      report += `## Failure Details\n\n`;
      for (const f of failures) {
        report += `### ❌ ${f.caseName}\n\n`;
        for (const reason of f.failures) {
          report += `- ${reason}\n`;
        }
        report += `\n`;
      }
    }

    report += `---\n*Generated at ${new Date().toISOString()}*\n`;
    return report;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private buildSummary(
    results: EvalResult[],
    timestamp: string,
  ): BenchmarkSummary {
    const s = summarizeEvalResults(results);

    return {
      name: this.config.name,
      timestamp,
      passed: s.passed,
      total: s.total,
      passRate: s.passRate,
      avgToolCallsPerCase: s.avgToolCalls,
      avgCaseDurationMs: s.avgDurationMs,
      regressions: [],
      improvements: [],
    };
  }

  /**
   * Compare current results against a baseline and populate
   * regressions / improvements in the summary.
   */
  private compareWithBaseline(
    summary: BenchmarkSummary,
    baseline: BenchmarkResult,
    currentResults: EvalResult[],
  ): void {
    const bl = baseline.summary;

    // ── Pass rate regression ──────────────────────────────────────────
    if (bl.passRate - summary.passRate >= SUCCESS_RATE_REGRESSION_THRESHOLD) {
      const drop = ((bl.passRate - summary.passRate) * 100).toFixed(1);
      summary.regressions.push({
        target: "overall",
        metric: "passRate",
        baseline: `${(bl.passRate * 100).toFixed(1)}%`,
        current: `${(summary.passRate * 100).toFixed(1)}%`,
        description: `Pass rate dropped by ${drop} percentage points.`,
      });
    } else if (
      summary.passRate - bl.passRate >=
      SUCCESS_RATE_REGRESSION_THRESHOLD
    ) {
      summary.improvements.push({
        target: "overall",
        metric: "passRate",
        baseline: `${(bl.passRate * 100).toFixed(1)}%`,
        current: `${(summary.passRate * 100).toFixed(1)}%`,
      });
    }

    // ── Latency regression ────────────────────────────────────────────
    if (
      summary.avgCaseDurationMs > bl.avgCaseDurationMs * LATENCY_REGRESSION_FACTOR &&
      summary.avgCaseDurationMs - bl.avgCaseDurationMs > LATENCY_MIN_ABSOLUTE_INCREASE_MS
    ) {
      summary.regressions.push({
        target: "overall",
        metric: "avgCaseDurationMs",
        baseline: `${bl.avgCaseDurationMs}ms`,
        current: `${summary.avgCaseDurationMs}ms`,
        description: `Average case duration increased by ${
          summary.avgCaseDurationMs - bl.avgCaseDurationMs
        }ms.`,
      });
    }

    // ── Per-case comparison ───────────────────────────────────────────
    const baselineCases = new Map(baseline.cases.map((c) => [c.caseName, c]));

    for (const current of currentResults) {
      const prev = baselineCases.get(current.caseName);
      if (!prev) continue; // New case — no baseline to compare

      // Case flipped from pass to fail
      if (prev.passed && !current.passed) {
        summary.regressions.push({
          target: current.caseName,
          metric: "passed",
          baseline: "true",
          current: "false",
          description: `"${current.caseName}" went from PASS to FAIL. Failures: ${current.failures.join("; ")}`,
        });
      }

      // Case flipped from fail to pass
      if (!prev.passed && current.passed) {
        summary.improvements.push({
          target: current.caseName,
          metric: "passed",
          baseline: "false",
          current: "true",
        });
      }

      // Failure count increased significantly
      const prevFailCount = prev.failures.length;
      const currFailCount = current.failures.length;
      if (currFailCount - prevFailCount >= FAILURE_COUNT_REGRESSION_THRESHOLD) {
        summary.regressions.push({
          target: current.caseName,
          metric: "failureCount",
          baseline: String(prevFailCount),
          current: String(currFailCount),
          description: `Failure count increased from ${prevFailCount} to ${currFailCount}.`,
        });
      }
    }
  }

  /**
   * Load baseline results from disk.
   */
  private loadBaseline(): BenchmarkResult | null {
    if (!this.config.baselinePath) return null;

    try {
      const raw = fs.readFileSync(path.resolve(this.config.baselinePath), "utf-8");
      return JSON.parse(raw) as BenchmarkResult;
    } catch {
      return null;
    }
  }

  /**
   * Persist results to disk for future baseline use.
   */
  private persistResult(result: BenchmarkResult): void {
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });

      // Same naming convention as kagent-sessions:
      //   benchmark-{Date.now()}-{random6}.json
      // The human-readable name is stored inside the JSON (result.summary.name).
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const filename = `benchmark-${ts}-${rand}.json`;
      const filePath = path.join(this.outputDir, filename);

      fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
    } catch {
      // Best-effort persistence — never throw from persist
    }
  }
}
