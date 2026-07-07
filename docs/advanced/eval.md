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

定义一个测试用例并执行端到端评估：

```ts
import { EvalRunner } from 'kagent-ts'

const runner = new EvalRunner({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
})

const testCase = {
  name: '分析项目结构',
  input: '列出 src/ 目录下所有 .ts 文件并按大小排序',
  expectedTools: ['GlobSearchTool', 'BashTool'],
  expectedKeywords: ['文件列表', '排序'],
}

const result = await runner.run(testCase)
console.log('通过:', result.passed)
console.log('实际使用工具:', result.toolsUsed)
console.log('评分:', result.score)
```

### 测试用例

```ts
interface EvalTestCase {
  /** 用例名称 */
  name: string

  /** 用户输入 */
  input: string

  /** 期望使用的工具 */
  expectedTools?: string[]

  /** 期望输出包含的关键字 */
  expectedKeywords?: string[]

  /** LLM 评判提示词 (可选) */
  judgePrompt?: string
}
```

### LLM 评判

当提供 `judgePrompt` 时，EvalRunner 会使用独立的 LLM 调用来评判输出质量：

```ts
const testCase = {
  name: '代码审查',
  input: '审查 src/core/react-agent.ts',
  judgePrompt: `请从以下维度评分 (0-10):
1. 是否识别了关键代码问题
2. 建议是否具体可行
3. 报告格式是否清晰`,
}

const result = await runner.run(testCase)
console.log('LLM 评分:', result.judgeScore)
```

## Benchmark

基准回归测试用于检测 Agent 行为的变化：

```ts
import { Benchmark } from 'kagent-ts'

const benchmark = new Benchmark({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  baselinePath: './benchmark-baseline.json',
})

// 运行基准测试
const results = await benchmark.run([
  { name: 'task-analysis', input: '分析项目结构' },
  { name: 'code-search', input: '查找所有未使用的导入' },
  { name: 'file-ops', input: '统计每个目录的 TypeScript 文件数量' },
])

// 与基线对比
const changes = benchmark.compareWithBaseline(results)
for (const change of changes) {
  if (change.type === 'regression') {
    console.log(`⚠️  退化: ${change.name} - ${change.description}`)
  } else if (change.type === 'improvement') {
    console.log(`✅ 进步: ${change.name} - ${change.description}`)
  }
}
```

### 检测内容

```ts
interface BenchmarkChange {
  name: string
  type: 'regression' | 'improvement' | 'new' | 'removed'
  description: string
  oldValue?: string | number
  newValue?: string | number
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

// ── 收集指标 ──
const evaluator = new ToolCallEvaluator()

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: provider,
  tools: BUILTIN_TOOLS,
  hooks: [evaluator],
})

await agent.run('分析项目结构')

// ── 端到端评估 ──
const runner = new EvalRunner({ judgeLLM: provider })

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
    expectedTools: ['GrepSearchTool'],
    expectedKeywords: ['any'],
    judgePrompt: '评估搜索结果是否准确且完整 (0-10)',
  }],
)

console.log('测试通过:', results[0].passed)
console.log('LLM 评分:', caseResult.judgeScore)

// ── 基准回归 ──
const benchmark = new Benchmark({
  llm: provider,
  tools: BUILTIN_TOOLS,
  baselinePath: './benchmark-baseline.json',
})

const benchmarkResults = await benchmark.run([
  { name: 'grep-any', input: '查找所有使用 any 类型的文件' },
  { name: 'count-files', input: '统计 src/ 下每个子目录的 .ts 文件数' },
])

const changes = benchmark.compareWithBaseline(benchmarkResults)
console.log('基准变化:', changes)
```

## 下一步

- [Reflection 反思](/advanced/reflection) — 反思结果可以作为评估输入
- [Trace 追踪](/advanced/trace) — 执行追踪提供评估的详细素材
- [生命周期钩子](/core/hooks) — 自定义评估指标收集
