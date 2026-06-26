# Model Router

`ModelRouter` 允许你为不同类型的任务配置不同的模型。它实现 `LLMProvider` 接口，对 Agent 完全透明。

## 基本用法

```ts
import { ModelRouter, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const router = new ModelRouter({
  routes: {
    main: new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: 'claude-sonnet-4-6',
    }),
    subAgent: new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    }),
    reflection: new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o',
    }),
    lightweight: new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    }),
  },
})
```

## 路由类型

| 路由 | 用途 | 推荐模型 |
|------|------|----------|
| `main` | 主 Agent 的执行循环 | Claude Sonnet / GPT-4o |
| `subAgent` | 子代理的任务执行 | GPT-4o-mini / Claude Haiku |
| `reflection` | 反思和评估 | GPT-4o / Claude Sonnet |
| `lightweight` | 轻量任务 (路由分类、简单判断) | GPT-4o-mini / Claude Haiku |

## 配置参数

```ts
interface ModelRouterConfig {
  /** 路由表 (必填，至少需要 'main' 路由) */
  routes: {
    main: LLMProvider
    subAgent?: LLMProvider
    reflection?: LLMProvider
    lightweight?: LLMProvider
  }
}
```

## 方法

```ts
// 获取子代理专用的 Provider
const subProvider = router.forSubAgent()

// 获取反思专用的 Provider
const reflectionProvider = router.forReflection()

// 获取轻量任务专用的 Provider
const lightProvider = router.forLightweight()
```

## 与 Agent 集成

Agent 会自动检测 `ModelRouter` 并为子代理和反思选择合适的 Provider：

```ts
import { FusionAgent, ModelRouter, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const agent = new FusionAgent({
  systemPrompt: '你是一个全能 AI 助手。',
  provider: new ModelRouter({
    routes: {
      main: new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: 'claude-sonnet-4-6',
      }),
      subAgent: new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'gpt-4o-mini',
      }),
      reflection: new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        model: 'gpt-4o',
      }),
    },
  }),
  // ...
})
// Agent 会自动:
// - 使用 main 路由执行主循环
// - 使用 subAgent 路由运行子代理
// - 使用 reflection 路由进行反思
```

## 结合 Fallback

每个路由可以独立配置 Fallback 链：

```ts
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

- [Token Budget](/llm/token-budget) — 控制会话 Token 消耗
- [Fallback Provider](/llm/fallback) — 主备自动切换
- [Sub-Agent 子代理](/advanced/subagents) — 子代理的详细配置
