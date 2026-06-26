# 配置

## Agent 通用配置

所有 Agent 类型共享一套基础配置，通过构造函数传入：

```ts
interface AgentConfig {
  /** 系统提示词 — 定义 Agent 的行为和角色 */
  systemPrompt: string

  /** LLM Provider 实例 */
  provider: LLMProvider

  /** 工具列表 */
  tools: Tool[]

  /** 最大迭代次数 */
  maxIterations?: number          // 默认: ReAct=10, PlanSolve=15, Fusion=15

  /** 上下文管理配置 */
  contextConfig?: Partial<ContextConfig>

  /** 日志实例 */
  logger?: Logger

  /** 生命周期钩子 */
  hooks?: AgentHooks[]

  /** 工具审批回调 (HITL) */
  onToolApproval?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>

  /** 是否允许并行工具调用 */
  allowParallelToolCalls?: boolean

  /** Session ID (用于会话持久化) */
  sessionId?: string

  /** MCP Server 配置 */
  mcpServers?: McpServerConfig[]

  /** 子代理定义 */
  subAgents?: SubAgentDefinition[]

  /** 用户偏好 */
  preferences?: Record<string, string>

  /** Memory 管理器配置 */
  memoryConfig?: MemoryConfig

  /** 是否启用反思 */
  enableReflection?: boolean

  /** Token 预算配置 */
  tokenBudget?: TokenBudgetConfig
}
```

## LLM Provider 配置

### OpenAI

```ts
import { OpenAIProvider } from 'kagent-ts'

const provider = new OpenAIProvider({
  apiKey: 'sk-...',
  model: 'gpt-4o',           // 默认: gpt-4o
  baseURL: 'https://api.openai.com/v1',
  timeout: 60000,            // 请求超时 (ms)
  maxRetries: 3,             // 最大重试次数
  temperature: 0.7,
  maxTokens: 4096,
})
```

### Anthropic

```ts
import { AnthropicProvider } from 'kagent-ts'

const provider = new AnthropicProvider({
  apiKey: 'sk-ant-...',
  model: 'claude-sonnet-4-6', // 默认模型
  timeout: 60000,
  maxRetries: 3,
  cacheSystemPrompt: true,    // 启用 Prompt Caching
  maxTokens: 4096,
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
const contextConfig = {
  maxTokens: 128000,             // 上下文窗口最大 Token 数
  compressionThreshold: 0.8,     // 80% 阈值触发压缩
  keepTurns: 20,                 // 保留最近 N 轮对话
  toolResultMaxAgeMs: 300000,    // 工具结果最大保留时间 (5分钟)
}
```

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `KAGENT_CONFIG_DIR` | 自定义配置目录 (默认: `~/.kagent`) |
| `KAGENT_SESSIONS_DIR` | 自定义会话持久化目录 |

## 下一步

- [核心概念](/core/overview) — 理解 Agent 的架构和运作机制
- [LLM 后端](/llm/overview) — 深入了解各类 Provider 配置
- [工具系统](/tools/overview) — 学习注册和使用自定义工具
