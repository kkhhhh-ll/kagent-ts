# Sub-Agent 子代理

Sub-Agent 系统允许你将复杂任务**委派给专门的子代理**，实现并行处理和专业分工。

## 架构

```
Main Agent (ReAct / Fusion / Plan-Solve)
  ↓ 调用 spawn_subagent 工具
SubAgentManager
  ├── pending:    SubAgent 1 (code-analyzer)  ─┐
  ├── pending:    SubAgent 2 (code-analyzer)   ├─ 并发运行 (≤ maxPending)
  ├── waitQueue:  SubAgent 3 (grep-worker)     │  FIFO 排队
  └── waitQueue:  SubAgent 4 (echo-worker)    ─┘
  ↓ 轮询结果 (pollCompleted / collectFastResults)
Main Agent
  ↓ 合成答案
Final Answer
```

Spawn 请求**立即返回** runId。如果并发槽位 (`maxPending`) 已满，新任务进入 FIFO 队列；完成一个就从队列取下一个。每个子代理是独立的 `ReActAgent` 实例，拥有受限的工具集和预激活的 Skill。

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
  - read_file
  - grep_search
  - glob_search
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

多个 pattern 匹配到同名工具时会**自动去重**；未匹配到任何工具的 pattern 会输出警告日志。

## 加载和管理子代理

### 方式 1: 从目录加载（推荐）

```ts
import { ReActAgent } from 'kagent-ts'

const agent = new ReActAgent({
  llm: provider,
  subAgentsDir: './subagents',  // 自动扫描 AGENT.md 文件
})
```

框架在 `init()` 阶段自动完成：扫描目录 → 解析 frontmatter → 注册定义 → 绑定 LLM/ToolRegistry → 注册 `spawn_subagent` / `list_subagents` 工具 → 注入 `SUB_AGENT_DELEGATION` 到系统提示词。**无需手动调用任何 API。**

> **注意**：设置为 `""`（空字符串）可以禁用目录扫描，但仍可手动注册子代理。

### 方式 2: 手动注册

```ts
import { SubAgentManager, SubAgentDefinition, createSpawnSubagentTool, createListSubagentsTool } from 'kagent-ts'

const manager = new SubAgentManager()
manager.register({
  name: 'code-reviewer',
  description: '审查 TypeScript 代码质量',
  systemPrompt: '你是一个资深的 TypeScript 代码审查专家...',
  tools: ['read_file', 'grep_search', 'glob_search'],
  skills: [],
})

// 绑定资源并注册工具
manager.bind(llmProvider, toolRegistry, skillManager)
agent.addTool(createListSubagentsTool(manager))
agent.addTool(createSpawnSubagentTool(manager))
```

## 并发与队列

### maxPending — 并发上限

`maxPending` 控制最多同时运行的子 Agent 数量（默认 `3`）。当并发数达到上限时，**新任务进入 FIFO 等待队列而非直接报错**：

```ts
const agent = new ReActAgent({
  llm: provider,
  subAgentsDir: './subagents',
  maxPending: 5,  // 最多同时运行 5 个子 Agent
})
```

LLM 调用 `spawn_subagent` 时：

- 有空闲槽位 → 立即启动
- 槽位已满 → 进入等待队列，`pollCompleted()` / `collectFastResults()` 在收集完结果后自动从队列取下一个

### maxQueueSize — 队列上限

`maxQueueSize` 限制等待队列的最大长度（默认 `20`）。当队列满时 `spawn_subagent` 返回错误，提示 LLM 等待已有子代理完成后再重试。防止 LLM 失控导致内存暴涨。

```ts
const agent = new ReActAgent({
  llm: provider,
  subAgentsDir: './subagents',
  maxPending: 3,
  maxQueueSize: 10,  // 队列最多 10 个
})
```

### subAgentFastTimeoutMs — 快速结果

LLM spawn 子代理后，框架会在同一次迭代内等待最多 `subAgentFastTimeoutMs`（默认 `30_000`，即 30 秒）。如果子代理在此窗口内完成，结果直接注入上下文，**省下一次完整的 LLM 往返**。超时的结果留到下个迭代由 `pollCompleted()` 收集。

```ts
const agent = new ReActAgent({
  llm: provider,
  subAgentsDir: './subagents',
  subAgentFastTimeoutMs: 15_000,  // 等 15 秒快结果
})
// 设为 0 可完全禁用 fast-results（始终后台执行）
```

## 子代理的 LLM Provider

通过 `subAgentLLM` 可为子代理指定专用 LLM（如使用更便宜的模型）：

```ts
const agent = new ReActAgent({
  llm: mainProvider,
  subAgentLLM: cheapProvider,  // 子代理用便宜模型
  subAgentsDir: './subagents',
})
```

或通过 `ModelRouter` 自动路由：

```ts
const agent = new ReActAgent({
  llm: new ModelRouter({
    main: new AnthropicProvider({ model: 'claude-sonnet-4-6' }),
    subAgent: new OpenAIProvider({ model: 'gpt-4o-mini' }),
  }),
  subAgentsDir: './subagents',
})
// subAgentLLM 自动解析为 router.forSubAgent()
```

## 取消与生命周期

### cancel(runId) — 精确取消

可通过 runId 取消单个子代理，无论它处于排队还是运行状态：

```ts
const manager = agent.subAgentManager  // 或通过 agent.cancelSubAgent(runId)

// 取消排队中的 → 从 waitQueue 移除
const result = manager.cancel("code-analyzer_3_1720000000000")
// → { cancelled: true, wasRunning: false }

// 取消运行中的 → 中止 LLM 调用 + ReAct 循环
const result2 = manager.cancel("code-analyzer_2_1720000000000")
// → { cancelled: true, wasRunning: true }

// 取消失败
manager.cancel("nonexistent")
// → { cancelled: false, reason: "not_found" }

manager.cancel(alreadyCompletedRunId)
// → { cancelled: false, reason: "already_completed" }
```

取消运行中的子代理时，`agent.cancel()` 会：

1. 设置 `_cancelled = true`
2. 中止当前 LLM 调用的 `AbortController`
3. ReAct 循环检测到取消标志 → 返回取消消息
4. 结果仍然能被 `pollCompleted()` 收集（success=false）

### cancelAll() + 恢复

用户按 Ctrl+C → `agent.cancel()` → `SubAgentManager.cancelAll()`：

- 等待队列被清空
- 运行中的子代理被标记为 `cancelled` 并中止 LLM 调用
- 恢复（resume）时，`recoverOrphanedSubAgentResults()` 自动打捞已完成的结果并注入上下文
- 仍在运行的会提示 LLM 等待

### clear() + reset()

`agent.reset()` 调用 `SubAgentManager.clear()` 而非 `cancelAll()`：

- 清空 waitQueue + pending，**不保留任何结果**
- 防止上一次取消的残留结果泄漏到新的 `run()` 中

### 生命周期状态机

```
queued → running → completed
                 → error
                 → cancelled
queued → cancelled (从等待队列中移除)
```

## 子代理的限制

子代理被构造时自动应用以下限制：

## 类型定义

```ts
interface SubAgentDefinition {
  name: string                   // 唯一标识（spawn 时的目标名）
  description: string            // 给主 LLM 看的描述
  systemPrompt: string           // 子代理的系统提示词
  tools: string[]                // 工具名（支持 * 通配符）
  toolFilter?: ToolFilter        // 可选：更精细的工具控制
  skills: string[]               // 预激活的 Skill 名
}

interface SubAgentResult {
  subAgentId: string             // 唯一 runId
  name: string                   // 子代理名
  success: boolean               // 是否成功
  output: string                 // 输出（用 XML 标签包裹）
  durationMs: number             // 执行时长（ms）
}

type RunStatus = "queued" 
type CancelResult =
    ```

## 异步执行流程

```
Main Agent 调用 SpawnSubagentTool
  ↓
SubAgentManager.spawn(name, input)
  ├── 有空闲槽位 → dequeue: 创建 ReActAgent → 启动后台执行
  ├── 无空闲槽位 → waitQueue: 加入 FIFO 队列
  └── 返回 runId
  ↓
Main Agent 继续 (executeToolCallsBatch 返回 hadSpawnCalls=true)
  ↓ collectorFastSubAgentResults(timeout)
  ├── 快的结果 (≤30s) → 同迭代注入上下文 → LLM 下轮可见
  └── 慢的结果 (>30s) → 保留后台
  ↓
下次迭代: pollCompleted() 阻塞等待 → 收集结果 → 注入上下文
  ↓
获取所有结果 → 合成最终答案
```

## 工具过滤

框架使用 [工具过滤器](/tools/filters) 为每个子代理自动创建受限的工具注册表。工具的来源是主 Agent 的 `ToolRegistry`（包括内置工具、自定义工具、MCP 工具等）：

```ts
// 子代理只能使用 ReadFileTool 和 GrepSearchTool
{
  name: 'code-reviewer',
  tools: ['read_file', 'grep_search'],
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
  - write_file         # 内置工具
---
```

## 完整示例

```ts
import {
  ReActAgent,
  AnthropicProvider,
  OpenAIProvider,
  ModelRouter,
  BUILTIN_TOOLS,
} from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个项目管理专家，可以分解并委派任务给专业的子代理。',
  llm: new ModelRouter({
    main: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
    subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
  }),
  tools: BUILTIN_TOOLS,
  subAgentsDir: './subagents',
  maxPending: 3,               // 最多 3 并发
  maxQueueSize: 10,            // 队列上限
  subAgentFastTimeoutMs: 30000, // 快结果等 30s
})

const report = await agent.run(
  '审查 src/ 下的代码质量，为缺少测试的核心模块编写测试，然后更新 README。'
)
```

## 子 Agent 的 Hook 与追踪

通过 `subAgentHooks` 可以为子 Agent 注入生命周期钩子（如 `TraceLogger`），记录其内部的 LLM 调用、工具调用等执行轨迹。

当 `hooks` 中包含 `TraceLogger` 时，`subAgentHooks` **自动派生**，无需手动配置：

```ts
import { ReActAgent, TraceLogger } from 'kagent-ts'

const mainTrace = new TraceLogger({ sessionId: 'orchestrator-run' })

const agent = new ReActAgent({
  llm: provider,
  hooks: mainTrace,
  subAgentsDir: './subagents',
  // subAgentHooks 自动生效，无需手动配置
})
```

如需自定义行为，仍可显式传入工厂函数：

```ts
const agent = new ReActAgent({
  llm: provider,
  hooks: mainTrace,
  subAgentsDir: './subagents',
  // 显式覆盖：每次 spawn 时调用，创建子 Agent 的独立 TraceLogger
  subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId),
})
```

`subAgentHooks` 支持三种形式：

- **静态对象**：所有子 Agent 共享同一套 hook
- **数组**：传入多个 hook
- **工厂函数**：`(name: string, runId: string) => AgentHooks 
### 安全防护

标记了 `safeForSubAgent: false` 的 hook 会被 `SubAgentManager` 自动过滤：

```ts
const unsafeHook = {
  safeForSubAgent: false,   // ← 标记为不安全，不会被传入子 Agent
  onFinish: () => { /* ... spawns more sub-agents ... */ },
}
```

这是为了防止无限递归——例如反思/记忆提取的 Fork 子 Agent 在完成后如果再次触发反思，会导致无限递归。

## Sub-Agent vs Fork

如果不需要完整工具集或工作区隔离，考虑使用更轻量的 [Fork](/core/fork)：

## 下一步

- [Fork — Agent 派生](/core/fork) — 轻量级内联派生
- [Orchestrator Agent](/core/orchestrator-agent) — 多代理编排
- [MCP 协议](/advanced/mcp) — 连接外部 MCP Server，与子代理共享工具
- [RAG 知识库](/advanced/rag) — 语义检索文档，子代理按需共享
- [工具过滤器](/tools/filters) — 为子代理限制工具访问
