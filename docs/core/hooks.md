# 生命周期钩子

`AgentHooks` 接口允许你在 Agent 执行的关键节点注入自定义逻辑。可以实现日志记录、指标收集、性能监控等功能。

## 钩子接口

```ts
interface AgentHooks {
  /**
   * 当为 false 时，此 hook 会被 SubAgentManager 自动排除，
   * 防止传入子 Agent 导致无限递归。
   * 默认 (undefined) 视为安全（纯观测型 hook）。
   */
  safeForSubAgent?: boolean

  /** LLM 调用开始时触发 */
  onLLMStart?: (messages: MessageData[], tools: Tool[]) => void

  /** LLM 调用成功返回时触发 */
  onLLMEnd?: (response: LLMResponse) => void

  /** LLM 网络错误耗尽重试后触发 */
  onLLMError?: (error: LLMNetworkError) => void

  /** 工具调用开始时触发，toolCallId 为 LLM 分配的调用 ID */
  onToolStart?: (toolName: string, args: Record<string, unknown>, toolCallId?: string) => void

  /** 工具调用完成时触发，result 为工具返回的字符串 */
  onToolEnd?: (toolName: string, result: string, toolCallId?: string) => void

  /** 工具调用出错时触发，error 为错误信息字符串 */
  onToolError?: (toolName: string, error: string, toolCallId?: string) => void

  /** LLM 输出推理步骤时触发 (ReAct/Fusion) */
  onThought?: (thought: string) => void

  /** 计划创建时触发 (PlanSolve/Fusion/Orchestrator) */
  onPlanCreated?: (plan: string[]) => void

  /** 计划修订时触发 */
  onPlanRevised?: (plan: string[]) => void

  /** 流式输出文本块时触发 (配合 agent.stream()) */
  onChunk?: (chunk: string) => void

  /** Agent 执行完成时触发 */
  onFinish?: (answer: string) => void
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

## 子 Agent 的 Hook 传递

通过 `subAgentHooks` 配置，可以将观测型 hook（如 `TraceLogger`）自动注入到每个子 Agent 中：

```ts
import { TraceLogger } from 'kagent-ts'

const mainTrace = new TraceLogger({ sessionId: 'main-session' })

const agent = new OrchestratorAgent({
  llm: provider,
  hooks: mainTrace,                                           // 主 Agent 追踪
  subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId),  // 子 Agent 独立追踪
  subAgentsDir: './subagents',
})
```

`subAgentHooks` 支持三种形式：

- **静态对象**：`subAgentHooks: { onFinish: () => ... }`
- **数组**：`subAgentHooks: [traceLogger, metricsHook]`
- **工厂函数**：`subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId)`

> ⚠️ **安全防护**：标记了 `safeForSubAgent: false` 的 hook（如 `ReflectionHook`——它在 `onFinish` 中又会 spawn 子 Agent）会被 `SubAgentManager` 自动过滤，并打印警告日志。这样可以防止无限递归。

## 内置 Hook 实现

### onChunk — 流式输出

配合 `agent.stream()` 使用，在每个文本块到达时触发：

```ts
const agent = new ReActAgent({
  // ...
  hooks: [{
    onChunk: (chunk) => process.stdout.write(chunk),
  }],
})

// stream() 内部自动调用 onChunk
for await (const chunk of agent.stream('你好')) {
  // 也可以通过 async iterator 消费
}
```

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

`createReflectionHook()` 创建钩子，在 Agent 完成时自动并行运行两个子 Agent：

- **错题本 Fork**：分析执行错误 → 写入 ErrorNotebook
- **记忆提取 Fork**：提取长期记忆 → 写入 MemoryManager（可选）

```ts
import { createReflectionHook, ErrorNotebook, MemoryManager } from 'kagent-ts'

const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })
const memory = new MemoryManager('.memory')

const hook = createReflectionHook({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  notebook,
  memoryManager: memory,         // 可选，不传则只做错题本反思
  maxErrorIterations: 4,         // 可选
  maxMemoryIterations: 5,        // 可选
  onReflectionComplete: (entryCount, memoryCount) => {
    console.log(`反思完成: ${entryCount} 条发现, ${memoryCount} 条新记忆`)
  },
})

const agent = new ReActAgent({
  // ...
  hooks: [hook],
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
const stats = evaluator.getScorecard()
console.log(`工具调用成功率: ${(stats.overallSuccessRate * 100).toFixed(1)}%`)
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
