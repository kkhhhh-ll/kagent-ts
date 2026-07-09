# ReAct Agent

ReAct（Reasoning + Acting）是最经典的 Agent 范式。Agent 在 **思考 → 行动 → 观察** 的循环中逐步解决用户的问题。

## 执行流程

```
用户输入
  ↓
Thought (思考): "我需要先理解用户的问题..."
  ↓
Action (行动): 调用工具获取信息
  ↓
Observation (观察): 解析工具返回的结果
  ↓
[判断是否完成?]
  ├── 否 → 回到 Thought (下一轮迭代)
  └── 是 → Final Answer (最终答案)
```

## 基本用法

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [
    // 注册你需要的工具
  ],
  maxIterations: 10,  // 默认值: 10
})

const answer = await agent.run('帮我查找当前目录下最大的 5 个文件')
console.log(answer)
```

## 流式输出

ReAct Agent 支持流式输出——`stream()` 方法使用 `chatStream` 实时输出 LLM 生成的文本，工具调用阶段透明处理：

```ts
for await (const chunk of agent.stream('请分析这个项目的代码结构')) {
  process.stdout.write(chunk)  // 逐字输出，无等待
}
```

内部逻辑：有 `tool_calls` → 执行工具 → 继续流式循环；无 `tool_calls` → 流式内容即最终答案。也可以通过 `onChunk` 钩子接收：

```ts
const agent = new ReActAgent({
  // ...
  hooks: [{ onChunk: (chunk) => process.stdout.write(chunk) }],
})
```

## 响应格式

ReAct Agent **不要求模型输出 JSON**。判定逻辑非常简单：

- **有 `tool_calls`** → 执行工具，继续循环
- **没有 `tool_calls`** → 当前响应内容就是最终答案

这与大多数 Agent 框架一致，兼容 DeepSeek、Claude、GPT 等各类支持 function calling 的模型。

## 配置参数

```ts
interface ReActAgentConfig extends AgentConfig {
  /** 最大迭代次数 (默认: 10) */
  maxIterations?: number

  /** 技能沉淀模式 (默认: "off") */
  precipitation?: "off" | "post-hoc"

  /** 沉淀子 Agent 最大迭代次数 (默认: 15) */
  precipitationMaxIterations?: number
}
```

## 安全特性

ReAct Agent 内置以下保护机制：

- **空响应检测**: 连续 3 次空/极短响应（< 5 字符）后自动终止
- **Token 截断处理**: 当 LLM 响应被 `max_tokens` 截断时，Agent 会注入续写提示
- **自动 Checkpoint**: 每个迭代步骤后自动保存会话检查点
- **网络错误恢复**: 网络中断时自动保存 `interrupted` 状态的检查点

## 会话恢复

```ts
// 网络中断后恢复会话
const answer = await agent.resume('session_abc123', '继续之前的任务')
```

## 什么时候用 ReAct？

✅ **适合**:
- 简单的问答任务
- 需要 1-3 步工具调用的任务
- Token 敏感的轻量级任务
- 对延迟敏感的实时应用

❌ **不适合**:
- 需要前置规划的多步复杂任务 → 使用 [Plan-Solve Agent](/core/plan-solve-agent)
- 不确定复杂度的通用任务 → 使用 [Fusion Agent](/core/fusion-agent)
- 大规模多代理协作 → 使用 [Orchestrator Agent](/core/orchestrator-agent)

## 下一步

- [Plan-Solve Agent](/core/plan-solve-agent) — 先规划后执行的范式
- [工具系统](/tools/overview) — 学习注册和使用工具
- [会话持久化](/advanced/session) — 了解 Checkpoint 机制
