# Logging 日志

kagent-ts 提供结构化日志接口，框架内部所有日志都通过 `Logger` 接口输出。你可以使用内置实现（`ConsoleLogger`、`SilentLogger`），也可以接入自己的日志系统。

## Logger 接口

```ts
interface Logger {
  debug(tag: string, message: string, context?: Record<string, unknown>): void
  info(tag: string, message: string, context?: Record<string, unknown>): void
  warn(tag: string, message: string, context?: Record<string, unknown>): void
  error(tag: string, message: string, context?: Record<string, unknown>): void

  /** 创建带有预绑定上下文的子 Logger */
  child(bindings: Record<string, unknown>): Logger
}
```

所有日志方法共享统一的签名：

- **tag**：日志来源标签，如 `"SessionManager"`、`"CircuitBreaker"`、`"GitWorktree"`
- **message**：日志消息文本
- **context**：可选的上下文对象，携带结构化数据

### child() — 预绑定上下文

`child()` 创建一个新的 Logger 实例，该实例会在每次日志调用时自动合并指定的 `bindings` 到 `context` 中。适合在请求级别为每条日志附加相同的字段（如 `requestId`）：

```ts
const logger = new ConsoleLogger();

// 为当前请求创建子 Logger
const reqLog = logger.child({ requestId: "abc-123" });

reqLog.info("HTTP", "Request started");
// → [HTTP] Request started {"requestId":"abc-123"}

reqLog.error("HTTP", "Request failed", { status: 500 });
// → [HTTP] Request failed {"requestId":"abc-123","status":500}
```

合并规则：`bindings` + 当次调用的 `context`，**当次传入的 key 优先级更高**。

## 日志级别

`LogLevel` 枚举定义了四个级别（按严重程度递增）：

| 级别 | 值 | 含义 |
| --- | --- | --- |
| `DEBUG` | 0 | 详细诊断信息，生产环境通常关闭 |
| `INFO` | 1 | Agent 生命周期和进度信息 |
| `WARN` | 2 | 非致命问题，运维人员应关注 |
| `ERROR` | 3 | 致命或接近致命的问题 |

使用时通过 `minLevel` 控制输出最低级别——只有 `level >= minLevel` 的消息才会输出：

```ts
import { ConsoleLogger, LogLevel } from 'kagent-ts';

// 默认：输出所有级别（DEBUG 及以上）
const devLogger = new ConsoleLogger();

// 生产环境：只输出 WARN 和 ERROR
const prodLogger = new ConsoleLogger({ minLevel: LogLevel.WARN });

// 完全静默（效果等同 SilentLogger）
const disabledLogger = new ConsoleLogger({ enabled: false });
```

## 内置实现

### ConsoleLogger

输出到 `console`，带有 `[Tag]` 前缀。支持多种配置选项：

```ts
import { ConsoleLogger, LogLevel } from 'kagent-ts';

// 默认配置
const logger = new ConsoleLogger();

// 带配置
const logger = new ConsoleLogger({
  minLevel: LogLevel.INFO,  // 最低输出级别，默认 DEBUG
  enabled: true,            // 是否启用，默认 true；设为 false 可完全静默
  bindings: {},             // 初始绑定上下文
});

logger.info("MyAgent", "任务开始", { taskId: "123" });
// 输出: [MyAgent] 任务开始 {"taskId":"123"}
```

方法 → console 映射：

| 方法 | console 方法 |
| --- | --- |
| `debug()` | `console.debug()` |
| `info()` | `console.log()` |
| `warn()` | `console.warn()` |
| `error()` | `console.error()` |

### SilentLogger

丢弃所有日志消息。每个方法都是纯空函数体，零运行时开销。适用于测试或需要完全静默的环境：

```ts
import { SilentLogger } from 'kagent-ts';

const logger = new SilentLogger();
// debug / info / warn / error 全部为空操作

// child() 返回 this，因为空操作不需要区分实例
logger.child({ requestId: "1" }) === logger; // true
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

接入外部日志库（如 winston、pino）时，需要实现完整的 `Logger` 接口（**包括 `child()`**）：

```ts
import { Logger } from 'kagent-ts'
import pino from 'pino'

class PinoLogger implements Logger {
  private bindings: Record<string, unknown>

  constructor(bindings: Record<string, unknown> = {}) {
    this.bindings = bindings
  }

  private merge(context?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (Object.keys(this.bindings).length === 0) return context
    return { ...this.bindings, ...context }
  }

  debug(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.debug(this.merge(context), `[${tag}] ${message}`)
  }
  info(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.info(this.merge(context), `[${tag}] ${message}`)
  }
  warn(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.warn(this.merge(context), `[${tag}] ${message}`)
  }
  error(tag: string, message: string, context?: Record<string, unknown>): void {
    pinoLogger.error(this.merge(context), `[${tag}] ${message}`)
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLogger({ ...this.bindings, ...bindings })
  }
}

const agent = new ReActAgent({
  // ...
  logger: new PinoLogger(),
})
```

## 外部库快速实现

如果你的日志库本身已经实现了 `child()`（如 pino、winston），可以更简单地包装：

```ts
import { Logger } from 'kagent-ts'
import pino from 'pino'

class PinoLoggerAdapter implements Logger {
  constructor(private pino: pino.Logger = pino()) {}

  debug(tag: string, msg: string, ctx?: Record<string, unknown>) { this.pino.debug(ctx, `[${tag}] ${msg}`) }
  info(tag: string, msg: string, ctx?: Record<string, unknown>)  { this.pino.info(ctx, `[${tag}] ${msg}`) }
  warn(tag: string, msg: string, ctx?: Record<string, unknown>)  { this.pino.warn(ctx, `[${tag}] ${msg}`) }
  error(tag: string, msg: string, ctx?: Record<string, unknown>) { this.pino.error(ctx, `[${tag}] ${msg}`) }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.pino.child(bindings))
  }
}
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
| Fork Agent | `"ForkAgent"` |

## 下一步

- [Trace 追踪](/advanced/trace) — HTML 格式的执行追踪，与日志互补
- [Agent 基类](/core/agent) — Agent 的完整配置参数
