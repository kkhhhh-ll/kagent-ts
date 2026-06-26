# Rate Limiter

`RateLimitedProvider` 是一个 Provider 包装器，实现**滑动窗口**限流。确保 API 调用不会超过设定的频率限制。

## 基本用法

```ts
import { RateLimitedProvider, OpenAIProvider } from 'kagent-ts'

const provider = new RateLimitedProvider({
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  maxCallsPerMinute: 50,  // 每分钟最多 50 次调用
})
```

## 配置参数

```ts
interface RateLimitConfig {
  /** 被包装的 Provider */
  provider: LLMProvider

  /** 每分钟最大调用次数 */
  maxCallsPerMinute: number

  /** 窗口大小 ms (默认: 60000) */
  windowSizeMs?: number
}
```

## 原理

`RateLimitedProvider` 使用滑动窗口算法追踪最近一段时间的调用次数：

```
时间轴 →
[调用1] [调用2] [调用3] ... [调用N]
|←──────── 时间窗口 ────────→|

如果窗口内调用次数 >= maxCallsPerMinute
  → 等待直到窗口滑动出空间
```

## 完整示例

```ts
import { ReActAgent, RateLimitedProvider, OpenAIProvider } from 'kagent-ts'

const provider = new RateLimitedProvider({
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  maxCallsPerMinute: 30,
})

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider,
  tools: [],
})
```

## 组合使用

`RateLimitedProvider` 可以与其他 Provider 包装器组合：

```ts
import {
  RateLimitedProvider,
  FallbackProvider,
  OpenAIProvider,
  AnthropicProvider
} from 'kagent-ts'

// 带限流的 Fallback 链
const provider = new RateLimitedProvider({
  provider: new FallbackProvider({
    providers: [
      new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
      new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
    ],
  }),
  maxCallsPerMinute: 30,
})
```

## 下一步

- [Fallback Provider](/llm/fallback) — 主备自动切换
- [Model Router](/llm/model-router) — 按任务类型路由不同模型
- [Token Budget](/llm/token-budget) — 控制 Token 消耗而非调用次数
