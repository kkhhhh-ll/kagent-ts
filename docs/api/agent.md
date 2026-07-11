# API - Agent

## ReActAgent

```ts
import { ReActAgent } from 'kagent-ts'

const agent = new ReActAgent(config: ReActAgentConfig)
```

### ReActAgentConfig

```ts
interface ReActAgentConfig extends AgentConfig {
  /** 最大迭代次数 (默认: 10) */
  maxIterations?: number

  /** 错题本反思模式 (默认: "off") */
  reflection?: "off" | "post-hoc"

  /** 反思子 Agent 最大迭代次数 (默认: 4) */
  reflectionMaxIterations?: number

  /** 记忆提取模式 (默认: "off") */
  memoryReflection?: "off" | "post-hoc"

  /** 记忆提取子 Agent 最大迭代次数 (默认: 5) */
  memoryReflectionMaxIterations?: number

  /** Skill 沉淀模式 (默认: "off") */
  precipitation?: "off" | "post-hoc"

  /** 沉淀子 Agent 最大迭代次数 (默认: 15) */
  precipitationMaxIterations?: number
}
```

### 方法

继承自 `Agent` 的所有方法，参见 [Agent 基类](/core/agent)。

---

## PlanSolveAgent

```ts
import { PlanSolveAgent } from 'kagent-ts'

const agent = new PlanSolveAgent(config: PlanSolveAgentConfig)
```

### PlanSolveAgentConfig

```ts
interface PlanSolveAgentConfig extends AgentConfig {
  /** 最大迭代次数 (默认: 15) */
  maxIterations?: number

  /** 计划中最大步骤数 (默认: 12) */
  maxPlanSteps?: number

  /** 连续失败 N 次后触发自动 replan (默认: 2, 设为 0 禁用) */
  replanThreshold?: number

  /** 错题本反思模式 (默认: "off") */
  reflection?: "off" | "post-hoc"

  /** 反思子 Agent 最大迭代次数 (默认: 4) */
  reflectionMaxIterations?: number

  /** 记忆提取模式 (默认: "off") */
  memoryReflection?: "off" | "post-hoc"

  /** 记忆提取子 Agent 最大迭代次数 (默认: 5) */
  memoryReflectionMaxIterations?: number

  /** Skill 沉淀模式 (默认: "off") */
  precipitation?: "off" | "post-hoc"

  /** 沉淀子 Agent 最大迭代次数 (默认: 15) */
  precipitationMaxIterations?: number
}
```

---

## FusionAgent

```ts
import { FusionAgent } from 'kagent-ts'

const agent = new FusionAgent(config: FusionAgentConfig)
```

### FusionAgentConfig

```ts
interface FusionAgentConfig extends AgentConfig {
  /** 路由策略 (默认: "auto") */
  routing?: "auto" | "force-plan" | "force-react"

  /** 计划确认模式 (默认: "auto") */
  planConfirmation?: "never" | "always" | "auto"

  /** 计划确认回调 */
  onPlanConfirm?: PlanConfirmCallback

  /** 错题本反思模式 (默认: "off") */
  reflection?: "off" | "post-hoc"

  /** 反思子 Agent 最大迭代次数 (默认: 4) */
  reflectionMaxIterations?: number

  /** 记忆提取模式 (默认: "off") */
  memoryReflection?: "off" | "post-hoc"

  /** 记忆提取子 Agent 最大迭代次数 (默认: 5) */
  memoryReflectionMaxIterations?: number

  /** ErrorNotebook 实例，用于持久化反思结果（可选，不传自动创建） */
  notebook?: ErrorNotebook

  /** 最大迭代次数 (默认: 15) */
  maxIterations?: number

  /** 计划最大步骤数 (默认: 12) */
  maxPlanSteps?: number

  /** 连续工具失败 N 次后注入 replan 提示 (默认: 2，设为 0 禁用) */
  replanThreshold?: number

  /** Skill 沉淀模式 (默认: "off") */
  precipitation?: "off" | "post-hoc"

  /** 沉淀子 Agent 最大迭代次数 (默认: 15) */
  precipitationMaxIterations?: number
}

type PlanConfirmCallback = (
  plan: string[],
  reason: string,
) => Promise<boolean>
```

---

## OrchestratorAgent

```ts
import { OrchestratorAgent } from 'kagent-ts'

const agent = new OrchestratorAgent(config: OrchestratorAgentConfig)
```

### OrchestratorAgentConfig

```ts
interface OrchestratorAgentConfig extends AgentConfig {
  /** 最大编排轮次 (默认: 3) */
  maxRounds?: number

  /** 每轮最大并行节点数 (默认: 5) */
  maxParallelNodes?: number

  /** 最大总节点数 (默认: 20) */
  maxTotalNodes?: number

  /** 单节点最大重试次数 (默认: 2) */
  maxRetriesPerNode?: number

  /** 失败处理策略 (默认: "retry-subtree") */
  failureStrategy?: "retry-subtree" | "retry-all" | "continue"
}
```

---

## AgentConfig (基类)

所有 Agent 类型共享的基础配置。

```ts
interface AgentConfig {
  // ── 核心 ──
  llm: LLMProvider                                  // LLM Provider 实例（必填）
  systemPrompt?: string                             // 系统提示词
  name?: string                                     // Agent 名称

  // ── 工具 ──
  tools?: Tool[]                                    // 工具列表
  toolRegistry?: ToolRegistry                       // 自定义 ToolRegistry 实例
  toolOutputMaxBytes?: number                       // 工具输出截断阈值
  toolRetryCount?: number                           // 工具失败重试次数
  toolErrorTracker?: ToolErrorTracker               // 自定义错误追踪器

  // ── 上下文 ──
  contextManager?: ContextManager                   // 上下文管理器实例

  // ── 日志 ──
  logger?: Logger                                   // 日志实例（默认: ConsoleLogger）

  // ── 生命周期钩子 ──
  hooks?: AgentHooks | AgentHooks[]

  // ── 人工审批 (HITL) ──
  onToolApproval?: ApprovalCallback                 // 工具审批回调
  approvalTimeoutMs?: number                        // 审批超时 (ms)
  approvalTimeoutStrategy?: "deny" | "allow"       // 超时策略 (默认: "deny")

  // ── 并行执行 ──
  enableParallelToolExecution?: boolean             // 启用并行工具调用

  // ── 用户配置 ──
  preferencesPath?: string                          // 偏好文件路径 (默认: ".kagent/preferences.md")
  rulesPath?: string                                // 规则文件/目录路径 (默认: ".kagent/rules/")

  // ── 记忆 ──
  memoryDir?: string                                // 记忆存储目录 (默认: ".memory")

  // ── 会话 ──
  sessionId?: string                                // 会话 ID
  sessionDir?: string                               // 会话存储目录
  enableCheckpointing?: boolean                     // 启用会话持久化

  // ── MCP ──
  mcpConfigPath?: string                            // mcp.json 文件路径
  mcpServers?: Record<string, McpServerConfig>      // MCP Server 内联配置

  // ── RAG ──
  rag?: RAGConfig                                   // RAG 知识检索配置

  // ── 子 Agent ──
  subAgentsDir?: string                             // 子 Agent 定义目录
  disableSubAgents?: boolean                        // 禁用子 Agent
  skipAutoTools?: boolean                           // 跳过子 Agent 工具自动注册

  /**
   * 子 Agent 的生命周期钩子。
   * 支持静态对象、数组或工厂函数 (name, runId) => AgentHooks | AgentHooks[]。
   */
  subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[])

  /**
   * 子 Agent 专用 LLM Provider。
   * 不设置时：如果 llm 是 ModelRouter，则走 forSubAgent()；否则复用主 llm。
   */
  subAgentLLM?: LLMProvider

  // ── 技能 ──
  skillManager?: SkillManager                       // SkillManager 实例
  skillsDir?: string                                // 技能文件目录

  // ── 后处理 ──
  /** 技能沉淀模式 (默认: "off") */
  precipitation?: "off" | "post-hoc"
  /** 沉淀子 Agent 最大迭代次数 */
  precipitationMaxIterations?: number
  /** 技能沉淀专用 LLM Provider（不设置时自动走 ModelRouter.forPrecipitation() 或复用 llm） */
  precipitationLLM?: LLMProvider

  /** 记忆提取模式 (默认: "off") */
  memoryReflection?: "off" | "post-hoc"
  /** 记忆提取子 Agent 最大迭代次数 */
  memoryReflectionMaxIterations?: number
  /** 记忆提取专用 LLM Provider（不设置时自动走 ModelRouter.forMemory() 或复用 llm） */
  memoryReflectorLLM?: LLMProvider

  /** 错题本反思专用 LLM Provider（不设置时自动走 ModelRouter.forReflection() 或复用 llm） */
  reflectionLLM?: LLMProvider

  // ── Token 预算 ──
  tokenBudgetConfig?: TokenBudgetConfig             // Token 消耗限制

  // ── 工作目录 ──
  workdir?: string                                  // Agent 工作目录
}

type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<boolean>
```

> **注意**：`maxIterations`、`reflection`、`reflectionMaxIterations`、`notebook` 等字段不在 `AgentConfig` 基类中，而是定义在各具体 Agent 的 Config 中（如 `ReActAgentConfig`、`PlanSolveAgentConfig` 等）。

---

## AgentHooks

```ts
interface AgentHooks {
  /**
   * 当为 false 时，此 hook 不会被传入子 Agent（防止无限递归）。
   * 默认 undefined 视为安全。
   */
  safeForSubAgent?: boolean

  onLLMStart?: (messages: MessageData[], tools: Tool[]) => void
  onLLMEnd?: (response: LLMResponse) => void
  onLLMError?: (error: LLMNetworkError) => void
  onToolStart?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => void
  onToolEnd?: (toolName: string, result: string, toolCallId?: string) => void
  onToolError?: (toolName: string, error: string, toolCallId?: string) => void
  onThought?: (thought: string) => void
  onChunk?: (chunk: string) => void
  onPlanCreated?: (plan: string[]) => void
  onPlanRevised?: (plan: string[]) => void
  onFinish?: (answer: string) => void
}
```

## 下一步

- [API - LLM](/api/llm) — LLM Provider API
- [API - Tools](/api/tools) — Tool 系统 API
- [API - Messages](/api/messages) — Message 类型 API
