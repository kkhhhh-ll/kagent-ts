# Plan-Solve Agent

Plan-Solve Agent 将任务分解为两个阶段：**先制定计划，再逐步执行**。相比于 ReAct 的事到临头再思考，Plan-Solve 鼓励前置的全局规划，减少中途迷失的可能。

## 执行流程

```
用户输入
  ↓
Phase 1 — PLAN: 分析任务，生成编号步骤列表
  ↓
Phase 2 — RESOLVE:
  ├── 执行第 1 步 (调用工具)
  ├── 执行第 2 步 (调用工具)
  ├── ...
  ├── [遇到障碍?] → 输出 revised_plan (修正剩余步骤)
  └── 继续执行...
  ↓
Final Answer: 所有步骤完成，输出完整答案
```

## 基本用法

```ts
import { PlanSolveAgent, OpenAIProvider } from 'kagent-ts'

const agent = new PlanSolveAgent({
  systemPrompt: '你是一个擅长规划的 AI 助手。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [
    // 注册你需要的工具
  ],
  maxIterations: 15,   // 最大迭代次数 (默认: 15)
  maxPlanSteps: 12,    // 计划最大步骤数 (默认: 12)
  replanThreshold: 2,  // 连续失败 N 次后触发重新规划 (默认: 2)
})

const answer = await agent.run('请审查 src/ 目录下的所有 TypeScript 文件，找出潜在的性能问题。')
console.log(answer)
```

### 流式输出

`stream()` 方法可用但最终答案为一次性输出（Plan-Solve 多阶段推理不适合逐 token 流）：

```ts
for await (const chunk of agent.stream('请审查项目代码')) {
  process.stdout.write(chunk)
}
```

## 配置参数

```ts
interface PlanSolveAgentConfig extends AgentConfig {
  /** 最大迭代次数 (默认: 15) */
  maxIterations?: number

  /** 计划中最大步骤数 (默认: 12) */
  maxPlanSteps?: number

  /**
   * 连续工具失败 N 次后自动注入 replan 提示。
   * 设为 0 禁用自动重规划。
   * 默认: 2
   */
  replanThreshold?: number
}
```

## 计划修订

当 LLM 在执行过程中遇到意外情况时，可以通过输出 `revised_plan` 来修正剩余步骤。支持两种格式：

**JSON 格式：**

```json
{
  "revised_plan": [
    "1. 分析 src/core/ 目录的代码结构",
    "2. 使用 tsc --noEmit 检查编译错误",
    "3. 检查每个文件的导入依赖"
  ]
}
```

**方括号标记格式（兼容更多模型）：**

```text
[Thought] 当前步骤遇到问题，需要调整计划
[Revised Plan]
1. 分析 src/core/ 目录的代码结构
2. 使用 tsc --noEmit 检查编译错误
3. 检查每个文件的导入依赖
```

## 响应格式

Plan-Solve Agent 支持两种响应格式，解析器按优先级依次尝试：

| 优先级 | 格式 | 示例 |
|--------|------|------|
| 1 | JSON | `{"thought": "...", "plan": [...]}` |
| 2 | 方括号标记 | `[Thought] ...` / `[Plan]` / `[Final Answer]` |
| 3 | 自然语言 | `Final Answer: ...` |

**方括号标记列表：**

| 标记 | 用途 |
|------|------|
| `[Thought]` | 每轮必填 — 当前分析/推理 |
| `[Plan]` | 初始计划（编号列表） |
| `[Current Step]` | 即将执行的步骤号（1-based） |
| `[Revised Plan]` | 修正后的剩余步骤（编号列表） |
| `[Final Answer]` | 任务完成时的最终答案 |

如果模型只输出 `[Thought]` 而没有其他标记，解析器会将其作为最终答案返回。这确保弱模型（不严格遵守格式）也能正常结束循环。

## 会话状态

Plan-Solve Agent 的 Checkpoint 包含完整的计划状态：

```ts
interface PlanSolveSessionState {
  currentPlan: string[]       // 当前计划步骤列表
  completedSteps: number[]    // 已完成的步骤索引
  replanCount: number         // 重新规划次数
  currentStep: number         // 当前执行步骤
}
```

## 什么时候用 Plan-Solve？

✅ **适合**:
- 需要多步工具调用的复杂任务
- 代码审查、代码重构
- 项目分析、依赖检查
- 需要明确执行计划的任务

❌ **不适合**:
- 单步即可完成的简单问答 → 使用 [ReAct Agent](/core/react-agent)
- 需要动态决策的不确定任务 → 使用 [Fusion Agent](/core/fusion-agent)

## 下一步

- [Fusion Agent](/core/fusion-agent) — 混合范式：自动路由 + 反思
- [Orchestrator Agent](/core/orchestrator-agent) — 大规模多代理编排
- [上下文管理](/advanced/context-compression) — 长对话的 Token 管理
