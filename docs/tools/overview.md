# 工具系统概述

kagent-ts 的工具系统提供了一套完整的工具管理方案：从注册、执行、熔断保护、参数验证到输出截断和审批控制。

## 架构

```
Tool (接口)
  ↓
ToolRegistry (注册中心)
  ├── CircuitBreaker  → 熔断保护
  ├── ToolValidator   → JSON Schema 验证
  └── ToolOutputTruncator → 输出截断
  ↓
ToolErrorTracker (错误追踪)
  ↓
BUILTIN_TOOLS (13 个内置工具)
```

## Tool 接口

每个工具必须实现 `Tool` 接口：

```ts
interface Tool {
  /** 工具名称 (唯一标识) */
  name: string

  /** 工具描述 (提供给 LLM) */
  description: string

  /** 参数 JSON Schema */
  parameters: Record<string, unknown>

  /** 执行函数 */
  execute(args: Record<string, unknown>): Promise<ToolResult>

  /** 是否需要人工审批 (默认: false) */
  requireApproval?: boolean

  /** 是否必须串行执行 (默认: false) */
  sequential?: boolean
}
```

## ToolResult

```ts
interface ToolResult {
  /** 执行是否成功 */
  success: boolean

  /** 输出内容 */
  content: string

  /** 错误严重程度 */
  severity?: 'info' | 'warning' | 'error' | 'critical'

  /** 错误码 */
  errorCode?: ToolErrorCode
}

enum ToolErrorCode {
  SUCCESS = 'SUCCESS',
  UNKNOWN_TOOL = 'UNKNOWN_TOOL',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  EXECUTION_FAILURE = 'EXECUTION_FAILURE',
  ARGUMENTS_PARSE_ERROR = 'ARGUMENTS_PARSE_ERROR',
  TRUNCATED_OUTPUT = 'TRUNCATED_OUTPUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  APPROVAL_DENIED = 'APPROVAL_DENIED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}
```

## 快速开始

```ts
import { ReActAgent, OpenAIProvider, ToolRegistry, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,  // 使用所有内置工具
})
```

## 下一步

- [Tool Registry](/tools/tool-registry) — 注册和查找工具
- [Circuit Breaker](/tools/circuit-breaker) — 熔断保护机制
- [参数验证](/tools/validation) — JSON Schema 参数校验
- [内置工具](/tools/builtin-tools) — 13 个内置工具详解
