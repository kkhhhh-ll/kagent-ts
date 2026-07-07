# Fallback Provider

`FallbackProvider` 实现主备 Provider 链式降级。当主 Provider 出现网络错误时，自动切换到下一个备用 Provider。

## 基本用法

```ts
import { FallbackProvider, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const provider = new FallbackProvider({
  providers: [
    // 主 Provider
    new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: 'claude-sonnet-4-6',
    }),
    // Fallback #1
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o',
    }),
    // Fallback #2
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
interface FallbackConfig {
  /** Provider 列表 (按优先级从高到低排序) */
  providers: LLMProvider[]

  /** 每个 Provider 的最大重试次数 (默认: 2) */
  maxRetriesPerProvider?: number
}
```

## 完整示例

```ts
import { ReActAgent, FallbackProvider, AnthropicProvider, OpenAIProvider } from 'kagent-ts'

const provider = new FallbackProvider({
  providers: [
    new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: 'claude-sonnet-4-6',
    }),
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o',
    }),
  ],
  maxRetriesPerProvider: 2,
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
  routes: {
    main: new FallbackProvider({
      providers: [
        new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
        new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
      ],
    }),
    subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
  },
})
```

## 下一步

- [Rate Limiter](/llm/rate-limiter) — 为 Provider 添加限流
- [Model Router](/llm/model-router) — 按任务类型路由不同模型
- [Token Budget](/llm/token-budget) — 控制会话 Token 消耗
