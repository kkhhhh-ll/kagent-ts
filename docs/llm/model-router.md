# Model Router

`ModelRouter` 允许你为不同类型的任务配置不同的模型。它实现 `LLMProvider` 接口，对 Agent 完全透明。

## 基本用法

```ts
import { ModelRouter, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const router = new ModelRouter({
  main: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  subAgent: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),

    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  memory: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
  precipitation: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),

    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-haiku-4-5-20251001',
  }),
  lightweight: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
})
```

## 路由类型

|------|------|----------|

## 配置参数

```ts
interface ModelRouterConfig {
  /** 主模型（必填） */
  main: LLMProvider

  /** 子 Agent 专用模型（默认: main） */
  subAgent?: LLMProvider

  /** 错误反思专用模型（默认: main） */

  /** 记忆提取专用模型（默认: main） */
  memory?: LLMProvider

  /** Skill 沉淀专用模型（默认: main） */
  precipitation?: LLMProvider

  /** 答案验证专用模型（默认: main） */

  /** 轻量任务专用模型（默认: main） */
  lightweight?: LLMProvider

  /** 共享 Fallback 链（所有 route 的网络错误都会尝试这些 provider） */
  fallbacks?: LLMProvider[]
}
```

## 方法

```ts
// 获取子代理专用的 Provider
const subProvider = router.forSubAgent()

// 获取反思专用的 Provider

// 获取记忆提取专用的 Provider
const memoryProvider = router.forMemory()

// 获取 Skill 沉淀专用的 Provider
const precipitationProvider = router.forPrecipitation()

// 获取轻量任务专用的 Provider
const lightProvider = router.forLightweight()
```

每个方法在对应 route 未配置时自动回退到 `main`。

## 与 Agent 集成

Agent 会自动检测 `ModelRouter` 并为子代理、沉淀等选择合适的 Provider：

```ts
import { FusionAgent, ModelRouter, OpenAIProvider, AnthropicProvider } from 'kagent-ts'

const router = new ModelRouter({
  main: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  subAgent: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
  lightweight: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
  precipitation: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
})

const agent = new FusionAgent({
  llm: router,
  precipitation: "post-hoc",
  // Agent 会自动:
  // - 使用 main 路由执行主循环
  // - 使用 lightweight 路由进行任务复杂度分类（routeLLM）
  // - 使用 subAgent 路由运行子代理
  // - 使用 precipitation 路由进行 Skill 沉淀
})
```

所有自动解析的路由：

|------|-------------|--------------|

## 与 Reflection / Memory 集成

Reflection（
无需额外的 Hook：

```ts
const router = new ModelRouter({
  main: new OpenAIProvider({ model: 'gpt-4o' }),

  memory: new OpenAIProvider({ model: 'gpt-4o-mini' }),
})

const agent = new ReActAgent({
  llm: router,
    memoryReflection: "post-hoc",          // 记忆提取
  memoryReflectorLLM: router.forMemory(), // 记忆提取专用 LLM
})
```

Memory 提取可通过 `memoryReflectorLLM` 指定独立模型；

## 结合 Fallback

每个路由可以独立配置 Fallback 链，也可以使用共享的 `fallbacks`：

```ts
const router = new ModelRouter({
  main: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
  subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
  // 所有 route 共享的 fallback 链
  fallbacks: [
    new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  ],
})
```

也可以对单个 route 使用 `FallbackProvider`：

```ts
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

- [Token Budget](/llm/token-budget) — 控制会话 Token 消耗
- [Fallback Provider](/llm/fallback) — 主备自动切换
- - [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能
- [Sub-Agent 子代理](/advanced/subagents) — 子代理的详细配置
