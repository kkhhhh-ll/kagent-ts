# Trace 追踪

`TraceLogger` 生成 HTML 格式的 Agent 执行追踪文件，记录 LLM 调用、工具调用、推理步骤和最终答案。

## 基本用法

```ts
import { ReActAgent, OpenAIProvider, TraceLogger, BUILTIN_TOOLS } from 'kagent-ts'

const traceLogger = new TraceLogger({
  outputDir: './traces',
})

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  hooks: [traceLogger],
})

await agent.run('分析项目结构')

// 生成 ./traces/trace-2024-01-15-143022.html
```

## 配置

```ts
interface TraceLoggerConfig {
  /** 输出目录 (默认: ./traces) */
  outputDir?: string

  /** 文件名前缀 (默认: trace) */
  prefix?: string
}
```

## 追踪内容

`TraceLogger` 实现了 `AgentHooks` 接口，记录以下事件：

| 事件 | 记录内容 |
|------|----------|
| `onLLMStart` | 发送的消息列表、时间戳 |
| `onLLMEnd` | 响应内容、Token 用量、延迟 |
| `onLLMError` | 错误信息、错误类型 |
| `onToolStart` | 工具名称、参数 |
| `onToolEnd` | 工具结果、是否成功 |
| `onToolError` | 错误信息 |
| `onThought` | LLM 的推理文本 |
| `onPlanCreated/onPlanRevised` | 计划的创建和修改 |
| `onFinish` | 最终答案、统计信息 |

## HTML 输出

生成的 HTML 文件包含：
- 🕐 时间线视图
- 💰 Token 消耗和成本估算
- 🔧 工具调用详情（参数 + 结果）
- 🧠 LLM 推理步骤
- ⏱️ 延迟分析
- 📊 统计摘要（迭代次数、工具调用次数、成功率）

## 完整示例

```ts
import { ReActAgent, OpenAIProvider, TraceLogger, BUILTIN_TOOLS } from 'kagent-ts'

const traceLogger = new TraceLogger({
  outputDir: './traces',
  prefix: 'my-agent',
})

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  hooks: [traceLogger],
})

// 执行多次任务，每次生成独立的追踪文件
await agent.run('分析 src/core/ 的代码结构')
// → ./traces/my-agent-2024-01-15-143022.html

agent.newTopic()
await agent.run('查找所有 TODO 注释')
// → ./traces/my-agent-2024-01-15-143145.html
```

## 与其他 Hook 组合

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider,
  tools: BUILTIN_TOOLS,
  hooks: [
    traceLogger,       // HTML 追踪
    evaluator,         // 指标收集
    loggingHook,       // 控制台日志
  ],
})
```

## 下一步

- [Eval 评估](/advanced/eval) — 结合 Trace 进行定量评估
- [Reflection 反思](/advanced/reflection) — Trace 为反思提供详细素材
- [生命周期钩子](/core/hooks) — 自定义钩子实现
