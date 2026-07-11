# Fallback Provider

`FallbackProvider` 实现主备 Provider 链式降级。当主 Provider 出现网络错误时，自动切换到下一个备用 Provider。

## 基本用法

```ts
import { FallbackProvider, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const provider = new FallbackProvider({
  // 主 Provider（最先尝试）
  primary: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  // 降级 Provider 列表（按顺序尝试）
  fallbacks: [
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o',
    }),
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    }),
  ],
})
```

## 降级策略

`FallbackProvider` 只对**网络错误**进行降级：

- ✅ **会触发降级**: Timeout、Connection Error、429 Rate Limit、5xx Server Error
- ❌ **不会触发降级**: 401 Unauthorized、400 Bad Request、Abort Error

这种策略确保认证错误和参数错误立即暴露给调用方，不会在 Provider 之间无意义重试。

## 配置参数

```ts
interface FallbackProviderConfig {
  /** 主 Provider（最先尝试） */
  primary: LLMProvider

  /** 降级 Provider 列表（按优先级从高到低排序） */
  fallbacks: LLMProvider[]

  /** 日志实例（默认: ConsoleLogger） */
  logger?: Logger
}
```

## 完整示例

```ts
import { ReActAgent, FallbackProvider, AnthropicProvider, OpenAIProvider } from 'kagent-ts'

const provider = new FallbackProvider({
  primary: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  fallbacks: [
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o',
    }),
  ],
})

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: provider,
  tools: [],
})
```

## 结合 ModelRouter

可以将 `FallbackProvider` 作为 `ModelRouter` 某个路由的后端：

```ts
import { ModelRouter, FallbackProvider, AnthropicProvider, OpenAIProvider } from 'kagent-ts'

const router = new ModelRouter({
  main: new FallbackProvider({
    primary: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
    fallbacks: [
      new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
    ],
  }),
  subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
})
```

## 下一步

- [Rate Limiter](/llm/rate-limiter) — 为 Provider 添加限流
- [Model Router](/llm/model-router) — 按任务类型路由不同模型
- [Token Budget](/llm/token-budget) — 控制会话 Token 消耗
