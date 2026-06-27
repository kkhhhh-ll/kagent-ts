# Circuit Breaker

Circuit Breaker（熔断器）为每个工具提供独立的故障保护。当工具连续失败一定次数后，自动"熔断"以阻止级联故障。

## 原理

```
状态: CLOSED (正常)
  ├── 首次失败 → HALF_OPEN (半熔断 / 降级)
  ├── 后续失败 → HALF_OPEN (仍在重试预算内) 或 OPEN (熔断)
  ├── 成功后恢复 → CLOSED

状态: HALF_OPEN (半熔断)
  ├── 工具仍可使用（降级运行）
  ├── 成功 → CLOSED（恢复确认）
  ├── 失败且重试耗尽 → OPEN

状态: OPEN (熔断)
  ├── 后续调用直接返回 CIRCUIT_OPEN 错误
  ├── 错误消息中包含熔断状态信息
  └── LLM 可以看到熔断信息并调整策略
```

## 状态转换

```ts
enum BreakerState {
  CLOSED     = "closed",      // 正常状态 — 无失败，工具正常可用
  HALF_OPEN  = "half_open",   // 半熔断 — 已发生失败但仍有重试机会，工具可用但需谨慎
  OPEN       = "open",        // 熔断 — 重试耗尽，工具被阻止
}
```

| 转换 | 条件 |
| ---- | ---- |
| **CLOSED → HALF_OPEN** | 首次失败发生 |
| **HALF_OPEN → HALF_OPEN** | 继续失败但仍未超过重试上限 |
| **HALF_OPEN → OPEN** | 连续失败超过 `retryCount`，重试耗尽 |
| **HALF_OPEN → CLOSED** | 执行成功，失败计数清零 |
| **任意状态 → CLOSED** | 手动调用 `reset()` |

## 配置

Circuit Breaker 默认集成在 `ToolRegistry` 中，通过 `AgentConfig` 配置：

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider,
  tools: BUILTIN_TOOLS,
  breakerConfig: {
    retryCount: 2,             // 首次失败后的重试次数 (默认: 2 → 共 3 次尝试)
  },
})
```

## LLM 感知

### 半熔断状态 (HALF_OPEN)

当工具进入半熔断状态时，LLM 会收到降级警告：

```
⚠️  工具 "read_file" 的熔断器已进入降级状态（HALF_OPEN）。
还有 1 次重试机会。请分析错误原因，修正参数后重试。
```

当重试次数耗尽（即将熔断）时：

```
⚠️  工具 "read_file" 的熔断器已进入降级状态（HALF_OPEN）。
下一次失败将永久禁用此工具。请务必谨慎操作。
```

### 熔断状态 (OPEN)

当工具完全熔断时，LLM 会收到清晰的错误信息：

```text
[FATAL:CIRCUIT_OPEN] Tool "read_file" has been disabled after 3 consecutive failures.
It cannot be used again in this session.
Please find a completely different approach.
```

## 与错误追踪集成

Circuit Breaker 与 `ToolErrorTracker` 协同工作：

- `ToolErrorTracker` 在内存中记录每次失败 → 分析 → 恢复的完整生命周期
- `"circuit_half_open"` 事件类型用于记录半熔断状态
- `list_errors` 工具允许 LLM 在会话中实时查询当前错误状态
- 跨会话的错误学习由 [ErrorNotebook（错题本）](/advanced/reflection) 负责

## 完整示例

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。如果工具熔断了，请尝试其他方式。',
  provider: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  breakerConfig: {
    retryCount: 2,
  },
})
```

## 下一步

- [参数验证](/tools/validation) — JSON Schema 参数校验
- [内置工具](/tools/builtin-tools) — 所有内置工具
- [HITL 审批](/tools/approval) — 人工审批工具调用
