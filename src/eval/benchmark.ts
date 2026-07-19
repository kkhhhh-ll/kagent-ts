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
   * When omitted, a default EvalRunner is created.
   */
  runner?: EvalRunner;

  // ── Regression thresholds (all optional, with sensible defaults) ──────

  /**
   * Minimum drop in pass rate to flag as a regression.
   * Expressed as a fraction (0–1).  Default: 0.05 (5 percentage points).
   */
  passRateRegressionThreshold?: number;

  /**
   * Minimum increase in per-case failure count to flag as a regression.
   * Expressed as an absolute count.  Default: 2.
   */
  failureCountRegressionThreshold?: number;

  /**
   * Factor by which average case duration must increase to flag as a
   * latency regression.  Default: 1.5 (50% slower).
   */
  latencyRegressionFactor?: number;

  /**
   * Minimum absolute increase in average case duration to flag as a
   * latency regression (ms).  Prevents noise when durations are very
   * small.  Default: 1_000 (1 second).
   */
  latencyMinAbsoluteIncreaseMs?: number;
}

// ─── Default Regression Thresholds ─────────────────────────────────────────

const DEFAULT_PASS_RATE_THRESHOLD = 0.05;
const DEFAULT_FAILURE_COUNT_THRESHOLD = 2;
const DEFAULT_LATENCY_FACTOR = 1.5;
const DEFAULT_LATENCY_MIN_ABSOLUTE_MS = 1000;

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
 *   baselinePath: ".kagent-benchmarks/benchmark-xxx.json",
 *   // Optional: customise regression thresholds
 *   passRateRegressionThreshold: 0.1,   // 10pp drop → alert (default: 0.05)
 *   latencyRegressionFactor: 2,         // 2× slower → alert (default: 1.5)
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

    const passRateThreshold =
      this.config.passRateRegressionThreshold ?? DEFAULT_PASS_RATE_THRESHOLD;

    // ── Pass rate regression ──────────────────────────────────────────
    if (bl.passRate - summary.passRate >= passRateThreshold) {
      const drop = ((bl.passRate - summary.passRate) * 100).toFixed(1);
      summary.regressions.push({
        target: "overall",
        metric: "passRate",
        baseline: `${(bl.passRate * 100).toFixed(1)}%`,
        current: `${(summary.passRate * 100).toFixed(1)}%`,
        description: `Pass rate dropped by ${drop} percentage points.`,
      });
    } else if (
      summary.passRate - bl.passRate >= passRateThreshold
    ) {
      summary.improvements.push({
        target: "overall",
        metric: "passRate",
        baseline: `${(bl.passRate * 100).toFixed(1)}%`,
        current: `${(summary.passRate * 100).toFixed(1)}%`,
      });
    }

    const latencyFactor =
      this.config.latencyRegressionFactor ?? DEFAULT_LATENCY_FACTOR;
    const latencyMinAbs =
      this.config.latencyMinAbsoluteIncreaseMs ?? DEFAULT_LATENCY_MIN_ABSOLUTE_MS;

    // ── Latency regression ────────────────────────────────────────────
    if (
      summary.avgCaseDurationMs > bl.avgCaseDurationMs * latencyFactor &&
      summary.avgCaseDurationMs - bl.avgCaseDurationMs > latencyMinAbs
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
      const failThreshold =
        this.config.failureCountRegressionThreshold ?? DEFAULT_FAILURE_COUNT_THRESHOLD;
      if (currFailCount - prevFailCount >= failThreshold) {
        summary.regressions.push({
          target: current.caseName,
          metric: "failureCount",
          baseline: String(prevFailCount),
          current: String(currFailCount),
          description: `Failure count increased from ${prevFailCount} to ${currFailCount}.`,
        });
      }

      // ── Per-tool comparison ──────────────────────────────────────
      const prevToolMap = new Map(
        prev.scorecard.perTool.map((t) => [t.toolName, t]),
      );

      for (const curTool of current.scorecard.perTool) {
        const prevTool = prevToolMap.get(curTool.toolName);
        if (!prevTool) continue; // New tool — no baseline

        const toolLabel = `${current.caseName}/${curTool.toolName}`;

        // Per-tool P50 latency
        if (
          curTool.p50LatencyMs > prevTool.p50LatencyMs * latencyFactor &&
          curTool.p50LatencyMs - prevTool.p50LatencyMs > latencyMinAbs
        ) {
          summary.regressions.push({
            target: toolLabel,
            metric: "p50LatencyMs",
            baseline: `${prevTool.p50LatencyMs}ms`,
            current: `${curTool.p50LatencyMs}ms`,
            description: `P50 latency increased by ${
              curTool.p50LatencyMs - prevTool.p50LatencyMs
            }ms.`,
          });
        }

        // Per-tool P99 latency
        if (
          curTool.p99LatencyMs > prevTool.p99LatencyMs * latencyFactor &&
          curTool.p99LatencyMs - prevTool.p99LatencyMs > latencyMinAbs
        ) {
          summary.regressions.push({
            target: toolLabel,
            metric: "p99LatencyMs",
            baseline: `${prevTool.p99LatencyMs}ms`,
            current: `${curTool.p99LatencyMs}ms`,
            description: `P99 latency increased by ${
              curTool.p99LatencyMs - prevTool.p99LatencyMs
            }ms.`,
          });
        }

        // Per-tool success rate regression
        if (prevTool.successRate - curTool.successRate >= passRateThreshold) {
          const drop = ((prevTool.successRate - curTool.successRate) * 100).toFixed(1);
          summary.regressions.push({
            target: toolLabel,
            metric: "successRate",
            baseline: `${(prevTool.successRate * 100).toFixed(1)}%`,
            current: `${(curTool.successRate * 100).toFixed(1)}%`,
            description: `Success rate dropped by ${drop} percentage points.`,
          });
        }

        // Per-tool retry increase
        if (curTool.avgRetries - prevTool.avgRetries >= failThreshold) {
          summary.regressions.push({
            target: toolLabel,
            metric: "avgRetries",
            baseline: prevTool.avgRetries.toFixed(1),
            current: curTool.avgRetries.toFixed(1),
            description: `Avg retries increased from ${prevTool.avgRetries.toFixed(1)} to ${curTool.avgRetries.toFixed(1)}.`,
          });
        }

        // Per-tool circuit breaker trip increase
        if (curTool.circuitBreakerTrips > prevTool.circuitBreakerTrips) {
          summary.regressions.push({
            target: toolLabel,
            metric: "circuitBreakerTrips",
            baseline: String(prevTool.circuitBreakerTrips),
            current: String(curTool.circuitBreakerTrips),
            description: `Circuit breaker tripped ${curTool.circuitBreakerTrips - prevTool.circuitBreakerTrips} more time(s).`,
          });
        }
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
