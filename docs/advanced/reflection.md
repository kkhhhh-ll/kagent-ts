# Reflection 反思

Reflection 系统让 Agent 在会话结束后**自动 Fork 子 Agent 进行反思**：
- **错题本**（Error Reflection）— 分析执行过程，识别错误和优化机会
- **记忆提取**（Memory Extraction）— 提取用户约束、项目决策、风格偏好等长期记忆

两者都以 **Fork 子 Agent** 的形式运行——拥有独立的上下文和只读工具（`read_file`、`grep_search`），不污染主 Agent 的上下文。

## 架构

```text
Agent 产出 answer
  ↓
verification (如果开启) → VerifyAgent Fork（阻塞）
  │     ├── 审查正确性 / 完整性 / 一致性
  │     ├── score < threshold → 注入反馈 → 一次 LLM 修正
  │     └── 返回验证/修正后的答案
  ↓
fireOnFinish(verifiedAnswer)
  ├── precipitation (如果开启) → 技能提取（fire-and-forget）
  ├── memoryReflection (如果开启) → MemoryReflector Fork（fire-and-forget）
  │     ├── 审查完整对话历史
  │     ├── 用 read_file / grep_search 理解项目背景
  │     ├── 提取规则 / 项目事实 / 用户偏好
  │     └── 持久化 → MemoryManager (.memory/)
  │
  └── reflection (如果开启) → ReflectionAgent Fork（fire-and-forget）
        ├── 审查完整对话历史
        ├── 用 read_file / grep_search 验证发现
        ├── 分类问题 (7 个维度)
        └── 持久化 → ErrorNotebook (.error-notebook/)
```

- **Verification 阻塞**：验证 → 修正 → 确保用户拿到经过质量检查的答案
- **其余全部 fire-and-forget**：Precipitation、MemoryReflection、Reflection 均不阻塞主流程，失败静默跳过

## 快速开始

错题本反思和记忆提取已内建到 Agent 中，通过 AgentConfig 直接开启，无需额外 Hook：

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS,
  ErrorNotebook,
} from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  reflection: "post-hoc",         // 开启错题本反思
  memoryReflection: "post-hoc",   // 开启记忆提取
  notebook: new ErrorNotebook(),  // 可选，不传自动创建
})
```

ReActAgent、PlanSolveAgent、FusionAgent 均支持，配置方式完全一致。

## 错题本反思

```ts
const agent = new ReActAgent({
  llm: myLLM,
  reflection: "post-hoc",
  reflectionMaxIterations: 4,  // Fork 子 Agent 的最大 ReAct 迭代次数 (默认: 4)
  notebook: new ErrorNotebook({ storageDir: '.error-notebook' }),  // 可选
})
```

### 反思维度

| 维度 | 说明 |
|------|------|
| `reasoning_error` | 推理逻辑错误 |
| `tool_misuse` | 用错工具或参数 |
| `missed_optimization` | 遗漏的优化机会 |
| `incomplete_answer` | 答案不完整 |
| `hallucination` | 编造事实或 API |
| `context_mismanagement` | 上下文管理失误 |
| `other` | 其他 |

### 工作原理

内部 Fork 一个最小的 `ReActAgent`：

- **独立上下文**：主对话历史以文本 dump 形式灌入一条 user message
- **只读工具**：`read_file` + `grep_search`，用于验证代码/文件
- **ReAct 循环**：子 Agent 自己走 Thought → Action → Observation 链
- **结构化输出**：最终 answer 是 JSON，宿主解析后持久化
- **5 分钟硬超时**：AbortController 确保不浪费 API 配额

## 记忆提取

```ts
const agent = new ReActAgent({
  llm: myLLM,
  memoryReflection: "post-hoc",
  memoryReflectionMaxIterations: 5,  // Fork 子 Agent 的最大 ReAct 迭代次数 (默认: 5)
  memoryReflectorLLM: cheapLLM,      // 可选：单独为记忆提取指定模型
})
```

### 提取什么

| 记忆类型 | 说明 | 示例 |
|----------|------|------|
| `rule` | 用户明确要求的硬约束 | "始终用 kebab-case 命名文件" |
| `project` | 项目事实或架构决策 | "从 MySQL 迁移到 PostgreSQL，因为 JSONB 支持" |
| `preference` | LLM 观察到的用户习惯、风格偏好 | "用户喜欢简短直接的回答"、"用户偏好 pnpm 而非 npm" |

### 去重

Fork 前会查询已有记忆的 `name + description` 列表，注入到子 Agent 的 prompt 中。宿主侧还有防御性检查（`memoryManager.has(name)` 兜底）。

### 手动使用 MemoryReflector

```ts
const reflector = new MemoryReflector({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  memoryManager,
  maxIterations: 5,
})

const memories = await reflector.reflect({
  userQuery: '用户的原始问题',
  finalAnswer: agentAnswer,
  conversation: contextMessages,
  sessionId: 'session-123',
})
```

## 手动使用 ReflectionAgent

```ts
const reflector = new ReflectionAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  notebook: errorNotebook,
  maxIterations: 4,
})

const entries = await reflector.reflect({
  userQuery: '用户的原始问题',
  finalAnswer: agentAnswer,
  conversation: contextMessages,
  errorTraces?: toolErrorTraces,  // 可选，工具错误 trace
  sessionId: 'session-123',
})
// entries 为 ErrorNotebookEntry[]，已自动写入 notebook
```

## ErrorNotebook (错题本)

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

// 查询
const sessionEntries = notebook.getBySession('session-123')
const misuseEntries = notebook.getByCategory('tool_misuse')
const recent = notebook.getRecent(10)

// 生成规则提示词（可注入到 system prompt）
const rulesPrompt = notebook.buildRulesPrompt(10, 1)
```

### 存储结构

```text
.error-notebook/
├── index.json              # 索引文件 (所有条目的元数据)
├── entries/
│   ├── nb_xxx001.json      # 独立条目文件
│   ├── nb_xxx002.json
│   └── ...
```

## 通过 ModelRouter 管理模型

```ts
const router = new ModelRouter({
  main: new OpenAIProvider({ model: 'gpt-4o' }),
  reflection: new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' }),
  memory: new OpenAIProvider({ model: 'gpt-4o-mini' }),
})

const agent = new ReActAgent({
  llm: router,                            // main → gpt-4o
  reflection: "post-hoc",                 // 错题本 → 使用 router.forReflection() (claude-haiku)
  memoryReflection: "post-hoc",           // 记忆提取
  memoryReflectorLLM: router.forMemory(), // → gpt-4o-mini
})
```

## 完整示例

```ts
import {
  ReActAgent, OpenAIProvider, ModelRouter, BUILTIN_TOOLS,
  ErrorNotebook,
} from 'kagent-ts'

const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })

const router = new ModelRouter({
  main: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  memory: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
})

const agent = new ReActAgent({
  llm: router,
  systemPrompt: '你是一个经验丰富的软件工程师。',
  tools: BUILTIN_TOOLS,
  reflection: "post-hoc",
  memoryReflection: "post-hoc",
  memoryReflectorLLM: router.forMemory(),
  notebook,
})

// 执行任务——完成后自动运行错题本和记忆提取
await agent.run('重构 src/core/agent.ts，提高代码可读性。')

// 查看反思结果
const entries = notebook.getRecent(10)
for (const entry of entries) {
  console.log(`[${entry.category}] ${entry.description}`)
}
```

## 最佳实践

1. **错题本反思使用不同的模型**：通过 ModelRouter 的 `reflection` route 使用独立模型
2. **记忆提取使用轻量模型**：通过 `memoryReflectorLLM` 或 ModelRouter 的 `memory` route
3. **合理设置 maxIterations**：错题本 3-4 足够，记忆提取可稍多（4-5）
4. **定期审查**：错题本和记忆都是跨 session 积累的，定期清理过时内容
5. **Fork 失败不阻塞主流程**：全部 best-effort，每个 Fork 有 5 分钟 AbortController 硬超时
6. **notebook 按需配置**：不传 `notebook` 配置时自动创建（默认 `.error-notebook/` 目录）

## 下一步

- [Fork — Agent 派生](/core/fork) — 反思子 Agent 使用的轻量派生机制
- [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能
- [Memory 记忆](/advanced/memory) — MemoryManager 和长期记忆
- [Eval 评估](/advanced/eval) — 评估 Agent 执行质量
- [Fusion Agent](/core/fusion-agent) — 融合路由、规划与反思的 Agent 范式
