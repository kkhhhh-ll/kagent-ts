# Circuit Breaker

Circuit Breaker（熔断器）为每个工具提供独立的故障保护。当工具连续失败一定次数后，自动"熔断"以阻止级联故障。

## 原理

```
状态: CLOSED (正常)
  ↓ 连续失败 N 次
状态: OPEN (熔断)
  ├── 后续调用直接返回 CIRCUIT_OPEN 错误
  ├── 错误消息中包含剩余重试次数
  └── LLM 可以看到熔断信息并调整策略
```

## 配置

Circuit Breaker 默认集成在 `ToolRegistry` 中，通过 `AgentConfig` 配置：

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider,
  tools: BUILTIN_TOOLS,
  breakerConfig: {
    threshold: 3,              // 连续失败 N 次后熔断 (默认: 3)
    resetTimeoutMs: 60000,     // 熔断恢复时间 ms (默认: 60000)
  },
})
```

## 状态转换

```ts
enum BreakerState {
  CLOSED = 'CLOSED',  // 正常状态，请求正常通过
  OPEN = 'OPEN',      // 熔断状态，请求被阻止
}
```

- **CLOSED → OPEN**: 连续失败达到 `threshold`
- **OPEN → CLOSED**: 超过 `resetTimeoutMs` 后自动恢复

## LLM 感知

当工具熔断时，LLM 会收到清晰的错误信息，帮助它调整策略：

```
工具 get_weather 返回错误:
[CIRCUIT_OPEN] 该工具已连续失败 3 次，暂时不可用。
剩余重试: 0/3。请尝试其他方式完成任务。
```

错误消息中包含的 `CIRCUIT_OPEN` 错误码会被注入到系统提示词的 `TOOL_ERROR_RECOVERY` 部分，告诉 LLM 如何响应。

## 完整示例

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。如果工具熔断了，请尝试其他方式。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  breakerConfig: {
    threshold: 3,
    resetTimeoutMs: 30000,
  },
})
```

## 与错误追踪集成

Circuit Breaker 与 `ToolErrorTracker` 协同工作：

- `ToolErrorTracker` 记录每次失败 → 分析 → 恢复的完整生命周期
- 从失败模式中提取规则，注入到系统提示词
- 持久化到 `.error-traces/` 目录

## 下一步

- [参数验证](/tools/validation) — JSON Schema 参数校验
- [内置工具](/tools/builtin-tools) — 所有内置工具
- [HITL 审批](/tools/approval) — 人工审批工具调用
