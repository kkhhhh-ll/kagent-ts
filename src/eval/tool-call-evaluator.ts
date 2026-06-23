import { AgentHooks } from "../core/hooks";
import type { LLMResponse } from "../llm/interface";
import type { LLMNetworkError } from "../llm/errors";
import type { MessageData } from "../messages/types";
import type { Tool } from "../tools/types";
import { ToolErrorCode } from "../tools/types";
import type {
  ToolCallRecord,
  ToolCallStats,
  ToolCallScorecard,
} from "./types";

/**
 * ToolCallEvaluator — collects per-tool-call metrics via AgentHooks.
 *
 * Attach to any agent to track tool call performance:
 * ```ts
 * const evaluator = new ToolCallEvaluator();
 * const agent = new ReActAgent({ llm, hooks: [evaluator, ...otherHooks] });
 * await agent.run("...");
 * console.log(evaluator.generateReport());
 * ```
 */
export class ToolCallEvaluator implements AgentHooks {
  /** All recorded tool calls in chronological order. */
  private records: ToolCallRecord[] = [];

  /** Per-tool attempt counters (reset on success). */
  private attemptCounters: Map<string, number> = new Map();

  /** Per-tool circuit breaker trip counters. */
  private circuitBreakerTripCounts: Map<string, number> = new Map();

  // ─── AgentHooks Implementation ─────────────────────────────────────────

  onLLMStart?:
    | ((messages: MessageData[], tools: Tool[]) => void)
    | undefined = undefined;

  onLLMEnd?: ((response: LLMResponse) => void) | undefined = undefined;

  onLLMError?: ((error: LLMNetworkError) => void) | undefined = undefined;

  onToolStart(toolName: string, args: Record<string, unknown>, toolCallId?: string): void {
    const attempt = this.attemptCounters.get(toolName) ?? 0;

    this.records.push({
      toolCallId,
      toolName,
      args,
      startTime: new Date().toISOString(),
      success: false, // set on end/error
      attemptNumber: attempt + 1,
    });
  }

  onToolEnd(toolName: string, result: string, toolCallId?: string): void {
    this.attemptCounters.set(toolName, 0); // reset on success

    const record = this.findRecord(toolName, toolCallId);
    if (!record) return;

    record.endTime = new Date().toISOString();
    record.latencyMs =
      new Date(record.endTime).getTime() -
      new Date(record.startTime).getTime();
    record.success = true;
    record.errorCode = ToolErrorCode.SUCCESS;
    record.resultLength = result.length;
  }

  onToolError(toolName: string, error: string, toolCallId?: string): void {
    const attempt = (this.attemptCounters.get(toolName) ?? 0) + 1;
    this.attemptCounters.set(toolName, attempt);

    const record = this.findRecord(toolName, toolCallId);
    if (!record) return;

    record.endTime = new Date().toISOString();
    record.latencyMs =
      new Date(record.endTime).getTime() -
      new Date(record.startTime).getTime();
    record.success = false;
    record.error = error;
    record.attemptNumber = attempt;

    // Extract error code from the structured error message
    record.errorCode = this.extractErrorCode(error);

    // Track circuit breaker trips
    if (record.errorCode === ToolErrorCode.CIRCUIT_OPEN) {
      this.circuitBreakerTripCounts.set(
        toolName,
        (this.circuitBreakerTripCounts.get(toolName) ?? 0) + 1,
      );
    }
  }

  onThought?: ((thought: string) => void) | undefined = undefined;
  onPlanCreated?: ((plan: string[]) => void) | undefined = undefined;
  onPlanRevised?: ((plan: string[]) => void) | undefined = undefined;
  onFinish?: ((answer: string) => void) | undefined = undefined;

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Get all raw tool call records.
   */
  getRecords(): ToolCallRecord[] {
    return [...this.records];
  }

  /**
   * Compute the aggregated scorecard from all recorded calls.
   */
  getScorecard(): ToolCallScorecard {
    const allStats = this.computePerToolStats();
    const totalCalls = allStats.reduce((s, t) => s + t.totalCalls, 0);
    const totalSuccesses = allStats.reduce((s, t) => s + t.successCount, 0);
    const totalFailures = totalCalls - totalSuccesses;

    const allLatencies = allStats.flatMap((t) => t.latencySamples);
    const avgLatencyMs =
      allLatencies.length > 0
        ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length)
        : 0;

    const circuitBreakerTrips = allStats.reduce(
      (s, t) => s + t.circuitBreakerTrips,
      0,
    );

    return {
      totalCalls,
      totalSuccesses,
      totalFailures,
      overallSuccessRate: totalCalls > 0 ? totalSuccesses / totalCalls : 1,
      avgLatencyMs,
      uniqueToolsUsed: allStats.length,
      circuitBreakerTrips,
      perTool: allStats.sort((a, b) => b.totalCalls - a.totalCalls),
    };
  }

  /**
   * Generate a Markdown report of tool call metrics.
   */
  generateReport(): string {
    const scorecard = this.getScorecard();
    if (scorecard.totalCalls === 0) {
      return "# Tool Call Evaluation Report\n\n*No tool calls recorded.*\n";
    }

    const ratePercent = (scorecard.overallSuccessRate * 100).toFixed(1);

    let report = `# Tool Call Evaluation Report\n\n`;
    report += `## Summary\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Total Calls | ${scorecard.totalCalls} |\n`;
    report += `| Successes | ${scorecard.totalSuccesses} |\n`;
    report += `| Failures | ${scorecard.totalFailures} |\n`;
    report += `| Success Rate | ${ratePercent}% |\n`;
    report += `| Avg Latency | ${scorecard.avgLatencyMs}ms |\n`;
    report += `| Unique Tools Used | ${scorecard.uniqueToolsUsed} |\n`;
    report += `| Circuit Breaker Trips | ${scorecard.circuitBreakerTrips} |\n\n`;

    report += `## Per-Tool Breakdown\n\n`;
    report += `| Tool | Calls | Success Rate | Avg Latency | P50 | P99 | Avg Retries | CB Trips |\n`;
    report += `|------|-------|-------------|-------------|-----|-----|-------------|----------|\n`;

    for (const stat of scorecard.perTool) {
      const sr = (stat.successRate * 100).toFixed(1);
      report += `| \`${stat.toolName}\` | ${stat.totalCalls} | ${sr}% | ${stat.avgLatencyMs}ms | ${stat.p50LatencyMs}ms | ${stat.p99LatencyMs}ms | ${stat.avgRetries.toFixed(1)} | ${stat.circuitBreakerTrips} |\n`;
    }

    report += `\n## Error Distribution\n\n`;

    for (const stat of scorecard.perTool) {
      if (Object.keys(stat.errorDistribution).length === 0) continue;
      report += `### ${stat.toolName}\n\n`;
      report += `| Error Code | Count |\n`;
      report += `|------------|-------|\n`;
      for (const [code, count] of Object.entries(stat.errorDistribution)) {
        report += `| \`${code}\` | ${count} |\n`;
      }
      report += `\n`;
    }

    report += `---\n*Generated at ${new Date().toISOString()}*\n`;

    return report;
  }

  /**
   * Reset all counters and records.
   */
  reset(): void {
    this.records = [];
    this.attemptCounters.clear();
    this.circuitBreakerTripCounts.clear();
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  /**
   * Find the matching uncompleted record for a tool call.
   *
   * When `toolCallId` is provided, performs an exact match (preferred:
   * handles parallel calls to the same tool correctly). Falls back to
   * reverse-scan by tool name when the ID is not available (legacy
   * hooks that don't pass `toolCallId`).
   */
  private findRecord(
    toolName: string,
    toolCallId?: string,
  ): ToolCallRecord | undefined {
    // Exact ID match — correct even when the same tool is called
    // multiple times within one LLM response batch.
    if (toolCallId) {
      for (let i = this.records.length - 1; i >= 0; i--) {
        if (this.records[i].toolCallId === toolCallId && !this.records[i].endTime) {
          return this.records[i];
        }
      }
      return undefined;
    }

    // Legacy fallback — reverse scan by tool name only.
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].toolName === toolName && !this.records[i].endTime) {
        return this.records[i];
      }
    }
    return undefined;
  }

  /**
   * Extract a ToolErrorCode from the structured error message format.
   *
   * Error messages follow the pattern:
   *   [SEVERITY:ERROR_CODE] Human-readable message...
   */
  private extractErrorCode(error: string): ToolErrorCode {
    const match = error.match(/\[(?:RETRYABLE|FATAL):([A-Z_]+)\]/);
    if (match) {
      const code = match[1] as ToolErrorCode;
      if (Object.values(ToolErrorCode).includes(code)) {
        return code;
      }
    }
    return ToolErrorCode.EXECUTION_FAILURE; // default for unparseable errors
  }

  /**
   * Compute per-tool statistics from raw records.
   */
  private computePerToolStats(): ToolCallStats[] {
    const byTool = new Map<string, ToolCallRecord[]>();
    for (const r of this.records) {
      if (!byTool.has(r.toolName)) byTool.set(r.toolName, []);
      byTool.get(r.toolName)!.push(r);
    }

    const stats: ToolCallStats[] = [];
    for (const [toolName, records] of byTool) {
      const completed = records.filter((r) => r.endTime);
      const successes = completed.filter((r) => r.success);
      const failures = completed.filter((r) => !r.success);
      const latencies = completed
        .filter((r) => r.latencyMs !== undefined)
        .map((r) => r.latencyMs!);

      // Error distribution
      const errorDist: Record<string, number> = {};
      for (const f of failures) {
        const code = f.errorCode ?? ToolErrorCode.EXECUTION_FAILURE;
        errorDist[code] = (errorDist[code] ?? 0) + 1;
      }

      stats.push({
        toolName,
        totalCalls: completed.length,
        successCount: successes.length,
        failureCount: failures.length,
        successRate:
          completed.length > 0 ? successes.length / completed.length : 1,
        avgLatencyMs:
          latencies.length > 0
            ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
            : 0,
        p50LatencyMs: percentile(latencies, 50),
        p99LatencyMs: percentile(latencies, 99),
        avgRetries:
          successes.length > 0
            ? failures.length / successes.length
            : failures.length,
        circuitBreakerTrips:
          this.circuitBreakerTripCounts.get(toolName) ?? 0,
        errorDistribution: errorDist,
        latencySamples: latencies,
      });
    }

    return stats;
  }
}

/**
 * Compute a percentile from an array of numbers.
 * Uses linear interpolation between closest ranks.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const index = (p / 100) * (arr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Math.round(arr[lower]);
  const weight = index - lower;
  return Math.round(arr[lower] * (1 - weight) + arr[upper] * weight);
}
