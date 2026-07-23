# API - Tools

## Tool 接口

```ts
interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute(args: Record<string, unknown>): Promise<string>
  requireApproval?: boolean
  sequential?: boolean
}
```

> **注意**：`execute()` 返回 `Promise<string>`（纯文本字符串）。`ToolRegistry.execute()` 会将其包装为 `ToolResult` 对象，并附加熔断保护和错误追踪。

---

## ToolResult

```ts
interface ToolResult {
  success: boolean
  content: string
  severity: "success" | "retryable" | "fatal"
  errorCode: ToolErrorCode
}

enum ToolErrorCode {
  SUCCESS = "success"
  UNKNOWN_TOOL = "unknown_tool"
  CIRCUIT_OPEN = "circuit_open"
  EXECUTION_FAILURE = "execution_failure"
  ARGUMENTS_PARSE_ERROR = "arguments_parse_error"
  TRUNCATED_OUTPUT = "truncated_output"
  INTERNAL_ERROR = "internal_error"
  APPROVAL_DENIED = "approval_denied"
  VALIDATION_ERROR = "validation_error"
}
```

### 辅助函数

```ts
import { toolSuccess, toolError } from 'kagent-ts'

// 创建成功结果
toolSuccess(content: string): ToolResult

// 创建错误结果（severity 默认为 "retryable"）
toolError(
  errorCode: ToolErrorCode,
  content: string,
  severity?: "retryable" | "fatal"
): ToolResult
```

---

## ToolRegistry

```ts
import { ToolRegistry } from 'kagent-ts'

const registry = new ToolRegistry()
```

### 方法

```ts
class ToolRegistry {
  register(tool: Tool): void
  registerMany(tools: Tool[]): void
  getTool(name: string): Tool | undefined
  getTools(): Tool[]
  remove(name: string): boolean
  removeMany(names: string[]): void
  has(name: string): boolean
  get count(): number
  get toolNames(): string[]
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>
  filter(filter: ToolFilter): ToolRegistry
  getErrorTracker(): ToolErrorTracker
  getBreakerStatus(name: string): BreakerStatus
  getAllBreakerStatuses(): BreakerStatus[]
  resetBreaker(name: string): void
  resetAllBreakers(): void
}
```

---

## CircuitBreaker

```ts
import { CircuitBreaker } from 'kagent-ts'

new CircuitBreaker(config: CircuitBreakerConfig)
```

```ts
interface CircuitBreakerConfig {
  toolName: string             // 工具名称
  retryCount?: number          // 首次失败后的重试次数 (默认: 2)
}

enum BreakerState {
  CLOSED = "closed"            // 正常 — 无失败
  HALF_OPEN = "half_open"      // 半熔断 — 已有失败但工具仍可用
  OPEN = "open"                // 熔断 — 工具被阻止
}

interface BreakerStatus {
  toolName: string
  state: BreakerState
  failureCount: number
  failureThreshold: number
  available: boolean
}
```

---

## Tool Filters

```ts
import {
  allowlist,
  denylist,
  pattern,
  all,
  any,
  filterTools,
} from 'kagent-ts'

type ToolFilter = (tool: Tool) => boolean

allowlist(...names: string[]): ToolFilter
denylist(...names: string[]): ToolFilter
pattern(regex: RegExp): ToolFilter
all(...filters: ToolFilter[]): ToolFilter
any(...filters: ToolFilter[]): ToolFilter
filterTools(tools: Tool[], filter: ToolFilter): Tool[]
```

---

## ToolValidator

```ts
import { validateToolArgs } from 'kagent-ts'

validateToolArgs(tool: Tool, args: Record<string, unknown>): ValidationResult
```

---

## ToolOutputTruncator

```ts
import { ToolOutputTruncator } from 'kagent-ts'

class ToolOutputTruncator {
  constructor(maxSize?: number)  // 默认: 200KB
  truncate(output: string, toolName: string): string
}
```

---

## ToolErrorTracker

会话内的工具失败链追踪（纯内存，无持久化）。错误信息通过工具输出的 `[RETRYABLE:*]` / `[FATAL:*]` 标签直接返回给 LLM。

> **注意**：跨会话的错误学习和规则注入请使用 [Memory 记忆](/advanced/memory) 系统。

```ts
import { ToolErrorTracker, categorizeError } from 'kagent-ts'

const tracker = new ToolErrorTracker()

class ToolErrorTracker {
  constructor()
  recordFailure(toolName: string, args: object, error: string, retriesRemaining: number, breakerState?: string): string
  recordRecovery(toolName: string, traceId: string, resolution?: string): void
  recordAnalysis(traceId: string, analysis: string): void
  getActiveTraceId(toolName: string): string   getActiveTraces(): Array<{ toolName: string; traceId: string }>
  getAllSummaries(): ErrorTraceSummary[]
  generateMarkdownReport(): string
  clear(): void
}
```

---

## Error Trace 类型

```ts
interface TraceEvent {
  type: "failure" | "recovery" | "analysis"
  timestamp: string
  error?: string
  attemptNumber?: number
  retriesRemaining?: number
  analysis?: string
  resolution?: string
  arguments?: Record<string, unknown>
}

interface ToolErrorTrace {
  traceId: string
  toolName: string
  sessionId?: string
  createdAt: string
  updatedAt: string
  resolved: boolean
  originalArguments: Record<string, unknown>
  events: TraceEvent[]
  resolution?: string
}

interface ErrorTraceSummary {
  traceId: string
  toolName: string
  createdAt: string
  resolved: boolean
  errorCount: number
  firstError: string
  resolution?: string
}
```

---

## 内置工具

```ts
import {
  BUILTIN_TOOLS,               // Tool[]
  BUILTIN_TOOL_NAMES,          // string[]
  registerAllBuiltinTools,     // (registry: ToolRegistry) => void
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GrepSearchTool,
  GlobSearchTool,
  BashTool,
  WebFetchTool,
  createSkillTool,
  createRememberTool,
  createRecallTool,
  createSpawnSubagentTool,
  createListErrorsTool,
} from 'kagent-ts'
```

## 下一步

- [API - Messages](/api/messages) — Message 类型 API
- [API - Session](/api/session) — Session API
- [API - Context](/api/context) — Context & Compression API
