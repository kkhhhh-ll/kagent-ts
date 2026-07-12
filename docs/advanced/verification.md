# Verification 答案验证

Verification 系统在 Agent 产出答案后、返回给用户前，**自动 Fork 独立 Agent 验证答案的正确性和完整性**。

与其他后处理（Reflection、Precipitation、Memory）不同——Verification 是 **阻塞式** 的：验证不通过时会将问题反馈注入上下文，让 Agent 修正后再返回，确保用户最终拿到的是验证过的答案。

## 与其他后处理的区别

| 特性 | Verification | Reflection | Precipitation | Memory |
|------|-------------|------------|---------------|--------|
| 执行时机 | 答案返回前 | 答案返回后 | 答案返回后 | 答案返回后 |
| 阻塞主流程 | ✅ 是 | ❌ 否 | ❌ 否 | ❌ 否 |
| 失败时行为 | 返回修正后答案 | 静默跳过 | 静默跳过 | 静默跳过 |
| 默认状态 | off | off | off | off |

## 架构

```text
Agent 产出 answer
  ↓
runVerification(input, answer)  ← 阻塞，等待完成
  ├── Fork VerifyAgent（独立 LLM，只读工具）
  │     ├── 审查正确性 / 完整性 / 一致性 / 可执行性
  │     └── 返回 { valid, score, issues, assessment }
  │
  ├── score >= threshold → 直接返回 answer
  │
  └── score < threshold → 注入问题反馈
        ├── 一次 LLM 调用（无工具）修正答案
        ├── 成功 → 返回修正后答案
        └── 失败 → 返回原答案 + 验证标注
```

验证超时或异常时不会阻塞——原答案直接返回。

## 快速开始

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS,
} from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  verification: "post-hoc",      // 开启答案验证
  verificationThreshold: 70,     // 及格线 70 分（默认）
})

const answer = await agent.run('修复登录模块的 bug')
// answer 已通过验证（或已修正）
```

ReActAgent、PlanSolveAgent、FusionAgent 均支持，配置方式完全一致。

## 配置选项

```ts
const agent = new ReActAgent({
  llm: myLLM,

  // 开启验证
  verification: "post-hoc",

  // 验证子 Agent 的最大 ReAct 迭代次数（默认: 3）
  verificationMaxIterations: 3,

  // 及格线：低于此分数触发修正（默认: 70）
  verificationThreshold: 70,

  // 独立 LLM：不配时复用主模型或 ModelRouter.forVerification()
  verificationLLM: new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' }),
})
```

### 验证维度

| 维度 | 说明 |
|------|------|
| **正确性** | 是否有事实错误、无效代码、错误声明 |
| **完整性** | 是否完整回答了用户的问题，有无遗漏 |
| **一致性** | 答案内部是否矛盾，是否与用户要求冲突 |
| **可执行性** | 如果要求做了某事，是否真的完成了 |

### 验证结果结构

```ts
interface VerificationResult {
  valid: boolean      // 是否通过验证（score >= threshold 且无严重问题）
  score: number        // 0-100 质量评分
  issues: string[]     // 具体问题列表
  assessment: string   // 简要评估说明
}
```

## 手动使用 VerifyAgent

```ts
import { VerifyAgent } from 'kagent-ts'

const verifier = new VerifyAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  threshold: 70,
  maxIterations: 3,
})

const result = await verifier.verify({
  userQuery: '修复登录模块的 bug',
  answer: '我修改了 auth.ts 中的验证逻辑...',
})

console.log(result.score)    // 92
console.log(result.issues)   // []
console.log(result.valid)    // true
```

## 通过 ModelRouter 管理模型

推荐为验证使用独立模型，获得无偏见的审查视角：

```ts
const router = new ModelRouter({
  main: new OpenAIProvider({ model: 'gpt-4o' }),
  verification: new AnthropicProvider({ model: 'claude-sonnet-4-6' }),
})

const agent = new ReActAgent({
  llm: router,
  verification: "post-hoc",
  // verificationLLM 未显式设置 → 自动使用 router.forVerification()
})
```

## 完整示例

```ts
import {
  ReActAgent, OpenAIProvider, AnthropicProvider,
  ModelRouter, BUILTIN_TOOLS,
} from 'kagent-ts'

const router = new ModelRouter({
  main: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  verification: new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' }),
})

const agent = new ReActAgent({
  llm: router,
  systemPrompt: '你是一个经验丰富的软件工程师。',
  tools: BUILTIN_TOOLS,
  verification: "post-hoc",
  verificationThreshold: 75,
})

// 答案会在返回前自动验证
const answer = await agent.run('实现一个 LRU 缓存，需要线程安全。')

// 如果验证发现线程安全问题，Agent 会自动修正后再返回
```

## 最佳实践

1. **使用独立模型**：通过 ModelRouter 的 `verification` route 使用不同于主循环的模型，获得独立审查视角
2. **合理设置阈值**：生产环境建议 70-80，对关键任务可提高至 85+
3. **maxIterations 不宜过大**：验证子 Agent 只做审查不做事，3 次迭代足够
4. **验证不影响用户体验**：验证 + 修正通常在 5-10 秒内完成，远优于返回错误答案
5. **超时保护**：Verification 有 3 分钟 AbortController 硬超时，超时后直接返回原答案
6. **与其他后处理配合**：Verification 在 Reflection/Precipitation/Memory 之前运行，确保这些后处理拿到的是验证过的答案

## 下一步

- [Reflection 反思](/advanced/reflection) — 错题本反思与记忆提取
- [Fork — Agent 派生](/core/fork) — 验证子 Agent 使用的轻量派生机制
- [Model Router](/llm/model-router) — 集中管理不同任务的模型路由
- [Fusion Agent](/core/fusion-agent) — 融合路由、规划、验证与反思的 Agent 范式
