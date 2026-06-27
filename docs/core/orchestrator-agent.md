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
