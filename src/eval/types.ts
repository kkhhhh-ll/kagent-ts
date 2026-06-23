import type { ToolErrorCode } from "../tools/types";

/**
 * Types for the agent evaluation framework.
 *
 * Three layers of evaluation:
 * 1. ToolCallEvaluator  — per-tool-call metrics (observed via AgentHooks)
 * 2. EvalRunner         — end-to-end test cases with pass/fail criteria
 * 3. Benchmark          — regression testing across runs
 */

// ─── Tool Call Recording ──────────────────────────────────────────────────

/**
 * A single tool call record captured by the ToolCallEvaluator hook.
 */
export interface ToolCallRecord {
  /** The tool being called. */
  toolName: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** ISO-8601 timestamp when execution started. */
  startTime: string;
  /** ISO-8601 timestamp when execution ended (set on success or error). */
  endTime?: string;
  /** Wall-clock duration in milliseconds. */
  latencyMs?: number;
  /** Whether the tool executed successfully. */
  success: boolean;
  /** Error message if the tool failed. */
  error?: string;
  /** Machine-readable error code (SUCCESS if no error). */
  errorCode?: ToolErrorCode;
  /** Attempt number within the current circuit-breaker cycle (1-based). */
  attemptNumber: number;
  /** Length of the result content in characters. */
  resultLength?: number;
}

/**
 * Aggregated per-tool statistics computed from all recorded calls.
 */
export interface ToolCallStats {
  /** Tool name. */
  toolName: string;
  /** Total number of call attempts (successes + failures). */
  totalCalls: number;
  /** Number of successful calls. */
  successCount: number;
  /** Number of failed calls. */
  failureCount: number;
  /** Success rate (0–1). */
  successRate: number;
  /** Average latency in milliseconds. */
  avgLatencyMs: number;
  /** Median (P50) latency in milliseconds. */
  p50LatencyMs: number;
  /** P99 latency in milliseconds. */
  p99LatencyMs: number;
  /** Average number of retries before success or circuit open. */
  avgRetries: number;
  /** How many times the circuit breaker opened for this tool. */
  circuitBreakerTrips: number;
  /** Distribution of error codes for failed calls. */
  errorDistribution: Record<string, number>;
  /** Raw latency samples (for percentile computation). */
  latencySamples: number[];
}

/**
 * Overall scorecard produced at the end of a session.
 */
export interface ToolCallScorecard {
  /** Total tool calls across all tools. */
  totalCalls: number;
  /** Total successful calls. */
  totalSuccesses: number;
  /** Total failed calls. */
  totalFailures: number;
  /** Overall success rate (0–1). */
  overallSuccessRate: number;
  /** Overall average latency in milliseconds. */
  avgLatencyMs: number;
  /** How many distinct tools were called. */
  uniqueToolsUsed: number;
  /** How many tools had their circuit breaker open. */
  circuitBreakerTrips: number;
  /** Per-tool statistics, sorted by call count descending. */
  perTool: ToolCallStats[];
}

// ─── Eval Cases & Results ─────────────────────────────────────────────────

/**
 * A single evaluation test case.
 */
export interface EvalCase {
  /** Human-readable name for this test case. */
  name: string;
  /** The user input / prompt to send to the agent. */
  input: string;
  /**
   * Tools that SHOULD be called during execution.
   * The test passes if ALL expected tools are called at least once.
   * Leave empty to skip this check.
   */
  expectedTools?: string[];
  /**
   * Tools that should NOT be called during execution.
   * The test fails if ANY forbidden tool is called.
   */
  forbiddenTools?: string[];
  /**
   * Pattern that the final answer should match (string substring or RegExp).
   * The test passes if the answer contains this pattern.
   * Leave undefined to skip output validation.
   */
  expectedOutput?: string | RegExp;
  /**
   * Maximum iterations for this case (overrides agent default).
   */
  maxIterations?: number;
  /**
   * Timeout in milliseconds (default: 120_000).
   */
  timeoutMs?: number;
}

/**
 * LLM-based quality judgment of an agent's final answer.
 */
export interface LLMEvalJudgment {
  /** Whether the LLM judge considers the answer satisfactory. */
  passed: boolean;
  /** 0–100 quality score. */
  score: number;
  /** Brief explanation of the judgment. */
  reasoning: string;
  /** Specific issues identified (empty if none). */
  issues: string[];
}

/**
 * Result of running a single evaluation case.
 */
export interface EvalResult {
  /** The case name (from EvalCase). */
  caseName: string;
  /** Whether the case passed all checks. */
  passed: boolean;
  /** The agent's final answer. */
  answer: string;
  /** Tool names called during execution (in order). */
  toolCalls: string[];
  /** Number of ReAct/PlanSolve iterations consumed. */
  iterations: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Tool call scorecard for this run. */
  scorecard: ToolCallScorecard;
  /** Optional LLM-based quality judgment. */
  llmJudgment?: LLMEvalJudgment;
  /** Failure reasons (empty if passed). */
  failures: string[];
}

// ─── Benchmark ────────────────────────────────────────────────────────────

/**
 * A regression — something that got worse compared to the baseline.
 */
export interface Regression {
  /** What regressed (tool name, metric name, or case name). */
  target: string;
  /** The metric that changed. */
  metric: string;
  /** Baseline value. */
  baseline: number | string;
  /** Current value. */
  current: number | string;
  /** Human-readable description. */
  description: string;
}

/**
 * An improvement — something that got better compared to the baseline.
 */
export interface Improvement {
  /** What improved. */
  target: string;
  /** The metric that changed. */
  metric: string;
  /** Baseline value. */
  baseline: number | string;
  /** Current value. */
  current: number | string;
}

/**
 * Summary of a benchmark run.
 */
export interface BenchmarkSummary {
  /** Benchmark name. */
  name: string;
  /** ISO-8601 timestamp of the run. */
  timestamp: string;
  /** Number of cases that passed. */
  passed: number;
  /** Total number of cases. */
  total: number;
  /** Pass rate (0–1). */
  passRate: number;
  /** Average tool calls per case. */
  avgToolCallsPerCase: number;
  /** Average latency per case in milliseconds. */
  avgLatencyMs: number;
  /** Regressions vs baseline (empty if no baseline). */
  regressions: Regression[];
  /** Improvements vs baseline (empty if no baseline). */
  improvements: Improvement[];
}

/**
 * Full benchmark result including per-case details.
 */
export interface BenchmarkResult {
  /** Summary stats. */
  summary: BenchmarkSummary;
  /** Per-case results. */
  cases: EvalResult[];
}
