# API - LLM

## LLMProvider 接口

```ts
interface LLMProvider {
  readonly model: string
  chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse>
  chatStream(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): AsyncIterable<LLMStreamEvent>
  getTokenCount(text: string, model?: string): number
}
```

---

## LLMResponse

```ts
interface LLMResponse {
  content: string
  tool_calls?: ToolCall[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  stop_reason?: string
  responseError?: {
    code: LLMResponseErrorCode
    message: string
  }
  providerMeta?: {
    model: string
    isFallback: boolean
  }
}

enum LLMResponseErrorCode {
  OK = "ok"
  MAX_TOKENS = "max_tokens"
  EMPTY = "empty"
  INVALID_JSON = "invalid_json"
  UNKNOWN = "unknown"
}
```

---

## LLMStreamEvent

```ts
interface LLMStreamChunk {
  type: "chunk"
  content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface LLMStreamDone {
  type: "done"
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  stop_reason?: "length" | string
}

type LLMStreamEvent = LLMStreamChunk | LLMStreamDone
```

---

## OpenAIProvider

```ts
import { OpenAIProvider } from 'kagent-ts'

new OpenAIProvider(config: OpenAIConfig)
```

```ts
interface OpenAIConfig {
  apiKey: string
  model: string                     // 必填
  baseURL?: string                  // 默认: "https://api.openai.com/v1"
  timeout?: number                  // 默认: 60000
  temperature?: number
  maxTokens?: number
  retry?: RetryConfig               // 重试配置
}
```

---

## AnthropicProvider

```ts
import { AnthropicProvider } from 'kagent-ts'

new AnthropicProvider(config: AnthropicConfig)
```

```ts
interface AnthropicConfig {
  apiKey: string
  model: string                     // 必填
  baseURL?: string
  timeout?: number                  // 默认: 60000
  temperature?: number
  maxTokens?: number
  retry?: RetryConfig               // 重试配置
  cacheSystemPrompt?: boolean       // 默认: false
}
```

---

## RetryConfig

```ts
interface RetryConfig {
  maxRetries?: number               // 默认: 3
  initialBackoffMs?: number         // 默认: 1000
  maxBackoffMs?: number             // 默认: 30000
  backoffMultiplier?: number        // 默认: 2
}
```

---

## FallbackProvider

```ts
import { FallbackProvider } from 'kagent-ts'

new FallbackProvider(config: FallbackProviderConfig)
```

```ts
interface FallbackProviderConfig {
  primary: LLMProvider              // 主 Provider（最先尝试）
  fallbacks: LLMProvider[]          // 降级 Provider 列表（按顺序尝试）
  logger?: Logger                   // 日志实例（默认: ConsoleLogger）
}
```

---

## RateLimitedProvider

```ts
import { RateLimitedProvider } from 'kagent-ts'

new RateLimitedProvider(config: RateLimitedProviderConfig)
```

```ts
interface RateLimitedProviderConfig {
  provider: LLMProvider             // 被包装的 Provider
  maxCallsPerMinute: number         // 每分钟最大调用次数
}
```

---

## ModelRouter

```ts
import { ModelRouter } from 'kagent-ts'

new ModelRouter(config: ModelRouterConfig)
```

```ts
interface ModelRouterConfig {
  /** 主模型（必填） */
  main: LLMProvider

  /** 子 Agent 专用模型（默认: main） */
  subAgent?: LLMProvider

  /** 反思专用模型（默认: main） */
  reflection?: LLMProvider

  /** 轻量任务专用模型（默认: main） */
  lightweight?: LLMProvider

  /** Skill 沉淀专用模型（默认: main） */
  precipitation?: LLMProvider

  /** 记忆提取专用模型（默认: main） */
  memory?: LLMProvider

  /** 共享 Fallback 链（所有 route 的网络错误都会尝试这些 provider） */
  fallbacks?: LLMProvider[]

  /** 日志实例（默认: ConsoleLogger） */
  logger?: Logger
}

// 方法
router.forSubAgent(): LLMProvider
router.forReflection(): LLMProvider
router.forLightweight(): LLMProvider
router.forPrecipitation(): LLMProvider
router.forMemory(): LLMProvider
```

---

## createLLMProvider

```ts
import { createLLMProvider } from 'kagent-ts'

createLLMProvider(config: LLMProviderConfig): LLMProvider
```

```ts
interface LLMProviderConfig {
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  baseURL?: string
  retry?: RetryConfig
  timeout?: number
  provider?: "openai" | "anthropic" | "auto"  // 默认: "auto"
}
```

---

## TokenBudget

```ts
import { TokenBudget } from 'kagent-ts'

new TokenBudget(config: TokenBudgetConfig)
```

```ts
interface TokenBudgetConfig {
  maxTokens: number
  warningThreshold?: number
}

interface TokenBudgetStatus {
  used: number
  remaining: number
  maxTokens: number
  warningThreshold: number
  isWarning: boolean
  isExhausted: boolean
}

interface TokenBudgetCost {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}
```

---

## LLMNetworkError

```ts
import { LLMNetworkError } from 'kagent-ts'

class LLMNetworkError extends Error {
  cause: NetworkErrorCause
  statusCode?: number
}

type NetworkErrorCause =
  | 'timeout'
  | 'connection'
  | 'rate_limited'
  | 'server_error'
  | 'abort'
  | 'dns'
  | 'tls'
```

## 下一步

- [API - Tools](/api/tools) — Tool 系统 API
- [API - Messages](/api/messages) — Message 类型 API
- [API - Session](/api/session) — Session API
