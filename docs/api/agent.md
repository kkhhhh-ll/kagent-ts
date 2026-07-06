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

  /** 反思模式 (默认: "off") */
  reflection?: "off" | "post-hoc" | "inline" | "both"

  /** 内省反思间隔 (默认: 5) */
  inlineReflectionInterval?: number

  /** 最大迭代次数 (默认: 15) */
  maxIterations?: number

  /** 计划最大步骤数 (默认: 12) */
  maxPlanSteps?: number
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
}
```

---

## AgentConfig (基类)

```ts
interface AgentConfig {
  systemPrompt: string
  provider: LLMProvider
  tools: Tool[]
  maxIterations?: number
  contextConfig?: Partial<ContextConfig>
  logger?: Logger
  hooks?: AgentHooks[]
  onToolApproval?: ApprovalCallback
  allowParallelToolCalls?: boolean
  sessionId?: string
  mcpConfigPath?: string          // 推荐：从 JSON 文件加载 MCP 配置
  mcpServers?: Record<string, McpServerConfig>  // 内联覆盖
  subAgents?: SubAgentDefinition[]

  /**
   * 子 Agent 的生命周期钩子。
   * 支持静态对象、数组或工厂函数 (name, runId) => AgentHooks | AgentHooks[]。
   * 用于为子 Agent 注入 TraceLogger 等观测型 hook。
   *
   * 标记了 safeForSubAgent: false 的 hook 会被自动过滤（防止无限递归）。
   */
  subAgentHooks?: AgentHooks | AgentHooks[] | ((name: string, runId: string) => AgentHooks | AgentHooks[])

  memoryConfig?: MemoryConfig
  enableReflection?: boolean
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
  onPlanCreated?: (plan: string[]) => void
  onPlanRevised?: (plan: string[]) => void
  onFinish?: (answer: string) => void
}
```

## 下一步

- [API - LLM](/api/llm) — LLM Provider API
- [API - Tools](/api/tools) — Tool 系统 API
- [API - Messages](/api/messages) — Message 类型 API
