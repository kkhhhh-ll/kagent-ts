// Core Agent
export { Agent } from "./core/agent";
export type { AgentConfig } from "./core/agent";
export { ReActAgent } from "./core/react-agent";
export type { ReActAgentConfig } from "./core/react-agent";
export { PlanSolveAgent } from "./core/plan-solve-agent";
export type { PlanSolveAgentConfig } from "./core/plan-solve-agent";
export type { Tool } from "./core/types";
export type { AgentHooks } from "./core/hooks";

// Response schema — structured JSON output from LLM
export {
  parseReActResponse,
  STRUCTURED_OUTPUT_INSTRUCTIONS,
  parsePlanSolveResponse,
  PLAN_SOLVE_INSTRUCTIONS,
} from "./core/response-schema";
export type {
  ReActResponse,
  ReActReasoning,
  ReActFinalAnswer,
  PlanSolveResponse,
} from "./core/response-schema";

// Tools — circuit breaker & registry
export { ToolRegistry } from "./tools/tool-registry";
export { CircuitBreaker } from "./tools/circuit-breaker";
export type { CircuitBreakerConfig } from "./tools/circuit-breaker";
export { BreakerState } from "./tools/types";
export type { BreakerStatus } from "./tools/types";

// Tool error tracker — observability for tool failure chains
export { ToolErrorTracker, categorizeError } from "./tools/error-tracker";
export type { ErrorTrackerConfig } from "./tools/error-tracker";
export type { ToolErrorTrace, TraceEvent, ErrorTraceSummary } from "./tools/types";

// Built-in file tools
export {
  BUILTIN_TOOLS,
  registerAllBuiltinTools,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GrepSearchTool,
  GlobSearchTool,
} from "./tools/builtin/index";

// Skills — progressive disclosure
export { SkillManager, FileSkillLoader, parseFrontmatter, parseKeywords } from "./skills/index";
export type { Skill, SkillStatus } from "./skills/types";

// Messages
export { Message } from "./messages/message";
export { Role } from "./messages/types";
export type { MessageData, ToolCall } from "./messages/types";

// LLM
export type { LLMProvider, LLMResponse } from "./llm/interface";
export { OpenAIProvider, LLMNetworkError, isNetworkError } from "./llm/openai-provider";
export type { OpenAIConfig, OpenAIRetryConfig, NetworkErrorCause } from "./llm/openai-provider";


// Context
export { ContextManager } from "./context/context-manager";
export type { ContextConfig, ContextState } from "./context/types";

// Compression
export type { CompressionStrategy, CompressionResult } from "./compression/interface";
export { SlidingWindowCompression } from "./compression/sliding-window";
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
} from "./session/session-types";

// Utils
export { countTokens, countMessageTokens } from "./utils/token-counter";

// Trace — session execution trace logger
export { TraceLogger } from "./trace/trace-logger";
export type { TraceLoggerConfig } from "./trace/trace-logger";
export type { AgentTraceEvent, AgentTraceEventType } from "./trace/types";

// MCP (Model Context Protocol) — dynamic tool discovery
export { McpClientManager } from "./mcp/mcp-client-manager";
export { McpConnectionError } from "./mcp/mcp-types";
export type {
  McpServerConfig,
  McpConnectionStatus,
  McpConnectionErrorReport,
} from "./mcp/mcp-types";
