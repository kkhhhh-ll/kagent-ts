# Reflection 反思

Reflection 系统让 Agent 在执行完成后**自动启动两个子 Agent 并行反思**：
- **错题本**（Error Reflection）— 分析执行过程，识别错误和优化机会
- **记忆提取**（Memory Extraction）— 提取用户约束、项目决策、风格偏好等长期记忆

两者都以 **Fork 子 Agent** 的形式运行——拥有独立的上下文和只读工具（`read_file`、`grep_search`），不污染主 Agent 的上下文。

## 架构

```text
Agent 执行完成
  ↓
ReflectionHook.onFinish()
  ├── Fork ErrorReflector (ReAct, max 4 turns)
  │     ├── 审查完整对话历史
  │     ├── 用 read_file / grep_search 验证发现
  │     ├── 评分 (0-100) + 分类问题 (7 个维度)
  │     └── 持久化 → ErrorNotebook
  │
  └── Fork MemoryReflector (ReAct, max 5 turns)
        ├── 审查完整对话历史
        ├── 用 read_file / grep_search 理解项目背景
        ├── 提取规则 / 项目事实 / 用户偏好
        └── 持久化 → MemoryManager
```

两个 Fork 通过 `Promise.all` 并行运行，一侧失败不影响另一侧。

## 通过 Hook 使用

推荐方式——任何 Agent 类型都可以通过 `createReflectionHook` 添加反思。`notebook` 和 `memoryManager` **独立可选**，可以按需组合。错题本和记忆提取可以各自使用**独立的 LLM**：

```ts
import {
  ReActAgent,
  OpenAIProvider,
  AnthropicProvider,
  ErrorNotebook,
  MemoryManager,
  createReflectionHook,
} from 'kagent-ts'

// 两个都要
const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })
const memory = new MemoryManager('.memory')

const hook = createReflectionHook({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),  // fallback
  reflectionLLM: new AnthropicProvider({                         // 可选：错题本专用
    apiKey: '...', model: 'claude-haiku-4-5-20251001',
  }),
  memoryLLM: new OpenAIProvider({                                // 可选：记忆提取专用
    apiKey: '...', model: 'gpt-4o-mini',
  }),
  notebook,                       // 可选：不传则跳过错题本反思
  memoryManager: memory,          // 可选：不传则跳过记忆提取
  maxErrorIterations: 4,          // 可选，默认 4
  maxMemoryIterations: 5,         // 可选，默认 5
  logger: new ConsoleLogger(),    // 可选，默认 ConsoleLogger
  onReflectionComplete: (entryCount, memoryCount) => {
    console.log(`反思完成: ${entryCount} 条发现, ${memoryCount} 条新记忆`)
  },
})

// 也可以只启用一个：
// createReflectionHook({ llm, notebook })            // 只要错题本
// createReflectionHook({ llm, memoryManager: mem })  // 只要记忆提取

// 通过 ModelRouter 集中管理
const router = new ModelRouter({
  main: new OpenAIProvider({ model: 'gpt-4o' }),
  reflection: new AnthropicProvider({ model: 'claude-haiku-4-5-20251001' }),
  memory: new OpenAIProvider({ model: 'gpt-4o-mini' }),
})
const hook2 = createReflectionHook({
  llm: router.forReflection(),          // fallback
  reflectionLLM: router.forReflection(),
  memoryLLM: router.forMemory(),
  notebook, memoryManager: memory,
})

const agent = new ReActAgent({
  llm: mainProvider,
  systemPrompt: '...',
  tools: BUILTIN_TOOLS,
  hooks: [hook],
})

// 执行完成后，hook 自动并行运行两个 Fork
const answer = await agent.run('用 kebab-case 命名所有文件')
// → 用户看到 answer
// → 后台 Fork 1: 找错 → notebook (使用 reflectionLLM)
// → 后台 Fork 2: 提取 "用户要求 kebab-case 命名" (rule) 或 "用户偏好 pnpm" (preference) → memory (使用 memoryLLM)
```

**LLM 决策优先级**（错题本）：显式 `reflectionLLM` → `llm` → 主模型
**LLM 决策优先级**（记忆提取）：显式 `memoryLLM` → `llm` → 主模型

## ReflectionAgent (错题本 Fork)

```ts
const reflector = new ReflectionAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  notebook: errorNotebook,
  maxIterations: 4,  // Fork 子 Agent 的最大 ReAct 迭代次数 (默认: 4)
  logger: new ConsoleLogger(),  // 可选
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

### 工作原理

`ReflectionAgent.reflect()` 内部不再直接调 `llm.chat()`，而是 Fork 一个最小的 `ReActAgent`：

- **独立上下文**：主对话历史以文本 dump 形式灌入一条 user message
- **只读工具**：`read_file` + `grep_search`，用于验证代码/文件
- **ReAct 循环**：子 Agent 自己走 Thought → Action → Observation 链
- **结构化输出**：最终 answer 是 JSON，宿主解析后持久化

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

## MemoryReflector (记忆提取 Fork)

```ts
const reflector = new MemoryReflector({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  memoryManager,
  maxIterations: 5,  // Fork 子 Agent 的最大 ReAct 迭代次数 (默认: 5)
  logger: new ConsoleLogger(),  // 可选
})

const memories = await reflector.reflect({
  userQuery: '用户的原始问题',
  finalAnswer: agentAnswer,
  conversation: contextMessages,
  sessionId: 'session-123',
})
// memories 为 Memory[]，已自动写入 MemoryManager
```

### 提取什么

| 记忆类型 | 说明 | 示例 |
|----------|------|------|
| `rule` | 用户明确要求的硬约束 | "始终用 kebab-case 命名文件" |
| `project` | 项目事实或架构决策 | "从 MySQL 迁移到 PostgreSQL，因为 JSONB 支持" |
| `preference` | LLM 观察到的用户习惯、风格偏好 | "用户喜欢简短直接的回答"、"用户偏好 pnpm 而非 npm" |

### 去重

`MemoryReflector` 在 Fork 前会查询已有记忆的 `name + description` 列表，注入到子 Agent 的 prompt 中，告诉它**不要重复创建同名记忆**。宿主侧还有防御性检查（`memoryManager.has(name)` 兜底）。

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

// 查询 — 按会话
const sessionEntries = notebook.getBySession('session-123')

// 查询 — 按类别
const misuseEntries = notebook.getByCategory('tool_misuse')

// 查询 — 最近条目
const recent = notebook.getRecent(10)

// 生成规则提示词（可注入到 system prompt）
// 注意：输出已自动包裹 untrusted-data 边界标记 + 注入签名扫描
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

## 在 Fusion Agent 中使用

Fusion Agent 内置了反思支持：

```ts
const agent = new FusionAgent({
  llm: mainProvider,
  // ...
  reflection: 'both',          // "off" | "post-hoc" | "inline" | "both"
  reflectionInterval: 3,       // 每 N 轮触发内省 (默认: 3)
  notebook,                    // ErrorNotebook 实例
})
```

详见 [Fusion Agent](/core/fusion-agent)。

## 和 Fusion Agent 的协同

当 `ReflectionHook` 和 Fusion Agent 的 `reflection` 配置**同时存在**时：
- Fusion Agent 自己处理 inline reflection
- `ReflectionHook` 的 `onFinish` 处理 post-hoc reflection + 记忆提取
- 两者互不干扰，各写各的

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
  ModelRouter,
  ErrorNotebook,
  MemoryManager,
  createReflectionHook,
} from 'kagent-ts'

const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })
const memory = new MemoryManager('.memory')

// 推荐：通过 ModelRouter 集中管理各子系统的模型
const router = new ModelRouter({
  main: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  reflection: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  memory: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
})

const agent = new ReActAgent({
  llm: router,
  systemPrompt: '你是一个经验丰富的软件工程师。',
  tools: BUILTIN_TOOLS,
  hooks: [
    createReflectionHook({
      llm: router.forReflection(),           // fallback
      reflectionLLM: router.forReflection(),  // 错题本专用
      memoryLLM: router.forMemory(),          // 记忆提取专用
      notebook,
      memoryManager: memory,
      onReflectionComplete: (e, m) => {
        console.log(`错题本 +${e}, 记忆 +${m}`)
      },
    }),
  ],
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

// 查看新提取的记忆
const recentMemories = memory.getAll()
for (const m of recentMemories) {
  console.log(`[${m.type}] ${m.name}: ${m.description}`)
}

// 生成经验规则（可注入到后续会话的 system prompt）
const rulesPrompt = notebook.buildRulesPrompt(10, 1)
```

## 追踪与调试

Reflection 的 fork 子 Agent 运行在独立上下文中，控制台默认只看到 fork 的启动和完成日志。通过 `TraceLogger` 可以完整记录 fork 内部的工具调用和 LLM 交互。

### 基本用法

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS,
  TraceLogger, ErrorNotebook, MemoryManager,
  createReflectionHook,
} from "kagent-ts"

const trace = new TraceLogger({ sessionId: "reflection-demo" })

const notebook = new ErrorNotebook({ storageDir: ".error-notebook" })
const memory = new MemoryManager(".memory")

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: "...", model: "gpt-4o" }),
  tools: BUILTIN_TOOLS,
  hooks: [
    trace,   // ← 主 Agent 事件
    createReflectionHook({
      llm: new OpenAIProvider({ apiKey: "...", model: "gpt-4o" }),
      reflectionLLM: new OpenAIProvider({ apiKey: "...", model: "gpt-4o" }),   // 可选
      memoryLLM: new OpenAIProvider({ apiKey: "...", model: "gpt-4o-mini" }),  // 可选
      notebook,
      memoryManager: memory,
      hooks: [trace],  // ← 透传到两个 fork 内部
    }),
  ],
})

await agent.run("重构 src/core/agent.ts")
// → .kagent-traces/trace-reflection-demo.html
//   时间线包含：主 Agent + 错题本 Fork + 记忆提取 Fork
```

### Trace 文件结构

打开生成的 HTML 文件，页面分为三个独立区域：

- **主 Agent 时间线**：Thought、LLM 调用、工具调用、Final Answer
- **🔀 Fork Agents**（折叠区）：
  - `error-reflection` fork：`read_file` / `grep_search`、LLM token 消耗、JSON 输出（评分 + 问题分类）
  - `memory-extraction` fork：工具调用、LLM 交互、提取到的 memory 列表
- **🤖 Sub-Agents**（折叠区，如果有的话）：`spawn_subagent` 派生的子 Agent

两个 fork 各自标记 `kind: "fork"`，与 sub-agent（`kind: "subagent"`）分区域展示，不会混在一起。

### 取消 / 超时时的轨迹

两个 Fork 各自有 5 分钟 AbortController 硬超时。即使超时取消，TraceLogger 仍会通过 `addChildTrace` + 自动 `flush()` 将取消前的完整事件推入父 trace 并刷新 HTML 文件。

## 最佳实践

1. **错题本反思使用不同的模型**：用与主 Agent 不同的模型（如 Claude Haiku / GPT-4o-mini）可获得独立审查视角
2. **记忆提取使用轻量模型**：记忆提取是模式识别任务，用 GPT-4o-mini 级别即可
3. **合理设置 maxIterations**：错题本 3-4 足够，记忆提取可稍多（4-5）
4. **定期审查**：错题本和记忆都是跨 session 积累的，定期清理过时内容
5. **结合 Eval**：反思结果可以作为 Eval 评估的输入
6. **Fork 失败不阻塞主流程**：反思和记忆提取都是 best-effort，失败以 `error` 级别记录日志。每个 Fork 有 5 分钟 AbortController 硬超时——超时后真正中止 LLM HTTP 请求，而非让后台继续消耗 API 配额。
7. **TraceLogger 可查看子 Agent 轨迹**：通过 `hooks` 参数将 TraceLogger 透传到 fork 内部，fork 的工具调用和 LLM 交互都会出现在 trace HTML 文件中。
8. **使用 ModelRouter 集中管理**：将所有 route（main / reflection / memory / precipitation）集中在一个 `ModelRouter` 中，Agent 和 Hook 各自取对应的 route。

## 下一步

- [Fork — Agent 派生](/core/fork) — 反思子 Agent 使用的轻量派生机制
- [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能
- [Memory 记忆](/advanced/memory) — MemoryManager 和长期记忆
- [Eval 评估](/advanced/eval) — 评估 Agent 执行质量
- [Fusion Agent](/core/fusion-agent) — 内置反思的 Agent 范式
- [Trace 追踪](/advanced/trace) — 执行追踪提供反思的素材
