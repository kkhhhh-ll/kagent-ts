# API 参考总览

kagent-ts 通过单一的入口文件导出所有公共 API。

## 导入方式

```ts
// 从主入口导入所有内容
import {
  // Agent
  ReActAgent, PlanSolveAgent, FusionAgent, OrchestratorAgent, Agent, forkAgent,
  // LLM
  OpenAIProvider, AnthropicProvider, FallbackProvider, RateLimitedProvider,
  ModelRouter, createLLMProvider, TokenBudget, LLMNetworkError,
  isNetworkError, LLMResponseErrorCode,
  // Tools
  ToolRegistry, CircuitBreaker, BUILTIN_TOOLS, BUILTIN_TOOL_NAMES,
  toolSuccess, toolError, validateToolArgs,
  ToolOutputTruncator,
  allowlist, denylist, pattern, all, any, filterTools,
  // Messages
  Message, Role,
  // Context & Compression
  ContextManager, ProgressiveCompressor,
  // Session
  SessionManager, SessionViewer,
  // Skills
  SkillManager, FileSkillLoader, parseFrontmatter,
  // Intent
  detectSignals, planHasRiskyOps, matchSkills, buildMatchedSkillsPrompt,
  // MCP
  McpClientManager, McpConnectionError,
  // RAG
  RAGManager, OpenAIEmbeddingProvider, InMemoryVectorStore, ChromaVectorStore,
  InMemoryKeywordIndex, Retriever, LLMReRanker, CrossEncoderReRanker, rrfFusion, chunkKey,
  // SubAgent
  SubAgentManager, SubAgentLoader,
  // Memory
  MemoryManager,
  // Git
  GitWorktreeManager, GitWorktreeError,
  // Security
  wrapUntrusted, detectInjectionSignatures, buildInjectionWarning,
  wrapUserAuthored, buildUserContentInjectionWarning, wrapAndScan,
  // Eval
  ToolCallEvaluator, Benchmark,
  // Trace
  TraceLogger,
  // Utils
  countTokens, countMessageTokens,
  // Logging
  Logger, ConsoleLogger, SilentLogger,
  // Response Schema
  parseReActResponse, parsePlanSolveResponse, parseFusionRouteResponse,
  parseFusionResponse, STRUCTURED_OUTPUT_INSTRUCTIONS, PLAN_SOLVE_INSTRUCTIONS,
  FUSION_ROUTE_INSTRUCTIONS, FUSION_EXECUTION_INSTRUCTIONS, INLINE_REFLECTION_PROMPT,
  // Orchestrator Response
  parseDecomposeResponse, parseSynthesizeResponse, parseAdaptResponse,
  // Built-in Tools
  registerAllBuiltinTools, ReadFileTool, WriteFileTool, EditFileTool,
  GrepSearchTool, GlobSearchTool, createSpawnSubagentTool, createSkillTool,
  createRememberTool, createRecallTool,
  // Reflection
  MemoryReflector,
  // Rules
  ProjectRules,
  // Tools
  BreakerState, ToolErrorCode,
} from 'kagent-ts'
```

## 模块导航

| 模块 | 说明 | 链接 |
|------|------|------|
| Agent | ReAct / Plan-Solve / Fusion / Orchestrator | [API - Agent](/api/agent) |
| LLM | OpenAI / Anthropic / Fallback / Rate Limiter / Model Router | [API - LLM](/api/llm) |
| Tools | ToolRegistry / CircuitBreaker / Validation / Filters | [API - Tools](/api/tools) |
| Messages | Message / Role / ToolCall 类型 | [API - Messages](/api/messages) |
| Session | SessionManager / Checkpoint 持久化 | [API - Session](/api/session) |
| Context | ContextManager / ProgressiveCompressor | [API - Context](/api/context) |

## 主要类型一览

```ts
// Agent 配置
type AgentConfig
type ReActAgentConfig
type PlanSolveAgentConfig
type FusionAgentConfig
type OrchestratorAgentConfig
type ForkOptions

// Agent 钩子 & 回调
type AgentHooks
type ApprovalCallback
type PlanConfirmCallback

// LLM Provider
type LLMProvider
type LLMResponse
type LLMStreamEvent
type OpenAIConfig / OpenAIRetryConfig
type AnthropicConfig
type ModelRouterConfig / ModelRoute
type TokenBudgetConfig / TokenBudgetStatus / TokenBudgetCost
type FallbackProviderConfig / RateLimitedProviderConfig
type LLMProviderConfig / ProviderType
type RetryConfig / NetworkErrorCause

// RAG
type RAGConfig / RAGDocument / RAGChunk
type EmbeddingProvider / VectorStore
type OpenAIEmbeddingConfig / ChromaVectorStoreConfig
type RAGSearchResult / BM25Result / RetrievedSkill / RetrievedMemory / RankedResult / RRFFusionResult
type ReRanker / LLMReRankerConfig / CrossEncoderReRankerConfig

// 工具系统
type Tool / ToolResult / ToolErrorCode
type ToolFilter
type BreakerState / BreakerStatus / CircuitBreakerConfig

// 意图识别
type UserSignals / SkillMatch

// 反思 & 记忆
type MemoryReflectorConfig / MemoryReflectionInput / ExtractedMemory
type Memory / MemoryType

// 会话
type SessionState / SessionStatus / AgentType
type PlanSolveSessionState / FusionSessionState / OrchestratorSessionState

// 上下文
type ContextConfig / ContextState
type CompressionStrategy / CompressionResult / CompressionConfig

// 安全
// wrapUntrusted / detectInjectionSignatures / buildInjectionWarning
// wrapUserAuthored / buildUserContentInjectionWarning / wrapAndScan

// Git Worktree
type GitWorktreeConfig / GitWorktreeErrorCode
type WorktreeInfo / WorktreeStatus

// 子 Agent & MCP
type SubAgentDefinition / SubAgentResult
type McpServerConfig / McpConnectionStatus / McpConnectionErrorReport

// Eval & Trace
type ToolCallRecord / ToolCallStats / ToolCallScorecard
type EvalCase / EvalResult
type Regression / Improvement / BenchmarkSummary / BenchmarkResult
type TraceLoggerConfig / AgentTraceEvent / AgentTraceEventType

// 偏好 & 规则
type Preferences / Rule

```
```

## 下一步

- [API - Agent](/api/agent) — Agent 类的完整 API
- [API - LLM](/api/llm) — LLM Provider 的完整 API
- [API - Tools](/api/tools) — Tool 系统的完整 API
