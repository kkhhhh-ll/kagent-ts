# Agent 基类

`Agent` 是所有 Agent 类型的抽象基类。它提供了共享的基础设施，包括 LLM 调用、工具管理、上下文压缩、会话持久化等。

## 构造函数

```ts
import { Agent } from 'kagent-ts'

// Agent 是抽象类，不能直接实例化
// 请使用 ReActAgent / PlanSolveAgent / FusionAgent / OrchestratorAgent
```

## 通用方法

所有 Agent 子类都继承以下方法：

### `run(input: string): Promise<string>`

执行 Agent 的主循环，处理用户输入并返回最终答案。

```ts
const answer = await agent.run('请帮我分析这个项目的代码结构。')
```

### `stream(input: string): AsyncIterable<string>`

流式执行 Agent，实时输出 LLM 生成的文本块。ReAct 模式下工具调用透明处理；Plan-Solve / Fusion 模式最终答案一次性输出。

```ts
for await (const chunk of agent.stream('你好，请帮我分析项目结构。')) {
  process.stdout.write(chunk)
}
```

### `chat(input: string): Promise<string>`

单轮对话，不触发 Agent 循环（不调用工具，仅 LLM 回复）。

```ts
const reply = await agent.chat('你好，你能做什么？')
```

### `newTopic(): void`

清除当前对话历史，开始新的话题。保留系统提示词和配置。

```ts
agent.newTopic()
```

### `cancel(): void`

取消当前正在执行的 `run()` 调用。已执行的工具调用无法回滚。

```ts
agent.cancel()
```

### `reset(): void`

完全重置 Agent 到初始状态（清除对话历史、会话状态等）。

```ts
agent.reset()
```

### `clearConversation(): void`

仅清除对话消息，保留其他状态。

```ts
agent.clearConversation()
```

### `resume(sessionId: string, input?: string): Promise<string>`

从持久化的 Checkpoint 恢复会话并继续执行。

```ts
const answer = await agent.resume('session_abc123', '继续之前的任务')
```

### `shutdown(): Promise<void>`

优雅关闭 Agent：中断正在进行的 LLM 请求、取消并等待所有子 Agent 完成、断开 MCP 连接。

```ts
await agent.shutdown()
```

## 生命周期钩子

通过 `AgentHooks` 接口可以监听 Agent 执行的各个阶段。详见 [生命周期钩子](/core/hooks)。

```ts
const agent = new ReActAgent({
  // ...
  hooks: [{
    onLLMStart: (messages) => console.log('LLM 调用开始'),
    onLLMEnd: (response) => console.log('LLM 调用结束'),
    onToolStart: (name, args) => console.log(`工具调用: ${name}`),
    onToolEnd: (name, result) => console.log(`工具结果: ${name}`),
    onThought: (thought) => console.log(`思考: ${thought}`),
    onFinish: (answer, stats) => console.log(`完成: ${stats.iterations} 轮`),
  }],
})
```

## 工具审批 (HITL)

通过 `onToolApproval` 回调实现 Human-In-The-Loop 工具审批：

```ts
const agent = new ReActAgent({
  // ...
  onToolApproval: async (toolName, args) => {
    console.log(`确认执行 ${toolName}?`, args)
    // 返回 true 允许执行，false 拒绝
    return true
  },
})
```

## 并行工具调用

设置 `allowParallelToolCalls: true` 允许 LLM 在同一轮中并行调用多个独立工具：

```ts
const agent = new ReActAgent({
  // ...
  allowParallelToolCalls: true,
})
```

## RAG 知识检索

配置 `rag` 选项后，Agent 启动时会自动索引本地文档并注册 `search_knowledge` 工具：

```ts
import { OpenAIEmbeddingProvider } from 'kagent-ts'

const agent = new ReActAgent({
  // ...
  rag: {
    documentsDir: './docs',
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    }),
    topK: 5,
  },
})

// 支持纯向量检索、混合检索（BM25 + RRF）、Re-rank 精排
// 详见 [RAG 知识库](/advanced/rag)
await agent.run('怎么配置 MCP？')
```

## 下一步

- [生命周期钩子](/core/hooks) — 详细的钩子使用指南
- [LLM 后端](/llm/overview) — 配置 LLM Provider
- [工具系统](/tools/overview) — 注册和自定义工具
- [RAG 知识库](/advanced/rag) — 让 Agent 基于本地文档进行语义检索
