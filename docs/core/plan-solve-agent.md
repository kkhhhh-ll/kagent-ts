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

当 LLM 在执行过程中遇到意外情况时，可以通过输出 `revised_plan` 来修正剩余步骤：

```json
{
  "revised_plan": [
    "1. 分析 src/core/ 目录的代码结构",
    "2. 使用 tsc --noEmit 检查编译错误",
    "3. 检查每个文件的导入依赖"
  ]
}
```

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
