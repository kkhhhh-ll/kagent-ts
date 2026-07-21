# Memory 记忆

kagent-ts 的 Memory 系统提供基于文件的**长期记忆**能力。Agent 可以在会话之间保存和检索重要信息。

## 工作原理

Memory 系统使用 `MEMORY.md` 索引文件 + 独立 Markdown 记忆文件：

```
.k-memory/
├── MEMORY.md              # 索引文件（名称 + 摘要，< 200 行 / 25 KB）
├── use-kebab-case.md      # 记忆 1
├── migrate-to-pg.md       # 记忆 2
└── ...
```

每条记忆是一个独立的 Markdown 文件，包含 frontmatter 元数据：

```markdown
---
name: use-kebab-case
description: 用户要求使用 kebab-case 命名文件
type: rule
---

用户要求所有新文件使用 kebab-case 命名。

**Why:** 用户偏好统一的命名风格
**When:** 创建任何新文件或重命名现有文件时
```

## 记忆类型

kagent-ts 提供三种记忆类型：

```ts
type MemoryType = "rule" | "project" | "preference"
```

| 类型 | 用途 | 示例 |
| --- | --- | --- |
| `rule` | 用户**明确要求**的约束、规范 | "始终用 kebab-case 命名"、"组件用函数式写法" |
| `project` | 项目事实、架构决策 | "从 MySQL 迁移到了 PostgreSQL"、"API 基础地址为 https://api.example.com/v2" |
| `preference` | LLM **观察到的**用户习惯、风格偏好 | "用户喜欢简短直接的回答"、"用户偏好 pnpm 而非 npm" |

### 设计理念

`rule` 是用户**明确设定**的约束和规范——用户主动说了"必须这样做 / 不准那样做"。这些是硬性要求，Agent 严格遵守。

`project` 是项目级别的事实和决策——执行过程中沉淀下来的知识，帮助 Agent 理解项目背景。

`preference` 是 LLM **从对话中观察到的**用户习惯和风格偏好——用户没有明确说"这是规则"，但从多次交互中能看出稳定模式。这类记忆是软性的、可适应的，由 LLM 自动提取，无需用户手动管理。

**关键区别**：rule 是用户说"要这样"，preference 是 LLM 看出"用户喜欢这样"。不要把观察到的习惯放进 rule。

## 基本用法

### MemoryManager API

```ts
import { MemoryManager } from 'kagent-ts'

const memory = new MemoryManager('./.k-memory')

// 写入记忆（同名自动覆盖）
memory.add({
  name: 'api-base-url',
  description: '项目 API 基础 URL',
  type: 'project',
  content: '生产环境 API 地址为 https://api.example.com/v2\n\n**Why:** 统一配置管理\n**How to apply:** 所有 API 请求使用此地址',
})

// 检查是否存在
memory.has('api-base-url') // true

// 按名称读取
const m = memory.get('api-base-url')

// 获取全部记忆
const all = memory.getAll()

// 按类型筛选
const rules = memory.getByType('rule')
const projects = memory.getByType('project')

// 删除记忆
memory.remove('api-base-url')

// 记忆总数
console.log(memory.count)
```

### 通过 `remember` 工具让 LLM 写入

```ts
import { ReActAgent, OpenAIProvider, createRememberTool, createRecallTool } from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  systemPrompt: '你是一个有用的 AI 助手。',
  tools: [
    createRememberTool(memoryManager),  // LLM 可主动调用的记忆写入工具
    createRecallTool(memoryManager),    // LLM 可调用的记忆检索工具
  ],
})

// Agent 执行过程中：
// 1. LLM 遇到需要记住的信息 → 调用 remember 工具
// 2. LLM 需要上下文信息 → 调用 recall 工具
// 3. 记忆自动持久化到 .k-memory/ 目录
```

**冲突处理 — `supersedes` 参数：**

当用户纠正或推翻之前存储的记忆时，LLM 可以通过 `supersedes` 参数标记旧记忆，框架会自动删除它们：

```json
{
  "name": "use-camel-case",
  "type": "rule",
  "description": "用户要求使用 camelCase 命名文件",
  "content": "...",
  "supersedes": ["use-kebab-case"]
}
```

`supersedes` 中的记忆会被自动移除，确保旧约定不会在未来的会话中与新约定冲突。如果新旧记忆使用相同的 `name`，框架会自动覆盖（upsert），无需额外指定 `supersedes`。

### System Prompt 自动注入（BM25 检索）

Agent 在每次 `run()` 启动时，使用 **BM25 关键词检索** 自动匹配与当前查询最相关的记忆，并采用**两级披露**策略注入 System Prompt：

```
用户输入: "用 pnpm 装 React Router"
  → BM25 检索 → 命中 "use-pnpm-workspaces" (score: 5.17)
  → Tier 1: 注入完整内容（LLM 无需调用 recall）
  → Tier 2: 注入剩余记忆的名称索引（LLM 可按需 recall）
```

**Tier 1 — 相关记忆（BM25 自动匹配）**：得分最高的 ≤5 条记忆的完整 Markdown 内容直接注入，LLM 无需手动调用 `recall` 工具。

**Tier 2 — 全部记忆索引**：未被 BM25 匹配的记忆以紧凑的名称列表展示，LLM 可通过 `recall` 工具按需加载。

BM25 使用**双阈值过滤**防止噪音注入：
- **比值阈值**：得分低于最高分 10% 的结果被舍弃
- **绝对阈值**：得分低于 1.5 的结果被舍弃（确保只命中稀罕词，排除 `for`、`the` 等常见词）

```ts
// 内部集成，无需手动调用
// Agent.run() → matchInputContext() → retriever.retrieveMemories(input, 5) → buildMemoryPrompt()
```

> **安全提示：** `buildMemoryPrompt()` 和 `recall` 工具返回的内容均由框架自动进行安全防护：
> - **BM25 检索的记忆** — 自动包裹 `wrapUntrusted` + 注入签名扫描
> - **记忆索引** — 同上
> - **`recall` 工具** — 自动使用 `wrapAndScan`（注入扫描 + 边界包裹）
>
> 因为记忆是 LLM 写的，可能留下注入文本，下次运行时污染 system prompt。这些防护防止了自我污染。

## 自动记忆提取

除了让 LLM 手动调用 `remember` 工具，你还可以使用 `MemoryReflector`，在每次 Agent 执行完后自动分析对话并提取长期记忆：

```ts
import { MemoryReflector, MemoryManager } from 'kagent-ts'

const memory = new MemoryManager('.k-memory')

const reflector = new MemoryReflector({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),  // 记忆提取用轻量模型即可
  memoryManager: memory,
  maxIterations: 5,           // Fork 子 Agent 的最大 ReAct 迭代（默认: 5）
})

// 在 Agent 执行完成后调用
const newMemories = await reflector.reflect({
  userQuery: '用户原始问题',
  finalAnswer: agentAnswer,
  conversation: messages,
  sessionId: 'session-123',
})
// 新记忆已自动写入 MemoryManager

// 或者通过 AgentConfig 直接开启，内存提取在会话结束后自动运行
const agent = new ReActAgent({
  llm: mainProvider,
  memoryReflection: "post-hoc",          // 开启自动记忆提取
  memoryReflectorLLM: new OpenAIProvider({ // 记忆提取专用 LLM（可选）
    apiKey: '...', model: 'gpt-4o-mini',
  }),
})
```

**LLM 决策优先级**：显式 `memoryLLM` → `llm` → 主模型

`MemoryReflector` Fork 一个独立的子 Agent，拥有只读工具（`read_file`、`grep_search`），会审查对话历史并提取值得跨 session 保留的规则和项目事实。已有的同名记忆会自动跳过。

详见 [Reflection 反思](/advanced/reflection)。

## 关联记忆

记忆文件之间可以相互引用：

```markdown
---
name: user-prefers-pnpm
description: 用户偏好使用 pnpm
type: rule
---

用户更习惯使用 pnpm，在新项目中应使用 pnpm 而非 npm 或 yarn。
相关记忆：[[project-node-version]] [[ci-pipeline-config]]

**Why:** 个人偏好
**When:** 执行初始化或安装依赖操作时使用 `pnpm` 命令
```

`[[name]]` 语法创建记忆之间的链接，帮助构建知识网络。

## 存储限制与 LRU 淘汰

- 索引文件（`MEMORY.md`）上限：**200 行** 且 **25 KB**
- 超出限制时，框架按 **LRU（最近最少使用）** 策略自动淘汰：
  - 从未被 `recall` 过的记忆优先淘汰
  - 同一批未使用的记忆中，`lastRecalledAt` 最早的先删
  - 同一时间戳时按插入顺序（先插入的先删）
- 每次调用 `recall` 工具 **或 BM25 自动检索命中**时，对应记忆的 `lastRecalledAt` 会自动更新
- 单个记忆文件大小无硬性限制，但建议保持简洁

## 最佳实践

1. **使用描述性的 name**：`user-prefers-pnpm` 优于 `fact-1`
2. **name 使用 kebab-case**：小写字母 + 数字 + 连字符
3. **分类清晰**：用户约束/偏好用 `rule`，项目事实/决策用 `project`
4. **content 结构化**：`rule` 包含 `**Why:**` + `**When:**`，`project` 包含 `**Why:**` + `**How to apply:**`
5. **关联相关记忆**：使用 `[[name]]` 建立链接
6. **及时清理**：删除过时或错误的记忆

## 下一步

- [Reflection 反思](/advanced/reflection) — 自动记忆提取和错题本机制
- [RAG 知识库](/advanced/rag) — 大规模文档语义检索（与 Memory 互补）
- [AgentConfig](/guide/configuration) — 通过 `memoryReflection: "post-hoc"` 在 Agent 执行后自动触发记忆提取
