# 生命周期钩子

`AgentHooks` 接口允许你在 Agent 执行的关键节点注入自定义逻辑。可以实现日志记录、指标收集、性能监控等功能。

## 钩子接口

```ts
interface AgentHooks {
  /** LLM 调用开始时触发 */
  onLLMStart?: (messages: MessageData[]) => void

  /** LLM 调用成功返回时触发 */
  onLLMEnd?: (response: LLMResponse) => void

  /** LLM 调用出错时触发 */
  onLLMError?: (error: Error) => void

  /** 工具调用开始时触发 */
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void

  /** 工具调用完成时触发 */
  onToolEnd?: (toolName: string, result: ToolResult) => void

  /** 工具调用出错时触发 */
  onToolError?: (toolName: string, error: Error) => void

  /** LLM 输出推理步骤时触发 (ReAct/Fusion) */
  onThought?: (thought: string) => void

  /** 计划创建时触发 (PlanSolve/Fusion/Orchestrator) */
  onPlanCreated?: (plan: string[], reason: string) => void

  /** 计划修订时触发 */
  onPlanRevised?: (oldPlan: string[], newPlan: string[], reason: string) => void

  /** Agent 执行完成时触发 */
  onFinish?: (answer: string, stats: AgentStats) => void
}
```

## 基础示例

### 执行日志

```ts
const loggingHook: AgentHooks = {
  onLLMStart: (messages) => {
    console.log(`[LLM] 发送 ${messages.length} 条消息`)
  },
  onLLMEnd: (response) => {
    console.log(`[LLM] 响应 ${response.usage?.totalTokens} tokens`)
  },
  onToolStart: (name, args) => {
    console.log(`[Tool] 调用 ${name}(${JSON.stringify(args)})`)
  },
  onToolEnd: (name, result) => {
    const status = result.success ? '✅' : '❌'
    console.log(`[Tool] ${status} ${name}`)
  },
  onFinish: (answer, stats) => {
    console.log(`[Agent] 完成，共 ${stats.iterations} 轮迭代`)
  },
}

const agent = new ReActAgent({
  // ...
  hooks: [loggingHook],
})
```

### 指标收集

```ts
const metricsHook: AgentHooks = {
  onLLMEnd: (response) => {
    metricsCollector.recordLLMCall({
      model: response.model,
      tokens: response.usage?.totalTokens ?? 0,
      latency: response.latencyMs ?? 0,
    })
  },
  onToolEnd: (name, result) => {
    metricsCollector.recordToolCall({
      tool: name,
      success: result.success,
      errorCode: result.errorCode,
    })
  },
}
```

## 内置 Hook 实现

### TraceLogger

`TraceLogger` 是框架内置的钩子实现，会生成 HTML 格式的执行追踪文件：

```ts
import { TraceLogger } from 'kagent-ts'

const traceLogger = new TraceLogger({ outputDir: './traces' })

const agent = new ReActAgent({
  // ...
  hooks: [traceLogger],
})
```

详见 [Trace 追踪](/advanced/trace)。

### Reflection Hook

`createReflectionHook()` 创建一个在 Agent 完成时自动触发反思的钩子：

```ts
import { createReflectionHook, ReflectionAgent, ErrorNotebook } from 'kagent-ts'

const notebook = new ErrorNotebook('./error-notebook')
const reflectionAgent = new ReflectionAgent({ provider, notebook })

const reflectionHook = createReflectionHook(reflectionAgent)

const agent = new FusionAgent({
  // ...
  hooks: [reflectionHook],
})
```

详见 [Reflection 反思](/advanced/reflection)。

### ToolCallEvaluator

`ToolCallEvaluator` 用于收集工具调用指标：

```ts
import { ToolCallEvaluator } from 'kagent-ts'

const evaluator = new ToolCallEvaluator()

const agent = new ReActAgent({
  // ...
  hooks: [evaluator],
})

// 执行后查看统计
const stats = evaluator.getStats()
console.log(`工具调用成功率: ${(stats.successRate * 100).toFixed(1)}%`)
```

详见 [Eval 评估](/advanced/eval)。

## 组合多个 Hook

可以传入多个 Hook，它们按顺序执行：

```ts
const agent = new ReActAgent({
  // ...
  hooks: [
    loggingHook,
    metricsHook,
    traceLogger,
    evaluator,
  ],
})
```

## 下一步

- [工具系统](/tools/overview) — 注册和管理工具
- [会话持久化](/advanced/session) — 利用钩子实现自定义 Checkpoint
- [Trace 追踪](/advanced/trace) — HTML 格式的执行追踪
