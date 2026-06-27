# API 参考总览

kagent-ts 通过单一的入口文件导出所有公共 API。

## 导入方式

```ts
// 从主入口导入所有内容
import {
  // Agent
  ReActAgent, PlanSolveAgent, FusionAgent, OrchestratorAgent, Agent,
  // LLM
  OpenAIProvider, AnthropicProvider, FallbackProvider, RateLimitedProvider,
  ModelRouter, createLLMProvider, TokenBudget,
  // Tools
  ToolRegistry, CircuitBreaker, BUILTIN_TOOLS, BUILTIN_TOOL_NAMES,
  // Messages
  Message, Role,
  // Session
  SessionManager,
  // Skills
  SkillManager, FileSkillLoader,
  // MCP
  McpClientManager,
  // RAG
  RAGManager, OpenAIEmbeddingProvider, InMemoryVectorStore,
  // SubAgent
  SubAgentManager, SubAgentLoader,
  // Memory
  MemoryManager,
  // Reflection
  ReflectionAgent, ErrorNotebook, createReflectionHook,
  // Security
  wrapUntrusted, detectInjectionSignatures, buildInjectionWarning,
  // Eval
  ToolCallEvaluator, EvalRunner, Benchmark,
  // Utils
  countTokens, countMessageTokens,
  // Logging
  Logger, ConsoleLogger, SilentLogger,
} from 'kagent-ts'
```

## 模块导航

| 模块 | 说明 | 文档 |
|------|------|------|
| **Agent 类** | ReAct / Plan-Solve / Fusion / Orchestrator | [API - Agent](/api/agent) |
| **LLM Provider** | OpenAI / Anthropic / Fallback / RateLimiter / Router | [API - LLM](/api/llm) |
| **Tool 系统** | Registry / CircuitBreaker / Validator / Filters | [API - Tools](/api/tools) |
| **Message 类型** | Message / Role / ToolCall | [API - Messages](/api/messages) |
| **Session** | SessionManager / SessionState | [API - Session](/api/session) |
| **Context & Compression** | ContextManager / ProgressiveCompressor | [API - Context](/api/context) |
| **Skills** | SkillManager / FileSkillLoader / Skill | [指南 - Skills](/advanced/skills) |
| **SubAgent** | SubAgentManager / SubAgentLoader | [指南 - SubAgent](/advanced/subagents) |
| **MCP** | McpClientManager / McpServerConfig | [指南 - MCP](/advanced/mcp) |
| **RAG** | RAGManager / OpenAIEmbeddingProvider / InMemoryVectorStore | [指南 - RAG](/advanced/rag) |
| **Memory** | MemoryManager / Memory | [指南 - Memory](/advanced/memory) |
| **Reflection** | ReflectionAgent / ErrorNotebook | [指南 - Reflection](/advanced/reflection) |
| **Security** | wrapUntrusted / detectInjectionSignatures | [指南 - Security](/advanced/security) |
| **Eval** | ToolCallEvaluator / EvalRunner / Benchmark | [指南 - Eval](/advanced/eval) |
| **Trace** | TraceLogger | [指南 - Trace](/advanced/trace) |

## 主要类型一览

```ts
// Agent 配置
type AgentConfig
type ReActAgentConfig
type PlanSolveAgentConfig
type FusionAgentConfig
type OrchestratorAgentConfig

// LLM Provider
type LLMProvider
type LLMResponse
type OpenAIConfig
type AnthropicConfig
type ModelRouterConfig
type TokenBudgetConfig

// RAG
type RAGConfig
type RAGDocument
type RAGChunk
type EmbeddingProvider
type VectorStore
type RAGSearchResult

// 工具系统
type Tool
type ToolResult
type ToolFilter
type ToolErrorTrace
```

## 下一步

- [API - Agent](/api/agent) — Agent 类的完整 API
- [API - LLM](/api/llm) — LLM Provider 的完整 API
- [API - Tools](/api/tools) — Tool 系统的完整 API
