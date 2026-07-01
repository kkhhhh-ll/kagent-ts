# Orchestrator Agent

Orchestrator Agent 是框架中最强大的范式，专为**大规模多agent协作**而设计。它将用户请求分解为 DAG 任务图，并行调度多个子agent执行，最后合成结果。

## 执行流程

```
用户输入
  ↓
[DECOMPOSE] 分解为 DAG 任务图
  ├── Task A: 分析 src/core/
  ├── Task B: 分析 src/tools/      ← 与 A 并行
  ├── Task C: 综合分析结果          ← 依赖 A, B
  └── Task D: 生成报告              ← 依赖 C
  ↓
[DISPATCH] 拓扑排序 + 并行调度
  ├── Round 1: [Task A] [Task B]  (并行)
  ├── Round 2: [Task C]           (依赖 A, B 完成)
  └── Round 3: [Task D]           (依赖 C 完成)
  ↓
[SYNTHESIZE] 综合所有节点输出
  ↓
[ADAPT] 检查是否有遗漏?
  ├── 有 → 生成新节点，回到 DISPATCH
  └── 无 → Final Answer
```

## 基本用法

```ts
import { OrchestratorAgent, OpenAIProvider } from 'kagent-ts'

const agent = new OrchestratorAgent({
  systemPrompt: '你是一个高级任务编排器。',
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [],
  subAgents: [
    {
      name: 'code-reviewer',
      description: '审查代码质量',
      systemPrompt: '你是代码审查专家...',
      tools: ['ReadFileTool', 'GrepSearchTool'],
    },
    {
      name: 'test-writer',
      description: '编写单元测试',
      systemPrompt: '你是测试专家...',
      tools: ['ReadFileTool', 'WriteFileTool'],
    },
  ],

  maxRounds: 3,          // 最大编排轮次 (默认: 3)
  maxParallelNodes: 5,   // 最大并行节点数 (默认: 5)
  maxTotalNodes: 20,     // 最大总节点数 (默认: 20)
})

const answer = await agent.run(
  '审查 src/ 下所有文件的代码质量，为缺少测试的模块编写测试。'
)
console.log(answer)
```

## 配置参数

```ts
interface OrchestratorAgentConfig extends AgentConfig {
  /** 最大编排轮次 (默认: 3) */
  maxRounds?: number

  /** 每轮最大并行子代理数 (默认: 5) */
  maxParallelNodes?: number

  /** 整个编排过程中最大节点数 (默认: 20) */
  maxTotalNodes?: number
}
```

## DAG 任务图

Orchestrator 使用 DAG（有向无环图）来组织任务之间的依赖关系：

```ts
interface TaskNode {
  id: string              // 节点 ID
  description: string     // 任务描述
  dependencies: string[]  // 依赖的节点 ID 列表
  agentType: string       // 执行该节点的子代理类型
  input: string           // 子代理的输入
  result?: string         // 执行结果 (完成后填充)
}
```

## 模板注入

子agent的输入支持模板变量，用于注入依赖节点的输出：

```text
"请基于以下分析结果生成报告：
{node_a.result}
{node_b.result}"
```

在调度时，`{node_id.result}` 会被替换为对应节点的实际输出。

## 自适应轮次

当 Synthesis 阶段发现有遗漏时，Orchestrator 会自动生成新的任务节点：

```
[ADAPT]
检测到以下遗漏:
- tools/ 目录下的文件未被分析
- 缺少性能相关的审查

生成新节点:
- Task E: 分析 src/tools/ 目录
- Task F: 执行性能基准测试
```

## 完整示例

```ts
import { OrchestratorAgent, OpenAIProvider } from 'kagent-ts'

const agent = new OrchestratorAgent({
  systemPrompt: `你是一个高级项目分析编排器。
当收到分析请求时：
1. 将任务分解为独立的子任务
2. 识别子任务之间的依赖关系
3. 并行执行无依赖的子任务
4. 综合所有结果生成最终报告`,

  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),

  subAgents: [
    {
      name: 'code-analyzer',
      description: '分析代码结构和质量',
      systemPrompt: '你是一个代码分析专家...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
    },
    {
      name: 'dep-checker',
      description: '检查依赖关系',
      systemPrompt: '你是一个依赖分析专家...',
      tools: ['ReadFileTool', 'BashTool'],
    },
    {
      name: 'report-writer',
      description: '生成分析报告',
      systemPrompt: '你是一个技术写作专家...',
      tools: ['WriteFileTool'],
    },
  ],

  maxRounds: 3,
  maxParallelNodes: 5,
  maxTotalNodes: 20,
})

const report = await agent.run(
  '全面分析这个项目的架构、代码质量和依赖关系，生成一份详细的报告文件。'
)
console.log(report)
```

## 执行追踪

Orchestrator Agent 在执行过程中会触发完整的生命周期钩子，可用于追踪和调试：

| 阶段 | 触发的 Hook | 说明 |
| --- | --- | --- |
| Decompose | `onLLMStart/End`, `onThought`, `onPlanCreated` | LLM 分解请求 → 产生 TaskGraph DAG |
| Dispatch | `onToolStart/End/Error("spawn_subagent")` | 每个子 Agent 的 spawn 和结果 |
| Synthesize | `onLLMStart/End`, `onThought` | LLM 综合所有子 Agent 结果 |
| Adapt | `onLLMStart/End`, `onThought`, `onPlanRevised` | 生成新节点 → 更新 TaskGraph |
| 完成 | `onFinish` | 返回最终答案 |

结合 `TraceLogger` 和 `subAgentHooks`，可以生成完整的编排追踪报告：

```ts
const mainTrace = new TraceLogger({ sessionId: 'orch-run' })

const agent = new OrchestratorAgent({
  llm: provider,
  hooks: mainTrace,
  subAgentHooks: (name, runId) => mainTrace.createChildTrace(name, runId),
  subAgentsDir: './subagents',
})
```

生成的 trace 文件中：

- **主 trace** 显示 Decompose → Dispatch（🚀 spawn + 📬 result）→ Synthesize → Adapt 的完整时间线
- **子 trace** 每个子 Agent 有独立的 `.html` 文件，记录其内部 ReAct 循环

## Git Worktree 隔离

当多个子 agent 并行修改同一仓库时，需要文件系统级别的隔离以避免互相踩踏。Orchestrator 支持为每个子 agent 任务节点创建独立的 [git worktree](https://git-scm.com/docs/git-worktree)。

### 启用 Worktree

```ts
const agent = new OrchestratorAgent({
  llm: provider,
  subAgentsDir: "./subagents",

  // Worktree 配置
  enableWorktrees: true,                    // 开启 worktree 隔离
  worktreeRepoPath: "/path/to/your/repo",   // 仓库根目录（必填）
  autoMergeWorktrees: true,                 // 节点完成后自动 merge 回主分支
  autoCleanupWorktrees: true,               // 会话结束后清理 worktree
})
```

### 配置项

```ts
interface OrchestratorAgentConfig {
  /** 是否启用 git worktree 隔离（默认 false） */
  enableWorktrees?: boolean

  /** 仓库根目录（enableWorktrees=true 时必填） */
  worktreeRepoPath?: string

  /** worktree 父目录（默认 .kagent-worktrees/） */
  worktreesDir?: string

  /** 分支名前缀（默认 "kagent"） */
  worktreeBranchPrefix?: string

  /** 节点完成后自动 merge 并清理 worktree（默认 false） */
  autoMergeWorktrees?: boolean

  /** 会话结束时强制清理所有 worktree（默认 true） */
  autoCleanupWorktrees?: boolean
}
```

### 执行流程

启用 worktree 后，每个任务节点的执行变为：

```
[节点 N] → 创建 worktree → spawn 子 agent（工作目录 = worktree）
                              ↓
                         子 agent 修改文件、git commit 等
                              ↓
                         节点完成 → 可选 merge 回主分支 → 清理 worktree
```

子 agent 通过 `workdir` 参数自动将其工作目录限定在 worktree 内，文件操作均在隔离环境中进行。

### 分支命名

自动生成的分支名格式为 `{branchPrefix}/{nodeId}-{timestamp}`。可以通过 `worktreeBranchPrefix` 自定义前缀。也可在 `TaskNode` 层面指定 `worktreeBaseRef` 来基于特定分支创建 worktree。

### 会话恢复

Worktree 状态会随 session checkpoint 一起持久化。中断后恢复时，Orchestrator 会还原 worktree 注册表，使未完成的 worktree 可以被重新接管。

## 什么时候用 Orchestrator？

✅ **适合**:
- 大规模代码审查和重构
- 多模块并行分析和测试
- 跨子系统的依赖分析
- 需要协调多个专业子agent的复杂任务

❌ **不适合**:
- 简单的单步问答 → 使用 [ReAct Agent](/core/react-agent)
- 单代理即可完成的中等任务 → 使用 [Fusion Agent](/core/fusion-agent)

## 下一步

- [Sub-Agent 子代理](/advanced/subagents) — 子代理的详细配置与管理
- [会话持久化](/advanced/session) — Orchestrator 的 Checkpoint 机制
- [工具系统](/tools/overview) — 为子代理配置工具
