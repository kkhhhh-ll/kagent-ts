// Core Agent
export { Agent } from "./core/agent";
export type { AgentConfig, ApprovalCallback } from "./core/agent";
export { ReActAgent } from "./core/react-agent";
export type { ReActAgentConfig } from "./core/react-agent";
export { PlanSolveAgent } from "./core/plan-solve-agent";
export type { PlanSolveAgentConfig } from "./core/plan-solve-agent";
export { FusionAgent } from "./core/fusion-agent";
export type { FusionAgentConfig, PlanConfirmCallback } from "./core/fusion-agent";
export { OrchestratorAgent } from "./orchestrator/orchestrator-agent";
export type { OrchestratorAgentConfig } from "./orchestrator/orchestrator-agent";
export type { Tool } from "./core/types";
export type { AgentHooks } from "./core/hooks";

// Response schema — structured JSON output from LLM
export {
  parseReActResponse,
  STRUCTURED_OUTPUT_INSTRUCTIONS,
  parsePlanSolveResponse,
  PLAN_SOLVE_INSTRUCTIONS,
  parseFusionRouteResponse,
  parseFusionResponse,
  FUSION_ROUTE_INSTRUCTIONS,
  FUSION_EXECUTION_INSTRUCTIONS,
  INLINE_REFLECTION_PROMPT,
} from "./core/response-schema";
export type {
  ReActResponse,
  ReActReasoning,
  ReActFinalAnswer,
  PlanSolveResponse,
  FusionRouteResponse,
  FusionResponse,
} from "./core/response-schema";

// Orchestrator — structured decomposition, dispatch, synthesis, adapt
export {
  parseDecomposeResponse,
  parseSynthesizeResponse,
  parseAdaptResponse,
  buildDecomposePrompt,
  buildSynthesizePrompt,
  buildAdaptPrompt,
} from "./orchestrator/orchestrator-response";
export type {
  TaskNode,
  TaskNodeStatus,
  TaskGraph,
  OrchestrationPlan,
  SynthesisResult,
  AdaptResult,
  OrchestratorSessionState,
} from "./orchestrator/orchestrator-types";

// Tools — circuit breaker & registry
export { ToolRegistry } from "./tools/tool-registry";
export { CircuitBreaker } from "./tools/circuit-breaker";
export type { CircuitBreakerConfig } from "./tools/circuit-breaker";
export { BreakerState, ToolErrorCode } from "./tools/types";
export type { BreakerStatus, ToolResult } from "./tools/types";
export { toolSuccess, toolError } from "./tools/types";
export { validateToolArgs } from "./tools/tool-validator";

// Tool output truncator — large output to disk
export { ToolOutputTruncator } from "./tools/tool-output-truncator";

// Tool filter — restrict which tools sub-agents can use
export type { ToolFilter } from "./tools/tool-filter";
export {
  allowlist,
  denylist,
  pattern,
  all,
  any,
  filterTools,
} from "./tools/tool-filter";

// Tool error tracker — in-memory tracking for tool failure chains
export { ToolErrorTracker, categorizeError } from "./tools/error-tracker";
export type {
  ToolErrorTrace,
  TraceEvent,
  ErrorTraceSummary,
} from "./tools/types";

// Built-in file tools
export {
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  registerAllBuiltinTools,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GrepSearchTool,
  GlobSearchTool,
  createListSubagentsTool,
  createSpawnSubagentTool,
  createListErrorsTool,
  createSkillTool,
  createRememberTool,
  createRecallTool,
} from "./tools/builtin/index";

// Skills — progressive disclosure
export {
  SkillManager,
  FileSkillLoader,
  parseFrontmatter,
} from "./skills/index";
export type { Skill, SkillStatus } from "./skills/types";

// Messages
export { Message } from "./messages/message";
export { Role } from "./messages/types";
export type { MessageData, ToolCall } from "./messages/types";

// LLM — shared types
export type { LLMProvider, LLMResponse } from "./llm/interface";
export { LLMResponseErrorCode } from "./llm/interface";
export { TokenBudget } from "./llm/token-budget";
export type { TokenBudgetConfig, TokenBudgetStatus, TokenBudgetCost } from "./llm/token-budget";
export { LLMNetworkError } from "./llm/errors";
export type { NetworkErrorCause, RetryConfig } from "./llm/errors";

// LLM — OpenAI provider
export { OpenAIProvider, isNetworkError } from "./llm/openai-provider";
export type { OpenAIConfig, OpenAIRetryConfig } from "./llm/openai-provider";

// LLM — Anthropic provider
export { AnthropicProvider } from "./llm/anthropic-provider";
export type { AnthropicConfig } from "./llm/anthropic-provider";

// LLM — Factory
export { createLLMProvider } from "./llm/factory";
export type { LLMProviderConfig, ProviderType } from "./llm/factory";

// LLM — Fallback & Rate Limiting
export { FallbackProvider } from "./llm/fallback-provider";
export type { FallbackProviderConfig } from "./llm/fallback-provider";
export { RateLimitedProvider } from "./llm/rate-limiter";
export type { RateLimitedProviderConfig } from "./llm/rate-limiter";

// LLM — Model Router
export { ModelRouter } from "./llm/model-router";
export type { ModelRouterConfig, ModelRoute } from "./llm/model-router";

// Context
export { ContextManager } from "./context/context-manager";
export type { ContextConfig, ContextState } from "./context/types";

// Compression — progressive 4-step
export { ProgressiveCompressor } from "./compression/progressive-compressor";
export type {
  CompressionStrategy,
  CompressionResult,
} from "./compression/interface";
export type { CompressionConfig } from "./compression/types";

// User preferences
export { PreferenceManager } from "./preferences/preference-manager";
export type { Preferences, PreferenceManagerConfig } from "./preferences/types";

// Session persistence & network resilience
export { SessionManager } from "./session/session-manager";
export type { SessionManagerConfig } from "./session/session-manager";
export type {
  SessionState,
  SessionStatus,
  AgentType,
  PlanSolveSessionState,
  FusionSessionState,
} from "./session/session-types";

// Utils
export { countTokens, countMessageTokens } from "./utils/token-counter";

// Trace — session execution trace logger
export { TraceLogger } from "./trace/trace-logger";
export type { TraceLoggerConfig } from "./trace/trace-logger";
export type { AgentTraceEvent, AgentTraceEventType } from "./trace/types";

// Sub-agents — async multi-agent dispatch
export { SubAgentManager, SubAgentLoader } from "./subagent/index";
export type { SubAgentDefinition, SubAgentResult } from "./subagent/index";

// RAG — retrieval-augmented generation
export { RAGManager, OpenAIEmbeddingProvider, InMemoryVectorStore } from "./rag/index";
export type {
  EmbeddingProvider,
  VectorStore,
  RAGDocument,
  RAGChunk,
  RAGSearchResult,
  RAGConfig,
  OpenAIEmbeddingConfig,
} from "./rag/index";

// MCP (Model Context Protocol) — dynamic tool discovery
export { McpClientManager } from "./mcp/mcp-client-manager";
export { McpConnectionError } from "./mcp/mcp-types";
export type {
  McpServerConfig,
  McpConnectionStatus,
  McpConnectionErrorReport,
} from "./mcp/mcp-types";

// Project rules — user-authored, injected into system prompt
export { ProjectRules } from "./rules/project-rules";

// Security — prompt-injection defence helpers
export {
  wrapUntrusted,
  detectInjectionSignatures,
  buildInjectionWarning,
  wrapUserAuthored,
  buildUserContentInjectionWarning,
  wrapAndScan,
} from "./security/index";

// Logging — structured logger interface
export { Logger, ConsoleLogger, SilentLogger } from "./logging/index";

// Memory — long-term facts, rules, and project context
export { MemoryManager } from "./memory/index";
export type { Memory, MemoryType } from "./memory/index";

// Reflection — post-execution self-reflection with error notebook (错题本)
export { ErrorNotebook } from "./reflection/error-notebook";
export type {
  ErrorNotebookEntry,
  ErrorNotebookConfig,
  ReflectionErrorCategory,
} from "./reflection/error-notebook";
export { ReflectionAgent } from "./reflection/reflection-agent";
export type {
  ReflectionAgentConfig,
  ReflectionInput,
  ReflectionFinding,
} from "./reflection/reflection-agent";
export { MemoryReflector } from "./reflection/memory-reflector";
export type {
  MemoryReflectorConfig,
  MemoryReflectionInput,
  ExtractedMemory,
} from "./reflection/memory-reflector";
export { createReflectionHook } from "./reflection/reflection-hook";
export type { ReflectionHookConfig } from "./reflection/reflection-hook";

// Evaluation — tool call metrics, end-to-end testing, regression benchmarks
export { ToolCallEvaluator, EvalRunner, Benchmark } from "./eval";
export type {
  ToolCallRecord,
  ToolCallStats,
  ToolCallScorecard,
  EvalCase,
  EvalResult,
  LLMEvalJudgment,
  EvalRunnerConfig,
  AgentFactory,
  BenchmarkConfig,
  Regression,
  Improvement,
  BenchmarkSummary,
  BenchmarkResult,
} from "./eval";
