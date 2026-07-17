# Eval 评估

kagent-ts 提供完整的评估框架，包括工具调用指标收集、基准回归测试，以及 RAG 检索质量评估。

## 评估组件

```
Eval 框架
├── ToolCallEvaluator  → 工具调用指标收集（P50/P99 延迟、成功率、熔断）
├── Benchmark          → 基线回归测试（自动检测 PASS→FAIL 翻转、延迟恶化）
└── RAGEvaluator       → RAG 检索质量评估（IR 指标 + LLM-as-Judge）
```

> **注意：** `EvalRunner` 已内置到 `Benchmark` 中，不再作为独立 API 对外暴露。如需直接跑用例，使用 `Benchmark` 即可；如需轻量级工具调用监控，使用 `ToolCallEvaluator`。

## ToolCallEvaluator

收集每个工具的调用指标：

```ts
import { ReActAgent, OpenAIProvider, ToolCallEvaluator, BUILTIN_TOOLS } from 'kagent-ts'

const evaluator = new ToolCallEvaluator()

const agent = new ReActAgent({
  systemPrompt: '...',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  hooks: [evaluator],
})

await agent.run('分析项目结构')

// 查看统计
const stats = evaluator.getScorecard()
console.log('成功率:', (stats.overallSuccessRate * 100).toFixed(1) + '%')
console.log('平均延迟:', stats.avgLatencyMs + 'ms')
console.log('工具调用分布:')
for (const tool of stats.perTool) {
  console.log(`  ${tool.toolName}: ${tool.totalCalls} 次`)
}
```

### 指标

`getScorecard()` 返回 `ToolCallScorecard`（总体评分卡），其中 `perTool` 字段为各工具的 `ToolCallStats`：

```ts
interface ToolCallScorecard {
  totalCalls: number              // 总调用次数
  totalSuccesses: number          // 成功次数
  totalFailures: number           // 失败次数
  overallSuccessRate: number      // 总体成功率 (0–1)
  avgLatencyMs: number            // 平均延迟 (ms)
  uniqueToolsUsed: number         // 不同工具数量
  circuitBreakerTrips: number     // 熔断器触发次数
  perTool: ToolCallStats[]        // 按调用次数降序排列
}

interface ToolCallStats {
  toolName: string                // 工具名称
  totalCalls: number              // 调用总次数
  successCount: number            // 成功次数
  failureCount: number            // 失败次数
  successRate: number             // 成功率 (0–1)
  avgLatencyMs: number            // 平均延迟 (ms)
  p50LatencyMs: number            // P50 延迟 (ms)
  p99LatencyMs: number            // P99 延迟 (ms)
  avgRetries: number              // 平均重试次数
  circuitBreakerTrips: number     // 熔断器触发次数
  errorDistribution: Record<string, number>  // 错误码分布
}
```

## Benchmark

基准回归测试：批量运行用例并对比历史基线，检测 Agent 行为是否退化。

```ts
import { Benchmark } from 'kagent-ts'

const benchmark = new Benchmark({
  name: '核心功能基准',
  // Agent 工厂 — 每个用例创建一个全新 Agent
  agentFactory: (evaluator) => new ReActAgent({
    systemPrompt: '你是一个有用的 AI 助手。',
    llm: provider,
    tools: BUILTIN_TOOLS,
    hooks: [evaluator],
  }),
  cases: [
    { name: 'task-analysis', input: '分析项目结构' },
    { name: 'code-search', input: '查找所有未使用的导入' },
    { name: 'file-ops', input: '统计每个目录的 TypeScript 文件数量' },
  ],
  baselinePath: './benchmark-baseline.json',  // 与上次结果对比
})

// run() 执行所有用例，自动对比基线并持久化结果
const result = await benchmark.run()

console.log(`通过率: ${(result.summary.passRate * 100).toFixed(1)}%`)
console.log(`平均用例耗时: ${result.summary.avgCaseDurationMs}ms`)

// 退化 / 改进检测
for (const r of result.summary.regressions) {
  console.log(`⚠️  退化: ${r.target} — ${r.metric} 从 ${r.baseline} 变为 ${r.current}`)
}
for (const i of result.summary.improvements) {
  console.log(`✅ 进步: ${i.target} — ${i.metric} 从 ${i.baseline} 变为 ${i.current}`)
}
```

### 结果结构

```ts
interface BenchmarkResult {
  summary: BenchmarkSummary
  cases: EvalResult[]
}

interface BenchmarkSummary {
  name: string                // 基准名称
  timestamp: string           // 运行时间 (ISO-8601)
  passed: number              // 通过数
  total: number               // 总用例数
  passRate: number            // 通过率 (0–1)
  avgToolCallsPerCase: number // 每用例平均工具调用
  avgCaseDurationMs: number   // 每用例平均耗时 (ms)
  regressions: Regression[]   // 退化项
  improvements: Improvement[] // 改进项
}

interface Regression {
  target: string              // 退化项（工具名 / 指标名 / 用例名）
  metric: string              // 变化的指标
  baseline: number | string   // 基线值
  current: number | string    // 当前值
  description: string         // 描述
}
```

## RAGEvaluator — 检索质量评估

直接评估 RAG 检索系统的输出质量（`Precision@K` / `Recall@K` / `MRR` / `NDCG@K`），支持三种评估方式：

- **Ground-Truth 模式**：基于标注数据，计算传统 IR 指标，零成本
- **LLM-as-Judge 模式**：用 LLM 对每个 chunk 打分，无需标注
- **合成数据模式**：LLM 自动读知识库生成问题 + 标注，零人工

### 零人工标注：LLM 自动生成用例

最懒的方式——让 LLM 读知识库自动生成问题，同时标注好 relevant chunk：

```ts
import { RAGEvaluator } from 'kagent-ts'

const ragManager = (agent as any).ragManager

// Step 1: LLM 自动生成带标注的测试用例
const cases = await RAGEvaluator.generateSyntheticCases(ragManager, {
  llm: provider,           // 用任意 LLM 生成问题
  maxQuestions: 20,        // 最多 20 条（默认 30）
  questionsPerChunk: 2,    // 每个 chunk 生成 2 个问题
  maxChunks: 10,           // 最多采样 10 个 chunk
})

// Step 2: 双模式同时评估
// 方式 1: 传入 llm（ModelRouter）→ 自动走 forReflection() 做 unbiased review
const evaluator = new RAGEvaluator({ ragManager, llm: router })

// 方式 2: 显式指定 judgeLLM（完全控制评判模型）
const evaluator = new RAGEvaluator({
  ragManager,
  judgeLLM: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
})

const result = await evaluator.evaluate(cases)
// → Ground-Truth 指标（确定性） + LLM-Judge 指标 + κ 一致性

console.log(evaluator.generateReport(result))
```

**原理**：LLM 读每个 chunk → 生成问题 → 自动标 `sourcePath#chunkIndex` 为 relevant。chunk 在文档间均匀采样，问题去重。真正零人工。

### 手动标注模式

如果有标注数据（或想写固定测试集），直接传 `relevantChunks`：

```ts
const evaluator = new RAGEvaluator({ ragManager, defaultTopK: 5 })
const result = await evaluator.evaluate([
  {
    name: "MCP 配置",
    query: "怎么配置 MCP？",
    relevantChunks: ["docs/advanced/mcp.md#3", "docs/advanced/mcp.md#5"],
    topK: 5,
  },
])

const s = result.summary
console.log(`Precision@K: ${s.avgPrecisionAtK.toFixed(3)}`)
console.log(`MRR: ${s.avgMRR.toFixed(3)}`)
console.log(`NDCG@K: ${s.avgNdcgAtK.toFixed(3)}`)
```

### 纯 LLM-as-Judge（无标注、无合成）

```ts
const evaluator = new RAGEvaluator({
  ragManager,
  judgeLLM: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
})

const result = await evaluator.evaluate([
  { name: "MCP", query: "怎么配置 MCP？", topK: 5 },
])

for (const c of result.cases) {
  for (const j of c.judgments ?? []) {
    console.log(`${j.relevant ? '✅' : '❌'} [${j.score}/10] ${j.reasoning}`)
  }
}
```

### 用例结构

```ts
interface RAGEvalCase {
  name: string                // 用例名称
  query: string               // 搜索查询
  relevantChunks?: string[]   // 标注的 relevant chunk ID（"sourcePath#chunkIndex"）
  topK?: number               // 检索数量（默认: evaluator 的 defaultTopK）
}
```

### 结果结构

```ts
interface RAGCaseResult {
  caseName: string
  query: string
  topK: number
  retrieved: RAGSearchResult[]   // 检索到的 chunk（embedding 已 strip）
  judgments?: ChunkJudgment[]    // LLM 判断（仅 judgeLLM 模式下）
  metrics: RAGRetrievalMetrics
}

interface RAGRetrievalMetrics {
  // Ground-Truth 指标（需要 relevantChunks）
  precisionAtK: number           // |检索 ∩ 相关| / K
  recallAtK: number              // |检索 ∩ 相关| / |全部相关|
  mrr: number                    // 1 / 第一个相关结果的排名
  ndcgAtK: number                // 归一化折损累积增益（二值相关度）

  // LLM-Judge 指标（需要 judgeLLM）
  llmPrecisionAtK?: number       // LLM 判断为相关的 chunk 占比
  llmNdcgAtK?: number            // 用 LLM 分数算的分级 NDCG
  avgRelevanceScore?: number     // LLM 平均相关性分 (0–10)

  // 一致性（两者都需要）
  judgeLabelAgreement?: number   // Cohen's κ (−1 到 1)
}

interface ChunkJudgment {
  chunkId: string                // "sourcePath#chunkIndex"
  sourcePath: string
  chunkIndex: number
  relevant: boolean              // LLM 判断是否相关
  score: number                  // 0–10 相关性分数
  reasoning: string              // 判断理由
}

// 聚合摘要
interface RAGEvalSummary {
  totalCases: number
  casesWithGroundTruth: number
  casesWithLLMJudgments: number
  avgPrecisionAtK: number
  avgRecallAtK: number
  avgMRR: number
  avgNdcgAtK: number
  avgLlmPrecisionAtK?: number
  avgLlmNdcgAtK?: number
  avgRelevanceScore?: number
  avgJudgeLabelAgreement?: number  // Cohen's κ
}

// 合成数据生成配置
interface SyntheticCaseGenConfig {
  llm: LLMProvider               // 用于生成问题的 LLM
  maxQuestions?: number          // 最多生成问题数（默认 30）
  questionsPerChunk?: number     // 每个 chunk 生成几个问题（默认 2）
  maxChunks?: number             // 最多采样 chunk 数（默认 15）
}
```

### 评估时机

| 阶段 | 工具 | 数据 | 频率 |
|------|------|------|------|
| 开发迭代 | `RAGEvaluator` + `generateSyntheticCases()` | 自动合成 | 每次改 RAG 配置 |
| CI / 合码 | `RAGEvaluator` + 固定合成数据集 | 保存到 JSON 复现 | 每次 PR |
| 线上监控 | `RAGEvaluator` + `judgeLLM` | 真实用户 query | 持续/每日 |

> 详细说明和解读指南见 [RAG 知识库 → 检索质量评估](/advanced/rag#检索质量评估)。

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
  ToolCallEvaluator,
  Benchmark,
  BUILTIN_TOOLS,
} from 'kagent-ts'

const provider = new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' })

// ── 收集工具调用指标 ──
const evaluator = new ToolCallEvaluator()
const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: provider,
  tools: BUILTIN_TOOLS,
  hooks: [evaluator],
})
await agent.run('分析项目结构')
console.log('成功率:', (evaluator.getScorecard().overallSuccessRate * 100).toFixed(1) + '%')

// ── 基准回归 ──
const benchmark = new Benchmark({
  name: '核心功能基准',
  agentFactory: (evaluator) => new ReActAgent({
    systemPrompt: '你是一个有用的 AI 助手。',
    llm: provider,
    tools: BUILTIN_TOOLS,
    hooks: [evaluator],
  }),
  cases: [
    { name: 'grep-any', input: '查找所有使用 any 类型的文件', expectedTools: ['grep_search'] },
    { name: 'count-files', input: '统计 src/ 下 .ts 文件数', expectedOutput: '.ts' },
  ],
  baselinePath: './benchmark-baseline.json',
})

const benchmarkResult = await benchmark.run()
console.log(`通过率: ${(benchmarkResult.summary.passRate * 100).toFixed(1)}%`)
for (const r of benchmarkResult.summary.regressions) {
  console.log(`⚠️  ${r.description}`)
}
```