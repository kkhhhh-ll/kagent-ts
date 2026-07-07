# Sub-Agent 子代理

Sub-Agent 系统允许你将复杂任务**委派给专门的子代理**，实现并行处理和专业分工。

## 架构

```
Main Agent
  ↓ 委派任务
SubAgentManager
  ├── SubAgent 1: code-reviewer   → 审查代码质量
  ├── SubAgent 2: test-writer     → 编写测试
  └── SubAgent 3: doc-generator   → 生成文档
  ↓ 轮询结果
Main Agent
  ↓ 合成答案
Final Answer
```

## 定义子代理

### AGENT.md 文件

每个子代理通过 `AGENT.md` 文件定义：

```
subagents/
├── code-reviewer/
│   └── AGENT.md
├── test-writer/
│   └── AGENT.md
└── doc-generator/
    └── AGENT.md
```

### AGENT.md 格式

```markdown
---
name: code-reviewer
description: 审查 TypeScript 代码质量，识别潜在问题和改进点
tools:
  - ReadFileTool
  - GrepSearchTool
  - GlobSearchTool
---

你是一个资深的 TypeScript 代码审查专家。在审查代码时：

1. 检查类型安全性
2. 检查错误处理
3. 识别性能瓶颈
4. 评估代码可读性
5. 检查安全漏洞

请输出结构化的审查报告：每个问题标注严重程度、文件位置和改进建议。
```

### 工具名通配符

`tools` 字段支持 `*` 通配符，可以一次性匹配多个工具名。这对 MCP Server 特别有用——一个 Server 常常暴露十几个工具，逐个列出很繁琐：

```markdown
---
name: file-worker
description: 处理所有文件系统操作
tools:
  - filesystem_*       # 匹配 filesystem_read_file, filesystem_write_file, ...
  - echo               # 精确匹配单个工具
---
```

匹配规则：

| Pattern | 匹配 |
| ------- | ---- |
| `filesystem_*` | 所有以 `filesystem_` 开头的工具 |
| `*_read` | 所有以 `_read` 结尾的工具 |
| `*` | 主 ToolRegistry 中的全部工具 |
| `echo` | 精确匹配（无 `*` 时保持原有行为） |

多个 pattern 匹配到同名工具时会**自动去重**；未匹配到任何工具的 pattern 会输出警告日志。

## 加载和管理子代理

```ts
import { SubAgentLoader, SubAgentManager } from 'kagent-ts'

// 方式 1: 从文件加载
const loader = new SubAgentLoader()
const definitions = await loader.loadFromDirectory('./subagents')

// 方式 2: 直接定义
const definitions = [
  {
    name: 'code-reviewer',
    description: '审查 TypeScript 代码质量',
    systemPrompt: '你是一个资深的 TypeScript 代码审查专家...',
    tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
  },
]

// 创建 Manager
const manager = new SubAgentManager(definitions)
```

## 集成到 Agent

```ts
const agent = new OrchestratorAgent({
  systemPrompt: '你是一个高级任务编排器。',
  llm: mainProvider,
  tools: BUILTIN_TOOLS,
  subAgents: definitions,
})
```

或者手动提供专用 Provider：

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  llm: mainProvider,
  tools: [
    ...BUILTIN_TOOLS,
    createSpawnSubagentTool(subAgentManager),
    createListSubagentsTool(subAgentManager),
  ],
})
```

## 异步生命周期

```
Main Agent 调用 SpawnSubagentTool
  ↓
SubAgentManager.spawn(name, input)
  ├── 创建子 Agent 实例
  ├── 使用专用 Provider (或继承主 Provider)
  ├── 在后台执行任务
  └── 返回 taskId
  ↓
Main Agent 继续执行 (可以同时做其他事)
  ↓ (每次迭代)
Main Agent 调用 poll(taskId) → 检查是否完成
  ↓
获取结果 → 合成最终答案
```

## 子代理类型

```ts
interface SubAgentDefinition {
  /** 唯一名称 */
  name: string

  /** 功能描述 (供 LLM 决策) */
  description: string

  /** 系统提示词 */
  systemPrompt: string

  /**
   * 工具名匹配模式，支持两种形式：
   * - 精确名: "echo", "ReadFileTool"
   * - 通配符: "filesystem_*" 匹配所有以 filesystem_ 开头的工具
   * 多个 pattern 匹配到同名工具时自动去重。
   */
  tools: string[]

  /** 可用 Skill 名称 */
  skills: string[]
}

interface SubAgentResult {
  taskId: string
  agentName: string
  status: SubAgentStatus
  answer?: string
  error?: string
  iterations: number
  tokensUsed: number
}

enum SubAgentStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
```

## 工具过滤

框架使用 [工具过滤器](/tools/filters) 为每个子代理自动创建受限的工具注册表。工具的来源是主 Agent 的 `ToolRegistry`（包括内置工具、自定义工具、MCP 工具等）：

```ts
// 子代理只能使用 ReadFileTool 和 GrepSearchTool
{
  name: 'code-reviewer',
  tools: ['ReadFileTool', 'GrepSearchTool'],
}

// 使用通配符，引入整个 MCP Server 的工具
{
  name: 'file-worker',
  tools: ['filesystem_*'],
}
```

## 与 MCP 共享工具

子代理**不需要自己连接 MCP Server**。MCP 工具的 `execute` 函数通过闭包持有主 Agent 的连接引用，子代理从主 Agent 的 `ToolRegistry` 获取的是**同一个 tool 对象**。这意味着：

- 主 Agent 连 MCP → 工具自动注册到 ToolRegistry
- 子代理的 `AGENT.md` 中声明 `filesystem_*` → 匹配所有 filesystem 工具
- 子代理调用这些工具 → 走的是主 Agent 的同一条 MCP 连接
- 不需要额外配置，也不需要子代理自己起 MCP 进程

完整示例：主 Agent 连接了 filesystem 和 database 两个 MCP Server，子代理按需引入：

```markdown
---
name: fullstack-worker
description: 可以操作文件系统和数据库的全栈子代理
tools:
  - filesystem_*       # filesystem Server 的全部工具
  - pg_query           # database Server 的特定工具
  - WriteFileTool      # 内置工具
---
```

## 完整示例

```ts
import {
  OrchestratorAgent,
  AnthropicProvider,
  OpenAIProvider,
  ModelRouter,
  BUILTIN_TOOLS,
} from 'kagent-ts'

const agent = new OrchestratorAgent({
  systemPrompt: '你是一个项目管理专家，可以分解并委派任务给专业的子代理。',
  llm: new ModelRouter({
    routes: {
      main: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
      subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
    },
  }),
  tools: BUILTIN_TOOLS,
  subAgents: [
    {
      name: 'code-reviewer',
      description: '审查代码质量，发现潜在问题',
      systemPrompt: '你是 TypeScript 代码审查专家...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
    },
    {
      name: 'test-writer',
      description: '编写单元测试',
      systemPrompt: '你是测试开发专家，擅长编写高质量测试...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'WriteFileTool'],
    },
    {
      name: 'doc-writer',
      description: '生成 API 文档',
      systemPrompt: '你是技术文档写作专家...',
      tools: ['ReadFileTool', 'WriteFileTool'],
    },
  ],
  maxRounds: 3,
  maxParallelNodes: 3,
})

const report = await agent.run(
  '审查 src/ 下的代码质量，为缺少测试的核心模块编写测试，然后更新 README。'
)
```

## 子 Agent 的 Hook 与追踪

通过 `subAgentHooks` 可以为子 Agent 注入生命周期钩子（如 `TraceLogger`），记录其内部的 LLM 调用、工具调用等执行轨迹：

```ts
import { OrchestratorAgent, TraceLogger } from 'kagent-ts'

const mainTrace = new TraceLogger({ sessionId: 'orchestrator-run' })

const agent = new OrchestratorAgent({
  llm: provider,
  hooks: mainTrace,
  subAgentsDir: './subagents',
  // 工厂函数：每次 spawn 时调用，创建子 Agent 的独立 TraceLogger
  subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId),
})
```

`subAgentHooks` 支持三种形式：

- **静态对象**：所有子 Agent 共享同一套 hook
- **数组**：传入多个 hook
- **工厂函数**：`(name: string, runId: string) => AgentHooks | AgentHooks[]`，每次 spawn 时调用

### 安全防护

标记了 `safeForSubAgent: false` 的 hook 会被 `SubAgentManager` 自动过滤：

```ts
const unsafeHook = {
  safeForSubAgent: false,   // ← 标记为不安全，不会被传入子 Agent
  onFinish: () => { /* ... spawns more sub-agents ... */ },
}
```

这是为了防止无限递归——例如 `ReflectionHook`（`createReflectionHook()`）在 `onFinish` 中会 spawn 子 Agent 进行反思，如果将它传入子 Agent，会导致：子 Agent 完成 → spawn 反思 Agent → 反思 Agent 完成 → spawn 更多 Agent → ……

## 下一步

- [Orchestrator Agent](/core/orchestrator-agent) — 多代理编排
- [MCP 协议](/advanced/mcp) — 连接外部 MCP Server，与子代理共享工具
- [RAG 知识库](/advanced/rag) — 语义检索文档，子代理按需共享
- [工具过滤器](/tools/filters) — 为子代理限制工具访问
