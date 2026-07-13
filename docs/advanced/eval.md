# Eval 评估

kagent-ts 提供完整的评估框架，包括工具调用指标收集、端到端测试执行、基准回归测试。

## 评估组件

```
Eval 框架
├── ToolCallEvaluator  → 工具调用指标收集
├── EvalRunner         → 端到端测试用例执行
└── Benchmark          → 基线回归测试
```

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
  latencySamples: number[]        // 延迟样本（内部用）
}
```

## EvalRunner

端到端评估：定义测试用例，创建 Agent 并自动校验结果。

```ts
import { EvalRunner, ReActAgent, ModelRouter } from 'kagent-ts'

// 方式 1: 传入 llm（ModelRouter）→ 自动走 forReflection() 做 unbiased review
const runner = new EvalRunner({
  llm: router,  // ModelRouter 实例
  defaultTimeoutMs: 120_000,
})

// 方式 2: 显式指定 judgeLLM（完全控制评判模型）
const runner2 = new EvalRunner({
  judgeLLM: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
})

// 方式 3: 都不传 → 跳过 LLM 评判（仅做工具调用 / 输出匹配检查）
const runner3 = new EvalRunner()

const results = await runner.run(
  // Agent 工厂 — 每个用例创建一个全新 Agent
  (evaluator) => new ReActAgent({
    systemPrompt: '你是一个有用的 AI 助手。',
    llm: provider,
    tools: BUILTIN_TOOLS,
    hooks: [evaluator],  // ← 必须挂上，否则拿不到工具调用指标
  }),
  [
    {
      name: '分析项目结构',
      input: '列出 src/ 目录下所有 .ts 文件并按大小排序',
      expectedTools: ['glob_search'],
      expectedOutput: '.ts',
    },
    {
      name: '代码审查',
      input: '审查 src/core/react-agent.ts 的代码质量',
      expectedTools: ['read_file'],
      timeoutMs: 60_000,
    },
  ],
)

for (const r of results) {
  console.log(`${r.caseName}: ${r.passed ? '✅' : '❌'} (${r.durationMs}ms, ${r.iterations} 轮)`)
  if (r.failures.length > 0) console.log('  失败原因:', r.failures.join(', '))
  if (r.llmJudgment) console.log('  质量评分:', r.llmJudgment.score, '-', r.llmJudgment.reasoning)
}
```

### 测试用例

```ts
interface EvalCase {
  name: string                // 用例名称
  input: string               // 用户输入
  expectedTools?: string[]    // 必须调用的工具（全部调用至少一次才通过）
  forbiddenTools?: string[]   // 禁止调用的工具（调用任一则失败）
  expectedOutput?: string     // 答案中必须包含的字符串或正则
  maxIterations?: number      // 最大迭代次数（覆盖 Agent 默认值）
  timeoutMs?: number          // 超时时间（默认: 120_000）
}
```

### 结果结构

```ts
interface EvalResult {
  caseName: string            // 用例名称
  passed: boolean             // 是否通过所有检查
  answer: string              // Agent 最终回答
  toolCalls: string[]         // 实际调用的工具列表
  iterations: number          // 实际迭代轮数
  durationMs: number          // 耗时
  scorecard: ToolCallScorecard  // 工具调用评分卡
  llmJudgment?: LLMEvalJudgment // LLM 评判（仅当配置了 judgeLLM）
  failures: string[]          // 失败原因列表
}

interface LLMEvalJudgment {
  passed: boolean             // LLM 评委是否认可
  score: number               // 0–100 质量分
  reasoning: string           // 评判说明
  issues: string[]            // 发现的问题
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
console.log(`平均延迟: ${result.summary.avgLatencyMs}ms`)

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
  avgLatencyMs: number        // 每用例平均延迟
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

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
  ToolCallEvaluator,
  EvalRunner,
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

// ── 端到端评估 ──
// 传入 ModelRouter → judgeLLM 自动走 forReflection() 路由
const runner = new EvalRunner({ llm: router })
const results = await runner.run(
  (evaluator) => new ReActAgent({
    systemPrompt: '你是一个有用的 AI 助手。',
    llm: provider,
    tools: BUILTIN_TOOLS,
    hooks: [evaluator],
  }),
  [{
    name: '文件分析',
    input: '找出项目中使用 any 类型的文件',
    expectedTools: ['grep_search'],
    expectedOutput: 'any',
  }],
)
for (const r of results) {
  console.log(`${r.caseName}: ${r.passed ? '✅ 通过' : '❌ 失败'}`)
  if (r.llmJudgment) console.log(`  评分: ${r.llmJudgment.score}`)
}

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
    { name: 'grep-any', input: '查找所有使用 any 类型的文件' },
    { name: 'count-files', input: '统计 src/ 下 .ts 文件数' },
  ],
  baselinePath: './benchmark-baseline.json',
})

const benchmarkResult = await benchmark.run()
console.log(`通过率: ${(benchmarkResult.summary.passRate * 100).toFixed(1)}%`)
for (const r of benchmarkResult.summary.regressions) {
  console.log(`⚠️  ${r.description}`)
}
```