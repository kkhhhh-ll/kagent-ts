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
  VerifyAgent,
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
  ReflectionAgent, ErrorNotebook, MemoryReflector,
  // Preferences & Rules
  PreferenceManager, ProjectRules,
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

| 模块 | 说明 | 文档 |
|------|------|------|
| **Agent 类** | ReAct / Plan-Solve / Fusion / Orchestrator / Fork | [API - Agent](/api/agent) |
| **LLM Provider** | OpenAI / Anthropic / Fallback / RateLimiter / Router / TokenBudget | [API - LLM](/api/llm) |
| **Tool 系统** | Registry / CircuitBreaker / Validator / Filters / ErrorTracker | [API - Tools](/api/tools) |
| **Message 类型** | Message / Role / ToolCall / MessageData | [API - Messages](/api/messages) |
| **Session** | SessionManager / SessionState / Checkpoint | [API - Session](/api/session) |
| **Context & Compression** | ContextManager / ProgressiveCompressor | [API - Context](/api/context) |
| **Intent** | detectSignals / matchSkills — 意图识别 | [指南 - Intent](/advanced/intent) |
| **Skills** | SkillManager / FileSkillLoader / parseFrontmatter | [指南 - Skills](/advanced/skills) |
| **Precipitation** | PrecipitateAgent — 技能自动沉淀（含关键词） | [指南 - Precipitation](/advanced/precipitation) |
| **Verification** | VerifyAgent — 答案验证（阻塞式） | [指南 - Verification](/advanced/verification) |
| **SubAgent** | SubAgentManager / SubAgentLoader | [指南 - SubAgent](/advanced/subagents) |
| **MCP** | McpClientManager / McpServerConfig | [指南 - MCP](/advanced/mcp) |
| **RAG** | RAGManager / EmbeddingProvider / VectorStore / ReRanker | [指南 - RAG](/advanced/rag) |
| **Memory** | MemoryManager / Memory | [指南 - Memory](/advanced/memory) |
| **Reflection** | ReflectionAgent / ErrorNotebook / MemoryReflector | [指南 - Reflection](/advanced/reflection) |
| **Preferences** | PreferenceManager — 用户偏好注入 | [指南 - Preferences](/advanced/preferences) |
| **Rules** | ProjectRules — 项目规则注入 | [指南 - Rules](/advanced/rules) |
| **Git** | GitWorktreeManager — Worktree 隔离执行 | [指南 - Git](/advanced/git) |
| **Security** | 边界标记 / 注入签名扫描 | [指南 - Security](/advanced/security) |
| **Eval** | ToolCallEvaluator / Benchmark | [指南 - Eval](/advanced/eval) |
| **Trace** | TraceLogger — 全链路追踪 | [指南 - Trace](/advanced/trace) |
| **Logging** | Logger / ConsoleLogger / SilentLogger | [指南 - Logging](/advanced/logging) |

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

// 验证
type VerificationResult / VerificationInput
type VerifyAgentConfig

// 反思 & 记忆 & 沉淀
type ReflectionAgentConfig / ReflectionInput / ReflectionFinding
type ErrorNotebookEntry / ErrorNotebookConfig / ReflectionErrorCategory
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
type Preferences / PreferenceManagerConfig
```

## 下一步

- [API - Agent](/api/agent) — Agent 类的完整 API
- [API - LLM](/api/llm) — LLM Provider 的完整 API
- [API - Tools](/api/tools) — Tool 系统的完整 API
