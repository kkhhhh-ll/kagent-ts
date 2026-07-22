# LLM 后端概述

kagent-ts 提供了完整的多 LLM Provider 支持体系，包括 Provider 实现、工厂函数、Fallback 降级、Rate Limiting 限流、Model Router 路由和 Token Budget 预算控制。

## 架构

```
LLMProvider (接口)
├── OpenAIProvider          # OpenAI API
├── AnthropicProvider       # Anthropic Claude API
├── FallbackProvider        # 主备降级包装器
├── RateLimitedProvider     # 滑动窗口限流包装器
└── ModelRouter             # 多模型路由分发器

createLLMProvider()         # 工厂函数 (自动检测 Provider 类型)
```

## 快速选择

| 场景 | 推荐 Provider |
|-----------|------|
| OpenAI 兼容 | `OpenAIProvider` |
| Claude 系列 | `AnthropicProvider` |
| 主备切换 | `FallbackProvider` |
| 限流控制 | `RateLimitedProvider` |
| 多模型路由 | `ModelRouter` |

## 通用接口

所有 Provider 都实现 `LLMProvider` 接口：

```ts
interface LLMProvider {
  /** 当前使用的模型标识符 */
  readonly model: string

  /** 非流式调用 */
  chat(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): Promise<LLMResponse>

  /** 流式调用 */
  chatStream(messages: MessageData[], tools?: Tool[], signal?: AbortSignal): AsyncIterable<LLMStreamEvent>

  /** 估算 Token 数量 */
  getTokenCount(text: string, model?: string): number
}
```

## 错误处理

所有 Provider 内置统一的错误处理策略：

- **自动重试** (瞬态错误): Timeout、Connection Error、429 Rate Limit、5xx Server Error
- **立即传播** (不可恢复): 401 Unauthorized、400 Bad Request、Abort Error
- **指数退避 + Jitter**: 避免惊群效应

## 下一步

- [OpenAI Provider](/llm/openai) — OpenAI API 详细配置
- [Anthropic Provider](/llm/anthropic) — Anthropic Claude API 详细配置
- [Fallback Provider](/llm/fallback) — 主备降级
- [Rate Limiter](/llm/rate-limiter) — 限流控制
- [Model Router](/llm/model-router) — 多模型路由
- [Token Budget](/llm/token-budget) — Token 消耗控制
