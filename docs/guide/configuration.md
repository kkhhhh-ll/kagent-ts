# 配置

## Agent 通用配置

所有 Agent 类型共享一套基础配置，通过构造函数传入：

```ts
interface AgentConfig {
  // ── 核心 ──
  llm: LLMProvider                                  // LLM Provider 实例（必填）
  systemPrompt?: string                             // 系统提示词
  name?: string                                     // Agent 名称

  // ── 工具 ──
  tools?: Tool[]                                    // 工具列表
  toolRetryCount?: number                           // 工具失败重试次数

  // ── 上下文 ──
  contextManager?: ContextManager                   // 上下文管理器实例

  // ── 日志 ──
  logger?: Logger                                   // 日志实例

  // ── 生命周期钩子 ──
  hooks?: AgentHooks 
  // ── 人工审批 (HITL) ──
  onToolApproval?: (toolName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>

  // ── 并行执行 ──
  enableParallelToolExecution?: boolean             // 启用并行工具调用

  // ── Session ID (用于会话持久化) ──
  sessionId?: string

  // ── MCP Server 配置文件路径 (推荐) ──
  mcpConfigPath?: string

  // ── MCP Server 内联配置 (会覆盖文件中的同名 server) ──
  mcpServers?: Record<string, McpServerConfig>

  // ── RAG 知识检索配置 ──
  rag?: RAGConfig

  // ── 子代理定义目录 ──
  subAgentsDir?: string

  // ── 子代理生命周期钩子（支持静态/数组/工厂函数）──
  subAgentHooks?: AgentHooks 
  // ── 最大并行子 Agent 数 (默认: 3，超过的排队) ──
  maxPending?: number

  // ── 子代理等待队列上限 (默认: 20，满时拒绝新 spawn) ──
  maxQueueSize?: number

  // ── fast-result 等待时间 (默认: 30_000 ms，设为 0 禁用) ──
  subAgentFastTimeoutMs?: number

  // ── 子 Agent 专用 LLM Provider（默认复用 llm）──
  subAgentLLM?: LLMProvider

  // ── 记忆提取专用 LLM Provider（默认复用 llm）──
  memoryReflectorLLM?: LLMProvider

  // ── Skill 沉淀专用 LLM Provider（默认复用 llm）──
  precipitationLLM?: LLMProvider

  // ── Skill 沉淀模式 (默认: "off") ──
  precipitation?: "off" 
  // ── 记忆提取模式 (默认: "off") ──
  memoryReflection?: "off" 

  // ── 记忆存储目录 (默认: ".k-memory") ──
  memoryDir?: string

  // ── Token 预算配置 ──
  tokenBudgetConfig?: TokenBudgetConfig
}
```

### 子系统的 LLM 分配

Reflection、Memory、Precipitation、Verification 四个子系统都可以使用独立模型，不配时默认复用主模型 `llm`：

推荐使用 `ModelRouter` 集中管理所有模型路由，详见 [Model Router](/llm/model-router)。

## LLM Provider 配置

> **推荐**：使用 `ModelRouter` 为不同任务分配不同模型（主循环 / 子代理 / 反思 / 记忆提取 / 沉淀），详见 [Model Router](/llm/model-router)。

### OpenAI

```ts
import { OpenAIProvider } from 'kagent-ts'

const provider = new OpenAIProvider({
  apiKey: 'sk-...',
  model: 'gpt-4o',           // 必填
  baseURL: 'https://api.openai.com/v1',
  timeout: 60000,            // 请求超时 (ms)
  temperature: 0.7,
  maxTokens: 4096,
  retry: {                   // 重试配置（可选）
    maxRetries: 3,
    initialBackoffMs: 1000,
    maxBackoffMs: 30000,
    backoffMultiplier: 2,
  },
})
```

### Anthropic

```ts
import { AnthropicProvider } from 'kagent-ts'

const provider = new AnthropicProvider({
  apiKey: 'sk-ant-...',
  model: 'claude-sonnet-4-6', // 必填
  timeout: 60000,
  cacheSystemPrompt: true,    // 启用 Prompt Caching
  maxTokens: 4096,
  retry: {                    // 重试配置（可选）
    maxRetries: 3,
  },
})
```

### 自动检测 Provider

```ts
import { createLLMProvider } from 'kagent-ts'

// 根据 baseURL 自动检测 Provider 类型
const provider = createLLMProvider({
  apiKey: '...',
  model: 'claude-sonnet-4-6',
  baseURL: 'https://api.anthropic.com/v1',  // URL 含 "anthropic" → AnthropicProvider
})
```

## 上下文管理配置

```ts
import { ContextManager } from 'kagent-ts'

const contextManager = new ContextManager({
  maxTokens: 128000,             // 上下文窗口最大 Token 数
  compressionThreshold: 0.8,     // 80% 阈值触发压缩
  keepTurns: 20,                 // 保留最近 N 轮对话
  toolResultMaxAgeMs: 3600000,   // 工具结果最大保留时间 (60分钟)
})

const agent = new ReActAgent({
  // ...
  contextManager: contextManager,
})
```

## RAG 知识库配置

启用 RAG 后，Agent 启动时会自动索引 `documentsDir` 目录下的文档，并注册 `search_knowledge` 和 `list_knowledge_documents` 两个工具。

```ts
import { OpenAIEmbeddingProvider } from 'kagent-ts'

const agent = new ReActAgent({
  // ... 其他配置
  rag: {
    /** 文档目录路径 — 递归扫描 .md / .txt / .json 文件 */
    documentsDir: './docs',

    /** 向量化 Provider — 内置 OpenAI，也支持自定义实现 */
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',  // 默认，也可用 text-embedding-3-large
    }),

    /** 检索时返回的 top-K 数量（默认: 5） */
    topK: 5,

    /** chunk 最大字符数（默认: 1000） */
    chunkSize: 1000,

    /** 相邻 chunk 重叠字符数（默认: 200） */
    chunkOverlap: 200,

    /** 自定义向量存储 — Chroma / Milvus / Pinecone 等（默认: InMemoryVectorStore） */
    store: new ChromaVectorStore({ url: 'http://localhost:8000' }),

    /** 启用混合检索 — BM25 + 向量 + RRF 融合（默认: false） */
    hybridSearch: true,

    /** 混合检索时每路取 topK × factor 条候选（默认: 3） */
    hybridRetrievalFactor: 3,

    /** Re-rank 精排器 — 默认 CrossEncoderReRanker（本地 ONNX）。
     *  传 null 禁用，或传 LLMReRanker 切换为 LLM 打分。 */
    reRanker: undefined, // 不设置 = 默认 CrossEncoderReRanker
  },
})
```

详细说明请参考 [RAG 知识库](/advanced/rag)。

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `OPENAI_BASE_URL` | OpenAI API 自定义 Base URL |

## 下一步

- [核心概念](/core/overview) — 理解 Agent 的架构和运作机制
- [LLM 后端](/llm/overview) — 深入了解各类 Provider 配置
- [工具系统](/tools/overview) — 学习注册和使用自定义工具
- [RAG 知识库](/advanced/rag) — 配置语义检索，让 Agent 基于本地文档回答
