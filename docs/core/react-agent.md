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
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({
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

## 结构化 JSON 输出

ReAct Agent 使用结构化 JSON 格式与 LLM 交互：

- **中间步骤**: `{"thought": "我需要先用 ls 查看文件列表..."}`
- **最终答案**: `{"thought": "已经获取了所有需要的信息", "answer": "最大的 5 个文件是..."}`

框架会自动解析这些 JSON 响应，并对噪声数据（如 code fences、未转义换行符）做容错处理。

## 配置参数

```ts
interface ReActAgentConfig extends AgentConfig {
  /** 最大迭代次数 (默认: 10) */
  maxIterations?: number
}
```

## 安全特性

ReAct Agent 内置以下保护机制：

- **连续空迭代检测**: 如果 LLM 连续返回空响应，Agent 会提前终止以防止卡死
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
