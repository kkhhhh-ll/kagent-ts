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

基准回归测试：批量运行用例、对比历史基线，**10 维度自动检测** Agent 行为是否退化。

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

  // baselinePath: "latest" → 自动取上次 run 生成的文件
  // 也可以指具体路径: baselinePath: './.kagent-benchmarks/benchmark-xxx.json'
  baselinePath: "latest",

  // 全部可选，默认值如下：
  passRateRegressionThreshold: 0.05,    // 通过率 ≥5pp 下降 → 回归
  failureCountRegressionThreshold: 2,   // 单 case 失败数 ≥2 增长 → 回归
  latencyRegressionFactor: 1.5,         // 延迟 >1.5x 基线 → 回归
  latencyMinAbsoluteIncreaseMs: 1000,   // 且绝对增量 ≥1s（防小数值抖动）
})

// run() 执行所有用例，自动对比基线并持久化结果
const result = await benchmark.run()

// CI exit code: result.hasRegressions → exit(1)
console.log(result.hasRegressions ? '❌ 有回归' : '✅ 无回归')
console.log(`通过率: ${(result.summary.passRate * 100).toFixed(1)}%`)

// 退化 / 改进检测
for (const r of result.summary.regressions) {
  console.log(`⚠️  退化: ${r.target} — ${r.metric} 从 ${r.baseline} 变为 ${r.current}`)
}

// 报告: Markdown（人看） / JSON（CI 消费）
console.log(benchmark.generateReport(result))                          // markdown
console.log(benchmark.generateReport(result, { format: "json" }))      // JSON
```

### 回归检测维度

10 个检测维度，benchmark 结束后自动对比 baseline：

| 维度 | 检测内容 | 阈值 |
|------|---------|------|
| 通过率退化 | case 通过率下降 | ≥ 5pp |
| 失败数增长 | 单 case 失败数增长 | ≥ 2 |
| 延迟恶化 | P50/P99 延迟增长 | > 1.5x 且 ≥ 1s |
| 工具调用数 | 工具调用次数变化 | ± 30% |
| 熔断触发 | Circuit Breaker 触发次数 | 新增 |
| 空响应 | 连续空/极短响应 | 新增 |
| Token 消耗 | Token 使用量变化 | > 2x |
| 迭代次数 | 平均迭代次数变化 | ± 50% |
| 错误分布 | 新增错误类型 | 新增 |
| 计划步骤 | Plan-Solve 步骤数变化 | ± 50% |

### 结果结构

```ts
interface BenchmarkResult {
  summary: BenchmarkSummary
  cases: EvalResult[]
  hasRegressions: boolean       // 任一退化 → true，CI 直接 process.exit(1)
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
  baseline: number   current: number   description: string         // 描述
}
```

### 报告输出

```ts
// Markdown — 人类可读，贴 PR 里
benchmark.generateReport(result)

// JSON — CI 消费
benchmark.generateReport(result, { format: "json" })
```

### CI 注解输出

`ciAnnotations()` 自动检测 CI 环境，输出原生注解格式：

| CI 平台 | 输出格式 | 说明 |
|------|---------|------|
| GitHub Actions | `::warning` / `::error` 命令 | 自动检测 |
| GitLab CI | Code Quality JSON | `gl-code-quality-report.json` |
| 通用 | 纯文本警告 | 降级输出 |

```ts
// 自动检测
console.log(benchmark.ciAnnotations(result));

// 显式指定
console.log(benchmark.ciAnnotations(result, "github"));
console.log(benchmark.ciAnnotations(result, "gitlab"));
```

### CI Pipeline 集成

```yaml
# .gitlab-ci.yml
agent-benchmark:
  stage: test
  script:
    - npx tsx scripts/benchmark.mjs > gl-code-quality-report.json
  artifacts:
    paths:
      - gl-code-quality-report.json      # GitLab Code Quality widget
      - .kagent-benchmarks/              # 下次 run 的 baseline
    when: always
  allow_failure: false                   # 回归 → pipeline ❌ → 阻塞合入
```

```js
// scripts/benchmark.mjs
import { Benchmark, ReActAgent, ... } from "kagent-ts";

const b = new Benchmark({
  name: "agent-regression",
  agentFactory: (e) => new ReActAgent({ llm: provider, tools, hooks: [e] }),
  cases: [...],
  baselinePath: "latest",     // 自动取上次 CI artifact
  outputDir: ".kagent-benchmarks",
});

const result = await b.run();

// 输出 Code Quality JSON → GitLab 自动展示在 MR 上
console.log(b.ciAnnotations(result));

// 有回归 → 非零退出 → pipeline 变红
process.exit(result.hasRegressions ? 1 : 0);
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
  baselinePath: 'latest',   // 自动取上次 run 的结果对比
})

const benchmarkResult = await benchmark.run()
console.log(benchmarkResult.hasRegressions ? '❌ 有回归' : '✅ 无回归')
console.log(`通过率: ${(benchmarkResult.summary.passRate * 100).toFixed(1)}%`)
for (const r of benchmarkResult.summary.regressions) {
  console.log(`⚠️  ${r.description}`)
}
```