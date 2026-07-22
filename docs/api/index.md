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
  // Tools
  ToolRegistry, CircuitBreaker, BUILTIN_TOOLS, BUILTIN_TOOL_NAMES,
  toolSuccess, toolError, validateToolArgs,
  ToolOutputTruncator, ToolErrorTracker, categorizeError,
  allowlist, denylist, pattern, all, any, filterTools,
  // Messages
  Message, Role,
  // Context & Compression
  ContextManager, ProgressiveCompressor,
  // Session
  SessionManager,
  // Skills
  SkillManager, FileSkillLoader, parseFrontmatter,
  // Precipitation
  PrecipitateAgent,
  // Intent
  detectSignals, planHasRiskyOps, matchSkills, buildMatchedSkillsPrompt,
  // Verification
  ,
  // MCP
  McpClientManager, McpConnectionError,
  // RAG
  RAGManager, OpenAIEmbeddingProvider, InMemoryVectorStore, ChromaVectorStore,
  InMemoryKeywordIndex, Retriever, LLMReRanker, CrossEncoderReRanker, rrfFusion, chunkKey,
  // SubAgent
  SubAgentManager, SubAgentLoader,
  // Memory
  MemoryManager,
  // Reflection
  , 
  // Preferences & Rules

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
} from 'kagent-ts'
```

## 模块导航

|------|------|------|

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
type ToolErrorTrace / TraceEvent / ErrorTraceSummary
type BreakerState / BreakerStatus / CircuitBreakerConfig

// 意图识别
type UserSignals / SkillMatch

type VerificationResult / VerificationInput
type Config

// 反思 & 记忆 & 沉淀
type Config / ReflectionInput / ReflectionFinding
type 
type MemoryReflectorConfig / MemoryReflectionInput / ExtractedMemory
type Memory / MemoryType
type PrecipitateAgentConfig / PrecipitationInput / SkillCandidate

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
type Preferences / 
```

## 下一步

- [API - Agent](/api/agent) — Agent 类的完整 API
- [API - LLM](/api/llm) — LLM Provider 的完整 API
- [API - Tools](/api/tools) — Tool 系统的完整 API
