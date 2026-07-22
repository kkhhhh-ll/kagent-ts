# Anthropic Provider

`AnthropicProvider` 支持 Anthropic Claude 系列模型，包括 Prompt Caching 和 Extended Thinking 等高级特性。

## 基本用法

```ts
import { AnthropicProvider } from 'kagent-ts'

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-6',
})
```

## 配置参数

```ts
interface AnthropicConfig {
  /** Anthropic API Key (必填) */
  apiKey: string

  /** 模型名称 (e.g. "claude-sonnet-4-6", "claude-opus-4-8") */
  model: string

  /** API Base URL */
  baseURL?: string

  /** 请求超时时间 ms (默认: 60000) */
  timeout?: number

  /** 重试配置 (默认: maxRetries=3, baseDelayMs=1000, maxDelayMs=30000) */
  retry?: RetryConfig

  /** 最大输出 Token 数 */
  maxTokens?: number

  /** 启用系统提示词缓存 (默认: false) */
  cacheSystemPrompt?: boolean
}
```

## 消息格式自动转换

`AnthropicProvider` 内部会自动将 OpenAI 格式的消息转换为 Anthropic 格式，无需手动处理：

```
OpenAI 格式                    Anthropic 格式
{role: "system"}    ──────→   system prompt
{role: "user"}      ──────→   {role: "user"}
{role: "assistant"} ──────→   {role: "assistant"}
{role: "tool"}      ──────→   tool_result content block
```

## Prompt Caching

Claude 的 Prompt Caching 可显著降低长系统提示词的 Token 成本：

```ts
const provider = new AnthropicProvider({
  apiKey: '...',
  model: 'claude-sonnet-4-6',
  cacheSystemPrompt: true,  // 缓存系统提示词
})
```

缓存适用于：
- 较长的系统提示词（>1024 tokens）
- 重复使用的 Skill 定义
- 静态的规则和约束

## Extended Thinking (Claude 4.x)

Claude 4.x 系列模型支持 Extended Thinking，框架会自动处理 thinking blocks：

```ts
const provider = new AnthropicProvider({
  apiKey: '...',
  model: 'claude-opus-4-8',    // 支持 extended thinking 的模型
  maxTokens: 16384,             // Thinking 块会消耗 max_tokens 预算
})
```

框架会自动将 thinking blocks 合并到响应的 `content` 中，对上层透明。

## 与 Agent 集成

```ts
import { FusionAgent, AnthropicProvider } from 'kagent-ts'

const agent = new FusionAgent({
  systemPrompt: '你是一个经验丰富的软件工程师。',
  llm: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
    cacheSystemPrompt: true,
  }),
  tools: [],
})
```

## 可用模型

| 模型 | 说明 |
|---------|------|
| `claude-opus-4-8` | 最强模型，适合复杂任务 |
| `claude-sonnet-4-6` | 性能与速度均衡 |
| `claude-haiku-4-5` | 轻量快速，适合简单任务 |

## 下一步

- [OpenAI Provider](/llm/openai) — OpenAI 系列模型
- [Fallback Provider](/llm/fallback) — 主备自动切换
- [Model Router](/llm/model-router) — 按任务类型路由不同模型
