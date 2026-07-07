# Logging 日志

kagent-ts 提供结构化日志接口，框架内部所有日志都通过 `Logger` 接口输出。你可以使用内置实现（`ConsoleLogger`、`SilentLogger`），也可以接入自己的日志系统。

## Logger 接口

```ts
interface Logger {
  debug(tag: string, message: string, context?: Record<string, unknown>): void
  info(tag: string, message: string, context?: Record<string, unknown>): void
  warn(tag: string, message: string, context?: Record<string, unknown>): void
  error(tag: string, message: string, context?: Record<string, unknown>): void
}
```

所有方法共享统一的签名：
- **tag**：日志来源标签，如 `"SessionManager"`、`"CircuitBreaker"`、`"GitWorktree"`
- **message**：日志消息文本
- **context**：可选的上下文对象，携带结构化数据

## 内置实现

### ConsoleLogger

输出到 `console`，带有 `[Tag]` 前缀：

```ts
import { ConsoleLogger } from 'kagent-ts'

const logger = new ConsoleLogger()

logger.info('MyAgent', '任务开始', { taskId: '123' })
// 输出: [MyAgent] 任务开始
```

日志级别映射：
| 方法 | console 方法 |
| --- | --- |
| `debug()` | `console.debug()` |
| `info()` | `console.log()` |
| `warn()` | `console.warn()` |
| `error()` | `console.error()` |

### SilentLogger

丢弃所有日志，适用于测试或静默环境：

```ts
import { SilentLogger } from 'kagent-ts'

const logger = new SilentLogger()
// 所有调用均为空操作，零开销
```

## 传入 Agent

所有 Agent 配置都支持 `logger` 参数：

```ts
import { ReActAgent, OpenAIProvider, ConsoleLogger } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  logger: new ConsoleLogger(),
  tools: [],
})
```

## 自定义 Logger

接入外部日志库（如 winston、pino）：

```ts
import { Logger } from 'kagent-ts'
import pino from 'pino'

const pinoLogger = pino()

class PinoLogger implements Logger {
  debug(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.debug(context, `[${tag}] ${message}`)
  }
  info(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.info(context, `[${tag}] ${message}`)
  }
  warn(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.warn(context, `[${tag}] ${message}`)
  }
  error(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.error(context, `[${tag}] ${message}`)
  }
}

const agent = new ReActAgent({
  // ...
  logger: new PinoLogger(),
})
```

## 框架内部的日志标签

各模块使用的 `tag` 前缀，方便日志过滤：

| 模块 | Tag |
| --- | --- |
| Session | `"SessionManager"` |
| Circuit Breaker | `"CircuitBreaker"` |
| Tool Registry | `"ToolRegistry"` |
| MCP | `"McpClientManager"` |
| Context | `"ContextManager"` |
| Compression | `"ProgressiveCompressor"` |
| Git Worktree | `"GitWorktreeManager"` |
| SubAgent | `"SubAgentManager"` |
| Memory | `"MemoryManager"` |
| Skills | `"SkillManager"` |
| RAG | `"RAGManager"` |

## 下一步

- [Trace 追踪](/advanced/trace) — HTML 格式的执行追踪，与日志互补
- [Agent 基类](/core/agent) — Agent 的完整配置参数
