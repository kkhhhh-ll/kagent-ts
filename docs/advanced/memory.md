# Memory 记忆

kagent-ts 的 Memory 系统提供基于文件的**长期记忆**能力。Agent 可以在会话之间保存和检索重要信息。

## 工作原理

Memory 系统使用 `MEMORY.md` 索引文件 + 独立 Markdown 记忆文件：

```
.memory/
├── MEMORY.md              # 索引文件
├── user-prefers-pnpm.md   # 记忆 1
├── project-structure.md   # 记忆 2
└── ...
```

每条记忆是一个独立的 Markdown 文件，包含 frontmatter 元数据：

```markdown
---
name: user-prefers-pnpm
description: 用户偏好使用 pnpm 作为包管理器
metadata:
  type: user
  created: 2024-01-15
---

用户更习惯使用 pnpm，在新项目中应使用 pnpm 而非 npm 或 yarn。

**Why:** 个人偏好
**How to apply:** 在执行初始化或安装依赖操作时使用 `pnpm` 命令
```

## 基本用法

### 在 Agent 中使用

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [
    ...BUILTIN_TOOLS,
    createRememberTool(memoryManager),  // LLM 可调用的记忆写入工具
    createRecallTool(memoryManager),    // LLM 可调用的记忆检索工具
  ],
  memoryConfig: {
    directory: './.memory',
  },
})
```

### 直接使用 MemoryManager

```ts
import { MemoryManager } from 'kagent-ts'

const memory = new MemoryManager('./.memory')

// 写入记忆
await memory.remember({
  name: 'api-base-url',
  description: '项目 API 基础 URL',
  fact: '生产环境 API 地址为 https://api.example.com/v2',
  type: 'project',
})

// 检索记忆
const facts = await memory.recall('API 地址')

// 列出所有记忆
const all = await memory.list()

// 删除记忆
await memory.forget('api-base-url')
```

## 自动记忆提取

除了让 LLM 手动调用 `remember` 工具，你还可以使用 `MemoryReflector`，在每次 Agent 执行完后自动分析对话并提取长期记忆：

```ts
import { MemoryReflector, MemoryManager } from 'kagent-ts'

const memory = new MemoryManager('.memory')

const reflector = new MemoryReflector({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  memoryManager: memory,
  maxIterations: 5,           // Fork 子 Agent 的最大 ReAct 迭代 (默认: 5)
})

// 在 Agent 执行完成后调用
const newMemories = await reflector.reflect({
  userQuery: '用户原始问题',
  finalAnswer: agentAnswer,
  conversation: messages,
  sessionId: 'session-123',
})
// 新记忆已自动写入 MemoryManager

// 或者通过 createReflectionHook 自动集成
import { createReflectionHook, ErrorNotebook } from 'kagent-ts'

const hook = createReflectionHook({
  llm,
  notebook: new ErrorNotebook(),
  memoryManager: memory,      // 同时提取错题本和记忆
})
```

`MemoryReflector` Fork 一个独立的子 Agent，拥有只读工具（`read_file`、`grep_search`），会审查对话历史并提取值得跨 session 保留的规则和项目事实。已有的同名记忆会自动跳过。

详见 [Reflection 反思](/advanced/reflection)。

## 记忆类型

```ts
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

interface MemoryEntry {
  /** 唯一标识 (kebab-case) */
  name: string

  /** 简短描述 (用于召回时的相关性判断) */
  description: string

  /** 元数据 */
  metadata: {
    type: MemoryType
    created: string
    updated?: string
  }

  /** 记忆内容 (支持 Markdown) */
  content: string
}
```

| 类型 | 用途 | 示例 |
|------|------|------|
| `user` | 用户偏好、习惯 | "用户偏好 pnpm" |
| `feedback` | 用户给 Agent 的反馈 | "代码审查时更关注安全" |
| `project` | 项目特定信息 | "API 基础 URL" |
| `reference` | 外部参考资源 | "MCP 协议文档链接" |

## 关联记忆

记忆文件之间可以相互引用：

```markdown
---
name: user-prefers-pnpm
description: 用户偏好使用 pnpm
metadata:
  type: user
---

用户更习惯使用 pnpm。相关记忆: [[project-node-version]] [[ci-pipeline-config]]
```

`[[name]]` 语法创建记忆之间的链接，帮助构建知识网络。

## 与 Agent 集成

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider,
  tools: [
    ...BUILTIN_TOOLS,
    createRememberTool(memoryManager),
    createRecallTool(memoryManager),
  ],
})

// Agent 执行过程中：
// 1. LLM 遇到需要记住的信息 → 调用 remember 工具
// 2. LLM 需要上下文信息 → 调用 recall 工具
// 3. 记忆自动持久化到 .memory/ 目录
```

## 最佳实践

1. **使用描述性的 name**: `user-prefers-pnpm` 优于 `fact-1`
2. **关联相关记忆**: 使用 `[[name]]` 建立链接
3. **分类清晰**: 正确选择 type (user/feedback/project/reference)
4. **及时清理**: 删除过时或错误的记忆
5. **Why 和 How**: 在 content 中说明原因和应用方式

## 下一步

- [Reflection 反思](/advanced/reflection) — 自动记忆提取和错题本机制
- [RAG 知识库](/advanced/rag) — 大规模文档语义检索（与 Memory 互补）
- [Skill 渐进式技能](/advanced/skills) — 另一个知识注入机制
- [Project Rules](/advanced/security) — 项目规则管理
- [Preferences](/guide/configuration) — 用户偏好配置
