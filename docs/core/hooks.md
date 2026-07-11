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

  /** Agent 执行完成时触发（支持同步和异步，异步回调在后台执行不阻塞） */
  onFinish?: (answer: string) => void | Promise<void>
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
    console.log(`[LLM] 响应 ${response.usage?.total_tokens} tokens`)
  },
  onToolStart: (name, args) => {
    console.log(`[Tool] 调用 ${name}(${JSON.stringify(args)})`)
  },
  onToolEnd: (name, result) => {
    console.log(`[Tool] ✅ ${name} (${result.length} 字符)`)
  },
  onFinish: (answer) => {
    console.log(`[Agent] 完成，答案长度: ${answer.length} 字符`)
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
      model: response.providerMeta?.model,
      tokens: response.usage?.total_tokens ?? 0,
    })
  },
  onToolStart: (name, args) => {
    metricsCollector.recordToolCallStart({
      tool: name,
      args,
    })
  },
  onToolEnd: (name, result) => {
    metricsCollector.recordToolCallEnd({
      tool: name,
      resultLength: result.length,
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

> ⚠️ **安全防护**：标记了 `safeForSubAgent: false` 的 hook（会在 `onFinish` 中 spawn 子 Agent）会被 `SubAgentManager` 自动过滤，并打印警告日志。这样可以防止无限递归。

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

### 错题本反思 & 记忆提取

错题本反思（Reflection）和记忆提取（Memory Reflection）已内建到 Agent 中，通过
AgentConfig 直接开启，无需额外的 Hook：

```ts
const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  reflection: "post-hoc",         // 会话结束后 fork 子 Agent 分析错误
  memoryReflection: "post-hoc",   // 会话结束后 fork 子 Agent 提取长期记忆
})
```

两个子系统都是 post-hoc（执行后）模式，在 Agent 返回 answer 之前自动触发，
best-effort，失败不影响主流程。

详见 [Reflection 反思](/advanced/reflection) 和 [Memory 记忆](/advanced/memory)。

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
