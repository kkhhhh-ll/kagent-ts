// Tool Call Evaluator — per-tool metrics via AgentHooks
export { ToolCallEvaluator } from "./tool-call-evaluator";

// Eval Runner — end-to-end test case execution
export { EvalRunner, summarizeEvalResults } from "./eval-runner";
export type { EvalRunnerConfig, AgentFactory, EvalResultsSummary } from "./eval-runner";
// Re-export shared types from types.ts (single source of truth)
export type { EvalCase, EvalResult, LLMEvalJudgment } from "./types";

// Benchmark — regression testing & baseline comparison
export { Benchmark } from "./benchmark";
export type { BenchmarkConfig } from "./benchmark";

// RAG Evaluator — retrieval quality metrics (IR + LLM-as-judge)
export { RAGEvaluator } from "./rag-evaluator";
export type {
  RAGEvalCase,
  ChunkJudgment,
  RAGRetrievalMetrics,
  RAGCaseResult,
  RAGEvalSummary,
  RAGEvalResult,
  RAGEvaluatorConfig,
  SyntheticCaseGenConfig,
} from "./rag-evaluator";

// Shared types
export type {
  ToolCallRecord,
  ToolCallStats,
  ToolCallScorecard,
  Regression,
  Improvement,
  BenchmarkSummary,
  BenchmarkResult,
} from "./types";
