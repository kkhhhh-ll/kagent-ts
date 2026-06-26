# API - Tools

## Tool 接口

```ts
interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute(args: Record<string, unknown>): Promise<ToolResult>
  requireApproval?: boolean
  sequential?: boolean
}
```

---

## ToolResult

```ts
interface ToolResult {
  success: boolean
  content: string
  severity?: "info" | "warning" | "error" | "critical"
  errorCode?: ToolErrorCode
}

enum ToolErrorCode {
  SUCCESS = "SUCCESS"
  UNKNOWN_TOOL = "UNKNOWN_TOOL"
  CIRCUIT_OPEN = "CIRCUIT_OPEN"
  EXECUTION_FAILURE = "EXECUTION_FAILURE"
  ARGUMENTS_PARSE_ERROR = "ARGUMENTS_PARSE_ERROR"
  TRUNCATED_OUTPUT = "TRUNCATED_OUTPUT"
  INTERNAL_ERROR = "INTERNAL_ERROR"
  APPROVAL_DENIED = "APPROVAL_DENIED"
  VALIDATION_ERROR = "VALIDATION_ERROR"
}
```

### 辅助函数

```ts
import { toolSuccess, toolError } from 'kagent-ts'

// 创建成功结果
toolSuccess(content: string): ToolResult

// 创建错误结果
toolError(code: ToolErrorCode, content: string): ToolResult
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
  registerAll(tools: Tool[]): void
  registerAllBuiltinTools(): void
  lookup(name: string): Tool | undefined
  getAll(): Tool[]
  remove(name: string): boolean
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>
  forSubAgent(filter: ToolFilter): ToolRegistry
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
  threshold?: number          // 默认: 3
  resetTimeoutMs?: number     // 默认: 60000
}

enum BreakerState {
  CLOSED = "CLOSED"
  OPEN = "OPEN"
}

interface BreakerStatus {
  state: BreakerState
  consecutiveFailures: number
  remainingRetries: number
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

```ts
import { ToolErrorTracker, categorizeError } from 'kagent-ts'

class ToolErrorTracker {
  constructor(config: ErrorTrackerConfig)
  recordFailure(toolName: string, error: ToolResult): void
  recordAnalysis(thought: string): void
  recordRecovery(success: boolean): void
  extractRuleFromTrace(): ErrorRule | null
  buildRulesPrompt(): string
}

interface ErrorTrackerConfig {
  maxTracesPerTool?: number   // 默认: 10
  storageDir?: string          // 默认: ".error-traces"
}

interface ErrorRule {
  pattern: string
  suggestion: string
  toolName: string
}

interface ToolErrorTrace {
  toolName: string
  events: TraceEvent[]
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
  createSkillTool,
  createRememberTool,
  createRecallTool,
  createListSubagentsTool,
  createSpawnSubagentTool,
  createListErrorsTool,
} from 'kagent-ts'
```

## 下一步

- [API - Messages](/api/messages) — Message 类型 API
- [API - Session](/api/session) — Session API
- [API - Context](/api/context) — Context & Compression API
