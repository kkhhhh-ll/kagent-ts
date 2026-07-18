# Eval 评估

kagent-ts 提供工具调用指标收集和基准回归测试的评估能力。RAG 检索质量评估推荐使用 [RAGAS](https://docs.ragas.io/) 等成熟工具。

## 评估组件

```
Eval 框架
├── ToolCallEvaluator  → 工具调用指标收集（P50/P99 延迟、成功率、熔断）
└── Benchmark          → 基线回归测试（自动检测 PASS→FAIL 翻转、延迟恶化）
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

> **RAG 检索质量评估**：推荐使用 [RAGAS](https://docs.ragas.io/) 等成熟工具离线评估，框架不再内置。

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