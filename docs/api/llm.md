# API - LLM

## LLMProvider 接口

```ts
interface LLMProvider {
  chat(messages: MessageData[], options?: LLMOptions): Promise<LLMResponse>
  chatStream(messages: MessageData[], options?: LLMOptions): AsyncIterable<LLMStreamEvent>
  getTokenCount(messages: MessageData[]): number
}
```

---

## LLMResponse

```ts
interface LLMResponse {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs?: number
  errorCode?: LLMResponseErrorCode
}

enum LLMResponseErrorCode {
  SUCCESS
  TIMEOUT
  CONNECTION_ERROR
  RATE_LIMITED
  SERVER_ERROR
  AUTH_ERROR
  BAD_REQUEST
  ABORT
  UNKNOWN
}
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
  model?: string                    // 默认: "gpt-4o"
  baseURL?: string                  // 默认: "https://api.openai.com/v1"
  timeout?: number                  // 默认: 60000
  maxRetries?: number               // 默认: 3
  temperature?: number
  maxTokens?: number
  topP?: number
  retryConfig?: OpenAIRetryConfig
}

interface OpenAIRetryConfig {
  maxRetries?: number               // 默认: 3
  initialBackoffMs?: number         // 默认: 1000
  maxBackoffMs?: number             // 默认: 30000
  backoffMultiplier?: number       // 默认: 2
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
  model?: string                    // 默认: "claude-sonnet-4-6"
  baseURL?: string
  timeout?: number                  // 默认: 60000
  maxRetries?: number               // 默认: 3
  maxTokens?: number
  cacheSystemPrompt?: boolean       // 默认: false
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
  providers: LLMProvider[]
  maxRetriesPerProvider?: number    // 默认: 2
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
  provider: LLMProvider
  maxCallsPerMinute: number
  windowSizeMs?: number             // 默认: 60000
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
  routes: {
    main: LLMProvider
    subAgent?: LLMProvider
    reflection?: LLMProvider
    lightweight?: LLMProvider
  }
}

// 方法
router.forSubAgent(): LLMProvider
router.forReflection(): LLMProvider
router.forLightweight(): LLMProvider
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
  baseURL?: string
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
