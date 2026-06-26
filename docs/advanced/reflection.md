# Reflection 反思

Reflection 系统让 Agent 在执行完成后**自我反思**，识别问题、提取经验教训，并将发现记录到持久化的 **Error Notebook** 中。

## 架构

```
Agent 执行完成
  ↓
ReflectionAgent (反思代理)
  ├── 分析执行全过程
  ├── 评分 (0-100)
  ├── 分类问题 (7 个维度)
  └── 生成改进建议
  ↓
ErrorNotebook (错误笔记本)
  ├── 持久化存储
  ├── 按 Session 关联
  └── 提取规则/模式
```

## 配置反思

### 在 Fusion Agent 中使用

Fusion Agent 内置了反思支持：

```ts
const agent = new FusionAgent({
  // ...
  reflection: 'both',          // "off" | "post-hoc" | "inline" | "both"
  inlineReflectionInterval: 5, // 每 5 轮触发内省
})
```

详见 [Fusion Agent](/core/fusion-agent)。

### 通过 Hook 使用

任何 Agent 类型都可以通过 `createReflectionHook` 添加反思：

```ts
import {
  ReActAgent,
  OpenAIProvider,
  ReflectionAgent,
  ErrorNotebook,
  createReflectionHook,
} from 'kagent-ts'

// 创建反思基础设施
const notebook = new ErrorNotebook('./.error-notebook')
const reflectionAgent = new ReflectionAgent({
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  notebook,
})

// 创建反思 Hook
const reflectionHook = createReflectionHook(reflectionAgent)

const agent = new ReActAgent({
  systemPrompt: '...',
  provider: mainProvider,
  tools: BUILTIN_TOOLS,
  hooks: [reflectionHook],  // 执行完成后自动反思
})
```

## ReflectionAgent

```ts
const reflectionAgent = new ReflectionAgent({
  provider: reflectionProvider,  // LLM Provider (推荐使用高性能模型)
  notebook: errorNotebook,
  maxRefinementIterations: 3,     // 最大精炼迭代 (默认: 3)
})

// 反思一个会话
const result = await reflectionAgent.reflect(sessionState)
```

### 反思结果

```ts
interface ReflectionResult {
  /** 总分 (0-100) */
  score: number

  /** 各维度的发现 */
  findings: ReflectionFinding[]

  /** 总体评价 */
  summary: string

  /** 改进建议 */
  suggestions: string[]
}

interface ReflectionFinding {
  /** 问题类别 */
  category: ReflectionCategory

  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical'

  /** 描述 */
  description: string

  /** 改进建议 */
  recommendation: string
}

type ReflectionCategory =
  | 'reasoning_error'       // 推理错误
  | 'tool_misuse'           // 工具误用
  | 'missed_optimization'   // 遗漏的优化
  | 'incomplete_answer'     // 不完整的答案
  | 'hallucination'         // 幻觉
  | 'context_mismanagement' // 上下文管理失误
  | 'other'                 // 其他
```

## ErrorNotebook

```ts
const notebook = new ErrorNotebook('./.error-notebook')

// 添加条目
await notebook.add({
  sessionId: 'session-123',
  category: 'tool_misuse',
  description: '多次使用 GrepSearchTool 但未指定 glob 过滤',
  recommendation: '在搜索代码时指定 glob: "*.ts" 以提高搜索精度',
  timestamp: Date.now(),
})

// 查询
const entries = await notebook.query({
  sessionId: 'session-123',   // 按会话
  category: 'tool_misuse',     // 按类别
  limit: 10,
})

// 提取规则
const rules = await notebook.extractRules()
// 返回可从错误中提取的通用性规则
```

### 存储结构

```
.error-notebook/
├── index.json              # 索引文件 (所有条目的元数据)
├── entry_001.json          # 独立条目文件
├── entry_002.json
└── ...
```

## 迭代式精炼

`ReflectionAgent` 支持多轮迭代精炼：

```
第 1 轮: 初步分析 → score: 65
  ↓
第 2 轮: 针对问题区域深入 → score: 72
  ↓
第 3 轮: 最终精炼 → score: 78
  ↓
最终结果
```

每轮迭代都会让 LLM 重新审视之前的分析，以提高反思质量。

## 完整示例

```ts
import {
  FusionAgent,
  ModelRouter,
  AnthropicProvider,
  OpenAIProvider,
  ErrorNotebook,
} from 'kagent-ts'

const notebook = new ErrorNotebook('./.error-notebook')

const agent = new FusionAgent({
  systemPrompt: '你是一个经验丰富的软件工程师。',
  provider: new ModelRouter({
    routes: {
      main: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
      reflection: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
    },
  }),
  tools: BUILTIN_TOOLS,
  reflection: 'both',
  inlineReflectionInterval: 5,
})

// 执行任务
await agent.run('重构 src/core/agent.ts，提高代码可读性。')

// 查看反思结果
const entries = await notebook.query({ limit: 10 })
for (const entry of entries) {
  console.log(`[${entry.category}] ${entry.description}`)
  console.log(`  → ${entry.recommendation}`)
}

// 提取经验规则
const rules = await notebook.extractRules()
console.log('提取的规则:', rules)
```

## 最佳实践

1. **反思使用高性能模型**: 推荐 GPT-4o 或 Claude Sonnet 用于反思
2. **定期审查 ErrorNotebook**: 积累的经验对长期改进有价值
3. **结合 Eval**: 反思结果可以作为 Eval 评估的输入
4. **不要太频繁**: Post-hoc 反思每任务一次，Inline 反思间隔不要太短

## 下一步

- [Eval 评估](/advanced/eval) — 评估 Agent 执行质量
- [Fusion Agent](/core/fusion-agent) — 内置反思的 Agent 范式
- [Trace 追踪](/advanced/trace) — 执行追踪提供反思的素材
