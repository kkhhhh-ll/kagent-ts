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
  mcpServers?: McpServerConfig[]
  subAgents?: SubAgentDefinition[]
  preferences?: Record<string, string>
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
  onLLMStart?: (messages: MessageData[]) => void
  onLLMEnd?: (response: LLMResponse) => void
  onLLMError?: (error: Error) => void
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void
  onToolEnd?: (toolName: string, result: ToolResult) => void
  onToolError?: (toolName: string, error: Error) => void
  onThought?: (thought: string) => void
  onPlanCreated?: (plan: string[], reason: string) => void
  onPlanRevised?: (oldPlan: string[], newPlan: string[], reason: string) => void
  onFinish?: (answer: string, stats: AgentStats) => void
}
```

## 下一步

- [API - LLM](/api/llm) — LLM Provider API
- [API - Tools](/api/tools) — Tool 系统 API
- [API - Messages](/api/messages) — Message 类型 API
