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

```ts
interface AgentConfig {
  systemPrompt?: string
  llm: LLMProvider
  tools?: Tool[]
  contextConfig?: Partial<ContextConfig>
  logger?: Logger
  hooks?: AgentHooks | AgentHooks[]
  onToolApproval?: ApprovalCallback
  allowParallelToolCalls?: boolean
  preferencesPath?: string           // 偏好文件路径 (默认: ".kagent/preferences.md")
  rulesPath?: string                 // 规则文件/目录路径 (默认: ".kagent/rules/")
  memoryDir?: string                 // 记忆存储目录 (默认: ".memory")
  sessionId?: string
  mcpConfigPath?: string
  mcpServers?: Record<string, McpServerConfig>
  subAgents?: SubAgentDefinition[]

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

  /**
   * Skill 沉淀专用 LLM Provider。
   * 不设置时：如果 llm 是 ModelRouter，则走 forPrecipitation()；否则复用主 llm。
   */
  precipitationLLM?: LLMProvider

  /**
   * 错题本反思专用 LLM Provider。
   * 不设置时：如果 llm 是 ModelRouter，则走 forReflection()；否则复用主 llm。
   */
  reflectionLLM?: LLMProvider

  /**
   * 记忆提取专用 LLM Provider。
   * 不设置时：如果 llm 是 ModelRouter，则走 forMemory()；否则复用主 llm。
   */
  memoryReflectorLLM?: LLMProvider

  /** 错题本反思模式 (默认: "off") */
  reflection?: "off" | "post-hoc"

  /** 记忆提取模式 (默认: "off") */
  memoryReflection?: "off" | "post-hoc"

  tokenBudget?: TokenBudgetConfig
}

type ApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<boolean>
```

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
