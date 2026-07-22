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
[RETRY] 检查失败节点 → 按 failureStrategy 重试
  ├── retry-subtree: 只重跑失败的子树
  ├── retry-all:     全图重跑
  └── continue:      不重试，继续
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
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [],
  subAgentsDir: './subagents',  // 指向包含 AGENT.md 文件的目录

  maxRounds: 3,          // 最大编排轮次 (默认: 3)
  maxParallelNodes: 5,   // 最大并行节点数 (默认: 5)
  maxTotalNodes: 20,     // 最大总节点数 (默认: 20)
  maxRetriesPerNode: 2,  // 单节点最大重试次数 (默认: 2)
  failureStrategy: 'retry-subtree',  // 失败策略 (默认: "retry-subtree")
})

const answer = await agent.run(
  '审查 src/ 下所有文件的代码质量，为缺少测试的模块编写测试。'
)
console.log(answer)
```

## 流式输出

Orchestrator Agent 支持 `stream()` 方法，在各阶段实时输出进度：

```ts
for await (const chunk of agent.stream(
  '审查 src/ 下所有文件的代码质量'
)) {
  process.stdout.write(chunk)
}
```

流式输出的格式：

```text
## Phase 1: Decompose

Decomposed into 5 node(s):
  - [task_a] → code-reviewer
  - [task_b] → code-reviewer (deps: task_a)
  ...

## Round 1/3

### Dispatch
Dispatching 2 node(s):
  - [task_a] code-reviewer → running
  - [task_b] code-reviewer → running
  - [task_a] ✅ completed (1234ms)
  - [task_b] ✅ completed (2100ms)

### Synthesize
<thought text>

### Adapt
<thought text>
3 new node(s) added.

...

## Final Answer
<完整答案文本>
```

各阶段说明：

## 配置参数

```ts
interface OrchestratorAgentConfig extends AgentConfig {
  /** 最大编排轮次 (默认: 3) */
  maxRounds?: number

  /** 每轮最大并行子代理数 (默认: 5) */
  maxParallelNodes?: number

  /** 整个编排过程中最大节点数 (默认: 20) */
  maxTotalNodes?: number

  /** 单节点失败后最大重试次数 (默认: 2) */
  maxRetriesPerNode?: number

  /**
   * 节点失败时的处理策略 (默认: "retry-subtree")
   * - "retry-subtree": 重试失败节点 + 级联重跑所有下游依赖节点
   * - "retry-all":     重置整个 DAG，从头开始
   * - "continue":      保持失败，下游节点携带错误信息继续执行
   */
  failureStrategy?: FailureStrategy
}
```

## DAG 任务图

Orchestrator 使用 DAG（有向无环图）来组织任务之间的依赖关系：

```ts
interface TaskNode {
  id: string              // 节点 ID
  description: string     // 任务描述
  dependsOn: string[]     // 依赖的节点 ID 列表
  subAgentName: string    // 执行该节点的子代理类型
  input: string           // 子代理的输入
  status: TaskNodeStatus  // 当前状态: pending   result?: SubAgentResult // 执行结果 (完成后填充)
  retryCount: number      // 已重试次数 (从 0 开始)
  maxRetries?: number     // 最大重试次数 (从配置继承)
}
```

## 模板注入

<div v-pre>

子agent的输入支持模板变量，用于注入依赖节点的输出：

```text
"请基于以下分析结果生成报告：
{{node_a.output}}
{{node_b.output}}"
```

在调度时，`{{node_id.output}}` 会被替换为对应节点的实际输出。

</div>

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

## 失败处理与重试

当子 agent 任务节点执行失败时，Orchestrator 支持三种失败处理策略，通过 `failureStrategy` 配置。

### 三种策略

### 重试流程 (`"retry-subtree"`)

```
[DISPATCH] Wave 1: [A] [B]  (并行)
              ↓     ↓
           A 失败  B 成功
              ↓
[RETRY]   A 重试 (retry 1/2)
          ↓
      失效化 A 的所有下游: C, D → reset 为 pending
          ↓
[DISPATCH] Wave 2: [A']         (重试 A)
          ↓
       A' 成功
          ↓
[DISPATCH] Wave 3: [C] [D]     (重跑下游)
```

- 被重置的节点会清除所有运行时状态（result、timing、worktree 等），以全新状态重新 dispatch
- 如果重试次数耗尽（`retryCount >= maxRetries`），节点保持 `failed`，子树被放弃，最终由 `maxRounds` 兜底触发强制 synthesis
- 与当前轮次无关的已完成节点不受影响，避免重复计算

### 死锁防护

- **每节点重试上限**：`retryCount >= maxRetries` 后放弃该节点
- **`maxRounds` 兜底**：即使子树永久失败导致下游死锁，编排循环也会在达到最大轮次后触发强制 synthesis，用已有结果尽力回答
- **`"retry-all"` 不会死锁**：全量重置后所有节点回到同一起跑线

### 重试元数据

被重试过的节点在 synthesis 上下文中会附带重试信息，帮助 LLM 做出更准确的完整性判断：

```text
=== [task_a] 分析核心模块 (SUCCESS, retries: 1/2) ===
...输出内容...
```

## 环检测

由于 DAG 由 LLM 生成，存在 LLM 意外生成循环依赖的可能（例如 A→B→C→A）。Orchestrator 在每次任务图更新后会自动检测并断开环。

### 检测算法

使用 **Kahn 拓扑排序**：从所有入度为 0 的节点开始 BFS 剥离，无法被剥离的节点即形成环。

### 断环策略

只删除环中节点之间的互相依赖，保留非环节点指向环中节点的合法边：

```text
检测前：  A → B → C → A  (环)
          D → A           (合法)
检测后：  A, B, C 各自独立（循环边全部移除）
          D → A 保留
```

### 调用时机

- **Decompose 之后**：检查初始 DAG 是否有环
- **Adapt 追加新节点之后**：检查新节点是否与已有节点形成环

检测到环时，Orchestrator 会打印 warn 日志告知涉及节点和断开的边数，然后继续执行——不影响正常流程。

## 模型降级感知

当使用 `FallbackProvider` 时，主模型（如 Opus）挂了会自动切换到备用模型（如 Haiku）。但弱模型产出的结果可能质量不足——Orchestrator 会自动感知并做出应对。

### 工作原理

`FallbackProvider` 在每次 LLM 调用后，会在响应中附加 `providerMeta` 元数据：

```ts
// LLMResponse 中自动设置
response.providerMeta = {
  model: "claude-haiku-4-5",  // 实际处理的模型
  isFallback: true,            // 是否来自非主力模型
};
```

Orchestrator 的每个阶段（Decompose / Synthesize / Adapt / ForceSynthesize）完成后，自动检查该元数据并记录降级事件。进入 Synthesis 阶段时，这些事件会注入到 prompt 中：

```text
=== Model Degradation Notice ===
Some phases of this orchestration ran on a fallback (weaker) model:
  - [Decompose] ran on fallback model "claude-haiku-4-5"
Results from these phases may be less reliable. Please be more
skeptical when evaluating completeness and quality.
```

Synthesis LLM 看到这段后会更倾向于判断 `isComplete: false`，从而触发 Adapt 阶段补做额外工作——用降级风险换执行鲁棒性。

### 使用方式

无需额外配置。只需将 Orchestrator 的 `llm` 设为 `FallbackProvider`：

```ts
import { FallbackProvider } from 'kagent-ts'

const agent = new OrchestratorAgent({
  llm: new FallbackProvider({
    primary: new AnthropicProvider({ model: 'claude-opus-4-8' }),
    fallbacks: [
      new AnthropicProvider({ model: 'claude-sonnet-5' }),
      new AnthropicProvider({ model: 'claude-haiku-4-5' }),
    ],
  }),
  // ...
})
```

### 适用范围

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

  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),

  subAgentsDir: './subagents',  // 子agent由 AGENT.md 文件定义

  maxRounds: 3,
  maxParallelNodes: 5,
  maxTotalNodes: 20,
})

const report = await agent.run(
  '全面分析这个项目的架构、代码质量和依赖关系，生成一份详细的报告文件。'
)
console.log(report)

// 或使用流式输出，实时查看编排进度
for await (const chunk of agent.stream(
  '全面分析这个项目的架构、代码质量和依赖关系'
)) {
  process.stdout.write(chunk)
}
```

## 执行追踪

Orchestrator Agent 在执行过程中会触发完整的生命周期钩子，可用于追踪和调试：

当 `hooks` 中包含 `TraceLogger` 时，子 Agent 追踪**自动生效**，无需额外配置：

```ts
const mainTrace = new TraceLogger({ sessionId: 'orch-run' })

const agent = new OrchestratorAgent({
  llm: provider,
  hooks: mainTrace,
  // subAgentHooks 自动派生
  subAgentsDir: './subagents',
})
```

生成的 trace 文件中：

- **主 trace** 显示 Decompose → Dispatch（🚀 spawn + 📬 result）→ Synthesize → Adapt 的完整时间线
- **子 trace** 嵌入主 HTML 文件的底部，每个子 Agent 为折叠区块，记录其内部 ReAct 循环

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
