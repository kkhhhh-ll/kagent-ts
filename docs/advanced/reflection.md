# Reflection 反思

Reflection 系统让 Agent 在执行完成后**自我反思**，识别问题、提取经验教训，并将发现记录到持久化的 **Error Notebook** 中。

## 架构

```text
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
  ErrorNotebook,
  createReflectionHook,
} from 'kagent-ts'

// 创建错题本
const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })

// 创建反思 Hook（内部自动创建 ReflectionAgent）
const reflectionHook = createReflectionHook({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  notebook,
})

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
  llm: reflectionProvider,      // LLM Provider (推荐使用高性能模型)
  notebook: errorNotebook,
  maxIterations: 3,             // 最大精炼迭代 (默认: 3)
})

// 反思一个会话
const entries = await reflectionAgent.reflect({
  userQuery: '用户的原始问题',
  finalAnswer: agentAnswer,
  conversation: contextMessages,
  sessionId: 'session-123',
})
// entries 为 ErrorNotebookEntry[]，已自动写入 notebook
```

### 反思输入与输出

```ts
// reflect() 的输入
interface ReflectionInput {
  userQuery: string              // 用户原始问题
  finalAnswer: string            // Agent 最终回答
  conversation: MessageData[]    // 完整对话消息
  errorTraces?: ToolErrorTrace[] // 工具错误追踪（可选）
  sessionId: string              // 会话 ID
}

// reflect() 返回 ErrorNotebookEntry[]，已自动写入 notebook

// 单条发现
interface ReflectionFinding {
  category: ReflectionErrorCategory  // 错误类别
  description: string                // 问题描述
  cause: string                      // 根因分析
  suggestion: string                 // 改进建议
  relatedTraceIds?: string[]         // 关联的工具错误 trace
}

type ReflectionErrorCategory =
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
const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })

// 添加条目
notebook.add({
  sessionId: 'session-123',
  category: 'tool_misuse',
  description: '多次使用 GrepSearchTool 但未指定 glob 过滤',
  cause: 'LLM 不知道可以通过 glob 参数过滤文件类型',
  suggestion: '在搜索代码时指定 glob: "*.ts" 以提高搜索精度',
})

// 查询 — 按会话
const sessionEntries = notebook.getBySession('session-123')

// 查询 — 按类别
const misuseEntries = notebook.getByCategory('tool_misuse')

// 查询 — 最近条目
const recent = notebook.getRecent(10)

// 生成规则提示词（可注入到 system prompt）
const rulesPrompt = notebook.buildRulesPrompt(10, 1)
```

### 存储结构

```text
.error-notebook/
├── index.json              # 索引文件 (所有条目的元数据)
├── entry_001.json          # 独立条目文件
├── entry_002.json
└── ...
```

## 迭代式精炼

`ReflectionAgent` 支持多轮迭代精炼：

```text
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

const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })

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
const entries = notebook.getRecent(10)
for (const entry of entries) {
  console.log(`[${entry.category}] ${entry.description}`)
  console.log(`  原因: ${entry.cause}`)
  console.log(`  → ${entry.suggestion}`)
}

// 生成经验规则（可注入到后续会话的 system prompt）
const rulesPrompt = notebook.buildRulesPrompt(10, 1)
console.log(rulesPrompt)
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
