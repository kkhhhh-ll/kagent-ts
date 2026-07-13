# Fusion Agent

Fusion Agent 是框架中最灵活、最智能的 Agent 范式。它融合了 ReAct、Plan-Solve 和 Reflection 三种模式，能够根据任务复杂度**自动路由**到最合适的执行策略。

## 执行流程

```
用户输入
  ↓
[Intent] 信号检测 + Skill 关键词匹配（零 LLM 开销）
  ├── wantsRemember → 强制触发沉淀/记忆
  ├── riskLevel    → "none" / "low" / "high"（否定感知）
  ├── scenarios[]  → 多标签任务场景
  ├── complexity   → 复杂度预估
  └── 匹配到 Skill → 自动激活注入 System Prompt
  ↓
[ROUTE] 复杂度分类:
  ├── 简单 (simple) → ReAct 快速执行
  └── 复杂 (complex) → Plan → Execute
  ↓
[PLAN] (仅 complex):
  ├── 生成执行计划
  ├── [确认计划? never/always/auto]
  └── 用户确认 (如需要)
  ↓
[EXECUTE] 执行计划步骤 (ReAct 或 Plan-Solve)
  └── 继续直到完成
  ↓
Final Answer
  ↓
[VERIFY] (可选，post-hoc — 阻塞):
  ├── VerifyAgent Fork — 验证正确性 / 完整性
  ├── score < threshold → 注入反馈 → 一次 LLM 修正
  └── 返回验证/修正后的答案
  ↓ (答案返回给用户)
  ↓ (后台 fire-and-forget，不阻塞)
[REFLECT] (可选，post-hoc):
  ├── ReflectionAgent 反思整个会话
  └── 记录到 ErrorNotebook
  ↓
[MEMORY] (可选，post-hoc):
  ├── MemoryReflector 提取长期记忆
  └── 写入 MemoryManager (.memory/)
  ↓
[PRECIPITATE] (可选，post-hoc):
  ├── PrecipitateAgent 提取可复用技能
  ├── 写入 SKILL.md 文件
  └── 对比已有 Skills 去重
```

## 基本用法

```ts
import { FusionAgent, OpenAIProvider } from 'kagent-ts'

const agent = new FusionAgent({
  systemPrompt: '你是一个全能 AI 助手。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [
    // 注册你需要的工具
  ],

  // ── 路由策略 ──
  routing: 'auto',            // "auto" | "force-plan" | "force-react"

  // ── 计划确认 ──
  planConfirmation: 'always',  // "always" | "auto" | "never" (默认: "always")
  // onPlanConfirm: async (plan, reason) => { return true },

  // ── Post-hoc 子系统 ──
  verification: 'post-hoc',          // "off" | "post-hoc" — 答案验证（阻塞式）
  verificationThreshold: 75,         // 验证及格线 0-100 (默认: 70)
  reflection: 'post-hoc',          // "off" | "post-hoc" — 错题本反思（fire-and-forget）
  memoryReflection: 'post-hoc',    // "off" | "post-hoc" — 记忆提取（fire-and-forget）
  // notebook: new ErrorNotebook(), // 可选，不传自动创建

  // ── 沉淀配置 ──
  skillsDir: './skills',               // 技能存储目录
  // skillStore: new PostgresSkillStore(db),  // 或注入自定义技能存储后端
  precipitation: 'post-hoc',           // "off" | "post-hoc"
  precipitationMaxIterations: 5,       // (默认: 5)
})
```

## 配置参数

```ts
interface FusionAgentConfig extends AgentConfig {
  // ── 路由策略 ──
  routing?: 'auto' | 'force-plan' | 'force-react'
  // "auto":        LLM 自动分类任务复杂度 (多一次 LLM 调用)
  // "force-plan":  始终走 Plan → Execute 流程
  // "force-react": 始终走 ReAct 直接执行

  // ── 计划确认 ──
  planConfirmation?: 'always' | 'auto' | 'never'  // (默认: "always")
  onPlanConfirm?: PlanConfirmCallback
  // "always": 始终先让用户确认计划（默认）
  // "auto":   仅当检测到高风险操作（delete, drop, force push 等）时请求确认
  // "never":  直接执行，不确认

  // ── 答案验证 ──
  verification?: 'off' | 'post-hoc'     // (默认: "off") — 阻塞式
  verificationThreshold?: number        // 及格线 0-100 (默认: 70)
  verificationMaxIterations?: number    // (默认: 3)

  // ── Post-hoc 反思 ──
  reflection?: 'off' | 'post-hoc'       // 错题本反思 (默认: "off")
  reflectionMaxIterations?: number      // (默认: 6)
  notebook?: ErrorNotebook              // 可选，不传自动创建

  // ── 记忆提取 ──
  memoryReflection?: 'off' | 'post-hoc' // (默认: "off")
  memoryReflectionMaxIterations?: number// (默认: 5)

  // ── 循环控制 ──
  maxIterations?: number                // (默认: 15)
  maxPlanSteps?: number                 // (默认: 12)
  replanThreshold?: number              // (默认: 2，设为 0 禁用)

  // ── 沉淀配置 ──
  precipitation?: 'off' | 'post-hoc'    // (默认: "off")
  precipitationMaxIterations?: number   // (默认: 15)
}
```

## 路由机制

在 `"auto"` 模式下，Fusion Agent 会先让 LLM 分类任务的复杂度：

```
用户: "帮我重构整个项目的日志系统"
LLM: {"complexity": "complex", "reason": "涉及多文件修改和架构决策"}

用户: "当前目录下有哪些 .ts 文件？"
LLM: {"complexity": "simple", "reason": "单步工具调用即可完成"}
```

## Post-hoc 子系统

Fusion Agent 内置四个 post-hoc 子系统。**Verification 是阻塞式的**，在 answer 返回前验证/修正；其余三个在 answer 返回后 fire-and-forget，失败不影响主流程。

### 错题本反思

```ts
reflection: 'post-hoc'  // 开启
```

执行完成后，Fork 一个 `ReflectionAgent` 对整个会话进行反思：

- 分类问题: `reasoning_error`, `tool_misuse`, `missed_optimization`, `incomplete_answer`, `hallucination`, `context_mismanagement`
- 记录到 ErrorNotebook 供后续学习

### 记忆提取

```ts
memoryReflection: 'post-hoc'  // 开启
```

Fork 一个 `MemoryReflector` 从会话中提取长期记忆（规则、项目事实、用户偏好），写入 `.memory/` 目录。

### 技能沉淀

```ts
precipitation: 'post-hoc'  // 开启
```

触发条件：
- `"post-hoc"` 模式：每次成功完成都触发
- 踩坑后成功（`consecutiveFailures >= 2`）：框架自动检测
- 用户说"记住"：输入关键词匹配

详见 [Precipitation 沉淀](/advanced/precipitation)、[Reflection 反思](/advanced/reflection) 和 [Memory 记忆](/advanced/memory)。

## 计划确认

通过 `planConfirmation` 和 `onPlanConfirm` 实现人机协作：

```ts
const agent = new FusionAgent({
  // ...
  planConfirmation: 'always',
  onPlanConfirm: async (plan, reason) => {
    console.log('计划:', plan)
    console.log('原因:', reason)
    // 返回 true 继续执行，false 终止
    return true
  },
})
```

在 `"auto"` 模式下，当计划中包含**高风险操作**（`delete`, `drop`, `force push`, `rm -rf` 等）时，自动请求用户确认。**低风险操作**（`deploy`, `release`, `migrate`, `reset`）不会触发确认——这些被视为常规操作。

| 风险等级 | 关键词示例 | auto 行为 |
|----------|-----------|----------|
| `"high"` | `delete`, `drop`, `destroy`, `purge`, `format`, `truncate`, `rm -rf`, `force push`, `hard reset` | **触发确认** |
| `"low"` | `deploy`, `release`, `publish`, `ship`, `migrate`, `reset` | **不触发确认** |
| `"none"` | 无风险关键词或全部被否定（如 `"不要删除"`） | 不触发确认 |

如果用户说 `"deploy the app but don't delete old files"`，`"delete"` 所在的句子含否定标记 `"don't"`，被排除。`"deploy"` 属于低风险，不触发确认。最终 `riskLevel = "low"` → 不确认。

计划确认同样受 `approvalTimeoutMs` 超时保护——超时后将计划以文本形式返回给用户，等待手动恢复。详见 [HITL 审批](/tools/approval)。

## 完整示例

```ts
import { FusionAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new FusionAgent({
  systemPrompt: '你是一个经验丰富的软件工程师。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: BUILTIN_TOOLS,

  routing: 'auto',
  planConfirmation: 'always',
  reflection: 'post-hoc',
  memoryReflection: 'post-hoc',
  maxIterations: 20,
})

const answer = await agent.run(
  '请分析这个项目的代码质量，找出 5 个最重要的改进点，并按优先级排序。'
)
console.log(answer)
```

### 流式输出

`stream()` 路由和 Plan 阶段快速输出，执行阶段逐 token 流式输出，全程实时可见：

```ts
for await (const chunk of agent.stream('请分析项目代码质量')) {
  process.stdout.write(chunk)
  // 输出示例：
  //   [Route: complex — 需要多步骤分析和工具调用]
  //   ## Plan
  //   1. ...
  //   [逐 token 执行过程...]
}
```

## 什么时候用 Fusion？

✅ **适合**:
- 不知道任务复杂度的通用场景
- 希望 Agent 自动选择最优策略
- 需要质量保证（反思）的关键任务
- 需要人机协作确认的任务

❌ **不适合**:
- Token 极度敏感的轻量任务 → 使用 [ReAct Agent](/core/react-agent)
- 明确只需要简单执行的场景 → 使用 [ReAct Agent](/core/react-agent)

## 下一步

- [Orchestrator Agent](/core/orchestrator-agent) — 多代理并行编排
- [Reflection 反思](/advanced/reflection) — 深入了解反思机制
- [Memory 记忆](/advanced/memory) — 长期记忆系统
- [Eval 评估](/advanced/eval) — 评估 Agent 执行质量
