// Tool Call Evaluator — per-tool metrics via AgentHooks
export { ToolCallEvaluator } from "./tool-call-evaluator";

// Benchmark — regression testing & baseline comparison
export { Benchmark } from "./benchmark";
export type { BenchmarkConfig } from "./benchmark";

// Shared types
export type {
  ToolCallRecord,
  ToolCallStats,
  ToolCallScorecard,
  EvalCase,
  EvalResult,
  Regression,
  Improvement,
  BenchmarkSummary,
  BenchmarkResult,
} from "./types";

// EvalRunner types (used by BenchmarkConfig)
export type { AgentFactory } from "./eval-runner";
