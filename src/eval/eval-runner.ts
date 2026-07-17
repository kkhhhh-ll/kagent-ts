import { ToolCallEvaluator } from "./tool-call-evaluator";
import type { EvalCase, EvalResult } from "./types";

// ─── Re-export for convenience ─────────────────────────────────────────────

export type { EvalCase, EvalResult } from "./types";

/**
 * An agent factory — called once per eval case to create a fresh agent
 * with a ToolCallEvaluator hook attached.
 */
export type AgentFactory = (evaluator: ToolCallEvaluator) => {
  run(input: string): Promise<string>;
  cancel(): void;
};

/**
 * Configuration for the EvalRunner.
 */
export interface EvalRunnerConfig {
  /**
   * Default timeout per case in milliseconds.
   * Cases can override with their own `timeoutMs`.
   * Default: 120_000 (2 minutes).
   */
  defaultTimeoutMs?: number;
}

/**
 * EvalRunner — runs test cases against an agent and produces pass/fail results.
 *
 * Uses an agent factory so each case starts fresh (no context pollution between
 * cases). The factory receives a ToolCallEvaluator hook to collect metrics.
 *
 * This is an internal implementation detail of {@link Benchmark}.  Most users
 * should use `Benchmark` directly rather than `EvalRunner`.
 *
 * @internal
 */
export class EvalRunner {
  private defaultTimeoutMs: number;

  constructor(config?: EvalRunnerConfig) {
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Run a batch of evaluation cases.
   *
   * @param factory Creates a fresh agent for each case. Receives a
   *                ToolCallEvaluator hook that MUST be attached to the
   *                agent's hooks array.
   * @param cases   The test cases to run.
   * @returns One EvalResult per case.
   */
  async run(factory: AgentFactory, cases: EvalCase[]): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const c of cases) {
      const evaluator = new ToolCallEvaluator();
      const agent = factory(evaluator);
      const caseTimeout = c.timeoutMs ?? this.defaultTimeoutMs;
      const startedAt = Date.now();

      let answer: string;
      const failures: string[] = [];

      try {
        answer = await withTimeout(agent.run(c.input), caseTimeout);

        // Collect called tool names (deduplicated) for expected/forbidden checks
        const calledTools = new Set(
          evaluator
            .getRecords()
            .filter((r) => r.endTime)
            .map((r) => r.toolName),
        );

        // ── Checks ──────────────────────────────────────────────────

        if (c.expectedTools && c.expectedTools.length > 0) {
          for (const expected of c.expectedTools) {
            if (!calledTools.has(expected)) {
              failures.push(`Expected tool "${expected}" was not called.`);
            }
          }
        }

        if (c.forbiddenTools && c.forbiddenTools.length > 0) {
          for (const forbidden of c.forbiddenTools) {
            if (calledTools.has(forbidden)) {
              failures.push(`Forbidden tool "${forbidden}" was called.`);
            }
          }
        }

        if (c.expectedOutput) {
          const pattern = c.expectedOutput;
          const matches =
            typeof pattern === "string"
              ? answer.includes(pattern)
              : pattern.test(answer);
          if (!matches) {
            failures.push(
              `Answer does not match expected pattern: "${pattern}".`,
            );
          }
        }
      } catch (err: unknown) {
        // Stop the agent to prevent resource leaks (e.g., orphaned LLM calls
        // or tool executions continuing after timeout).
        agent.cancel();

        answer = err instanceof Error ? err.message : String(err);
        failures.push(`Execution error: ${answer}`);
      }

      const durationMs = Date.now() - startedAt;
      const scorecard = evaluator.getScorecard();

      results.push({
        caseName: c.name,
        passed: failures.length === 0,
        answer,
        durationMs,
        scorecard,
        failures,
      });
    }

    return results;
  }

  /**
   * Run a single case and return the result (convenience method).
   */
  async runCase(factory: AgentFactory, c: EvalCase): Promise<EvalResult> {
    const results = await this.run(factory, [c]);
    return results[0];
  }

  /**
   * Generate a Markdown report from evaluation results.
   */
  generateReport(results: EvalResult[]): string {
    const summary = summarizeEvalResults(results);

    let report = `# Evaluation Report\n\n`;
    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Cases | ${summary.total} |\n`;
    report += `| Passed | ${summary.passed} |\n`;
    report += `| Failed | ${summary.total - summary.passed} |\n`;
    report += `| Pass Rate | ${(summary.passRate * 100).toFixed(1)}% |\n`;
    report += `| Avg Duration | ${summary.avgDurationMs}ms |\n\n`;

    report += `## Results\n\n`;

    for (const r of results) {
      const icon = r.passed ? "✅" : "❌";
      const toolNames = r.scorecard.perTool.map((t) => t.toolName);
      report += `### ${icon} ${r.caseName}\n\n`;
      report += `- **Duration:** ${r.durationMs}ms\n`;
      report += `- **Tool calls:** ${r.scorecard.totalCalls} (${toolNames.join(", ") || "none"})\n`;
      report += `- **Tool success rate:** ${(r.scorecard.overallSuccessRate * 100).toFixed(1)}%\n`;

      if (r.failures.length > 0) {
        report += `- **Failures:**\n`;
        for (const f of r.failures) {
          report += `  - ${f}\n`;
        }
      }

      // Per-tool breakdown (P50/P99/retries from scorecard)
      if (r.scorecard.perTool.length > 0) {
        report += `\n| Tool | Calls | Success Rate | Avg | P50 | P99 | Retries |\n`;
        report += `|------|-------|-------------|-----|-----|-----|--------|\n`;
        for (const stat of r.scorecard.perTool) {
          const sr = (stat.successRate * 100).toFixed(0);
          report += `| \`${stat.toolName}\` | ${stat.totalCalls} | ${sr}% | ${stat.avgLatencyMs}ms | ${stat.p50LatencyMs}ms | ${stat.p99LatencyMs}ms | ${stat.avgRetries.toFixed(1)} |\n`;
        }
      }

      report += `\n<details>\n<summary>Answer</summary>\n\n${r.answer}\n\n</details>\n\n`;
    }

    report += `---\n*Generated at ${new Date().toISOString()}*\n`;
    return report;
  }

}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Computed summary of a batch of evaluation results.
 * Used by both EvalRunner.generateReport() and Benchmark.buildSummary()
 * to avoid duplicated pass-rate / duration aggregation logic.
 */
export interface EvalResultsSummary {
  total: number;
  passed: number;
  passRate: number; // 0–1
  avgDurationMs: number;
  avgToolCalls: number;
}

/**
 * Aggregate summary statistics from a list of EvalResults.
 */
export function summarizeEvalResults(results: EvalResult[]): EvalResultsSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const avgDurationMs =
    total > 0
      ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / total)
      : 0;
  const avgToolCalls =
    total > 0
      ? results.reduce((s, r) => s + r.scorecard.totalCalls, 0) / total
      : 0;

  return {
    total,
    passed,
    passRate: total > 0 ? passed / total : 1,
    avgDurationMs,
    avgToolCalls,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs / 1000}s.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
