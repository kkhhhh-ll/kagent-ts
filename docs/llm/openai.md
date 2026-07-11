# OpenAI Provider

`OpenAIProvider` 是 kagent-ts 的默认 LLM Provider，支持所有兼容 OpenAI API 的服务。

## 基本用法

```ts
import { OpenAIProvider } from 'kagent-ts'

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
})
```

## 配置参数

```ts
interface OpenAIConfig {
  /** OpenAI API Key (必填) */
  apiKey: string

  /** 模型名称 (必填) */
  model: string

  /** API Base URL (默认: https://api.openai.com/v1) */
  baseURL?: string

  /** 请求超时时间 ms (默认: 60000) */
  timeout?: number

  /** 生成温度 (0-2) */
  temperature?: number

  /** 最大输出 Token 数 */
  maxTokens?: number

  /** 重试配置 */
  retry?: RetryConfig
}
```

## 兼容第三方服务

由于 `OpenAIProvider` 兼容 OpenAI API 协议，你可以用它连接任何兼容的服务：

### DeepSeek

```ts
const provider = new OpenAIProvider({
  apiKey: 'sk-...',
  model: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/v1',
})
```

### 其他兼容服务

```ts
// Azure OpenAI
const provider = new OpenAIProvider({
  apiKey: '...',
  model: 'gpt-4',
  baseURL: 'https://your-resource.openai.azure.com/openai/deployments/gpt-4',
})

// 本地模型 (Ollama, vLLM, etc.)
const provider = new OpenAIProvider({
  apiKey: 'not-needed',
  model: 'llama3',
  baseURL: 'http://localhost:11434/v1',
})
```

## 流式调用

```ts
const stream = provider.chatStream(messages)

for await (const event of stream) {
  if (event.type === 'chunk') {
    process.stdout.write(event.content)
  } else if (event.type === 'done') {
    console.log('\n完成:', event.usage)
  }
}
```

## 重试配置

```ts
interface RetryConfig {
  /** 最大重试次数 (默认: 3) */
  maxRetries?: number

  /** 初始退避时间 ms (默认: 1000) */
  initialBackoffMs?: number

  /** 最大退避时间 ms (默认: 30000) */
  maxBackoffMs?: number

  /** 退避倍数 (默认: 2) */
  backoffMultiplier?: number
}

const provider = new OpenAIProvider({
  apiKey: '...',
  model: 'gpt-4o',
  retry: {
    maxRetries: 5,
    initialBackoffMs: 500,
    maxBackoffMs: 15000,
    backoffMultiplier: 1.5,
  },
})
```

## 与 Agent 集成

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
    temperature: 0.3,
    maxTokens: 4096,
  }),
  tools: [],
})
```

## 下一步

- [Anthropic Provider](/llm/anthropic) — Claude 系列模型
- [Fallback Provider](/llm/fallback) — 主备自动切换
- [Model Router](/llm/model-router) — 多模型智能路由
