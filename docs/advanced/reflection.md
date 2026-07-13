# Reflection 反思

Reflection 系统让 Agent 在会话结束后**自动 Fork 子 Agent 进行反思**：
- **错题本**（Error Reflection）— 分析执行过程，识别错误和优化机会，按场景分类
- **记忆提取**（Memory Extraction）— 提取用户约束、项目决策、风格偏好等长期记忆

两者都以 **Fork 子 Agent** 的形式运行——拥有独立的上下文和只读工具（`read_file`、`grep_search`），不污染主 Agent 的上下文。

## 架构

```text
用户输入
  ↓
[Intent Recognition] detectSignals(input)（零 LLM 开销）
  ├── wantsRemember → 强制触发 Precipitation + MemoryReflection
  ├── riskLevel     → "none" / "low" / "high"（否定感知）
  ├── scenarios[]   → 多标签任务场景（0–N 个）
  └── complexity    → "simple" / "moderate" / "complex"
  ↓
Agent 产出 answer
  ↓
verification (如果开启) → VerifyAgent Fork（阻塞）
  ↓
fireOnFinish(verifiedAnswer)
  ├── precipitation (触发条件见下方) → 技能提取（fire-and-forget）
  ├── memoryReflection (触发条件见下方) → MemoryReflector Fork（fire-and-forget）
  │     ├── 审查完整对话历史
  │     ├── 提取规则 / 项目事实 / 用户偏好
  │     └── 持久化 → MemoryManager (.memory/)
  │
  └── reflection (如果开启) → ReflectionAgent Fork（fire-and-forget）
        ├── 审查完整对话历史
        ├── 分类问题 (7 个维度)
        ├── 绑定当前场景 scenarios[]（多标签）
        └── 持久化 → ErrorNotebook (.error-notebook/)
```

- **Verification 阻塞**：验证 → 修正 → 确保用户拿到经过质量检查的答案
- **其余全部 fire-and-forget**：Precipitation、MemoryReflection、Reflection 均不阻塞主流程，失败静默跳过

### 触发规则

| 后处理 | mode: "post-hoc" | wantsRemember 信号 | hard-won success (≥2 连败) |
|--------|-------------------|---------------------|---------------------------|
| **Precipitation** | ✅ | ✅（无视 mode） | ✅（需 mode !== "off"） |
| **MemoryReflection** | ✅ | ✅（无视 mode） | ❌ 不触发 |
| **Reflection** | ✅ | — | — |

> **wantsRemember 信号优先级最高**：用户说"记住 / save / 保存"等时，即使 mode 为 `"off"` 也会强制触发 Precipitation 和 MemoryReflection。
>
> **Precipitation 与 MemoryReflection 解耦**：连续工具失败后成功（hard-won success）仅触发 Precipitation（保存来之不易的解决方案），不触发 MemoryReflection（记忆提取与工具失败无关）。

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
  reflectionMaxIterations: 6,  // Fork 子 Agent 的最大 ReAct 迭代次数 (默认: 6)
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
- **场景绑定**：每个条目自动绑定当前任务的场景标签（多标签），后续同类任务可精确召回

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
  scenarios: ['debugging', 'code-write'],  // 多标签场景（可选）
})
// entries 为 ErrorNotebookEntry[]，已自动写入 notebook
```

## ErrorNotebook (错题本)

### 基本用法

```ts
const notebook = new ErrorNotebook({ storageDir: '.error-notebook' })

// 添加条目
notebook.add({
  sessionId: 'session-123',
  category: 'tool_misuse',
  scenarios: ['file-search', 'code-write'],
  description: '多次使用 GrepSearchTool 但未指定 glob 过滤',
  cause: 'LLM 不知道可以通过 glob 参数过滤文件类型',
  suggestion: '在搜索代码时指定 glob: "*.ts" 以提高搜索精度',
})

// 查询
const sessionEntries = notebook.getBySession('session-123')
const misuseEntries = notebook.getByCategory('tool_misuse')
const recent = notebook.getRecent(10)
const debuggingEntries = notebook.getByScenario('debugging')

// 场景过滤提示词（可在 System Prompt 中注入相关错题）
const prompt = notebook.buildScenarioPrompt(['debugging', 'code-write'], 5, 1)
```

### 场景过滤

错题本条目以 **多标签场景**（`scenarios: AgentScenario[]`）存储。运行时 `buildScenarioPrompt()` 接受 `AgentScenario[]`，返回匹配**任一**当前场景的错题提示词：

```ts
// Agent 基类 buildSystemPrompt() 中自动调用：
// 只有与当前任务场景相关的历史错误才会注入
this.notebook.buildScenarioPrompt(this.inputSignals.scenarios, 5, 1);
```

- 无场景匹配 → 零注入，不浪费 token
- 多场景匹配 → 取相关度最高的 maxEntries 条

### 存储结构

采用 markdown frontmatter 格式，与 memory 系统一致：

```text
.error-notebook/
├── README.md            # 轻量索引（markdown 链接列表，含场景标签）
└── entries/
    ├── nb_xxx.md        # 独立条目文件（YAML frontmatter + markdown body）
    ├── nb_yyy.md
    └── ...
```

条目文件格式：

```markdown
---
id: nb_abc123
sessionId: sess_xyz
timestamp: 2026-07-13T10:30:00.000Z
category: tool_misuse
description: 多次使用 GrepSearch 但未指定 glob 过滤
scenarios: file-search, code-write
userQuery: 帮我找一下 auth 模块里所有用到 jwt 的地方
---

## Cause

LLM 不知道可以通过 glob 参数过滤文件类型...

## Suggestion

在搜索代码时指定 glob: "*.ts" 以提高搜索精度...
```

索引行格式：

```markdown
- [🔧 Tool Misuse] 多次使用 GrepSearch 但未指定 glob 过滤 (`nb_abc123` — sess_xyz) 🔍[file-search] ✏️[code-write]
```

### 提示注入防御

错题本内容由 LLM 生成，存在自我投毒风险。`buildRulesPrompt()` 和 `buildScenarioPrompt()` 内建两层防御：

1. **注入签名检测** — `detectInjectionSignatures()` 扫描 LLM 生成的文本
2. **不可信数据包裹** — `wrapUntrusted("error-notebook", body)` 将内容标注为不可信来源

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
7. **场景标签确保精确召回**：当前任务的场景信号（`scenarios`）会绑定到每个反思条目，后续同类任务只注入相关历史错误

## 下一步

- [Intent Recognition 意图识别](/advanced/intent) — 信号检测、场景识别、风险分级
- [Fork — Agent 派生](/core/fork) — 反思子 Agent 使用的轻量派生机制
- [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能
- [Memory 记忆](/advanced/memory) — MemoryManager 和长期记忆
- [Eval 评估](/advanced/eval) — 评估 Agent 执行质量
- [Fusion Agent](/core/fusion-agent) — 融合路由、规划与反思的 Agent 范式
