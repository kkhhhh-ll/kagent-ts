# Token Budget

`TokenBudget` 提供会话级的 Token 消耗追踪和硬性上限控制。帮助你控制 API 成本。

## 基本用法

```ts
import { ReActAgent, OpenAIProvider, TokenBudget } from 'kagent-ts'

const budget = new TokenBudget({
  maxTokens: 100000,          // 硬性上限
  warningThreshold: 80000,    // 警告阈值 (80%)
})

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [],
  tokenBudgetConfig: budget,
})
```

## 配置参数

```ts
interface TokenBudgetConfig {
  /** Token 硬性上限 (超过后 Agent 停止) */
  maxTokens: number

  /** 警告阈值 (Token 数，超过时触发警告但继续) */
  warningThreshold?: number
}
```

## 工作原理

```
Token 消耗 → 累积追踪
  ↓
[达到警告阈值?]
  ├── 否 → 继续
  └── 是 → 触发 onWarning 回调 (可选的 UI 提示)
  ↓
[达到硬性上限?]
  ├── 否 → 继续
  └── 是 → Agent 停止执行，返回预算耗尽消息
```

## 完整示例

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [],
  tokenBudgetConfig: {
    maxTokens: 50000,
    warningThreshold: 40000,
  },
  hooks: [{
    onLLMEnd: (response) => {
      const tokens = response.usage?.total_tokens ?? 0
      console.log(`本次消耗: ${tokens} tokens`)
    },
  }],
})
```

## Token 计数

框架使用以下策略计算 Token：

1. **tiktoken 可用时** → 精确 Token 计数（按模型匹配编码器）
2. **tiktoken 不可用时** → 启发式算法（4字符 ≈ 1 Token）

安装 tiktoken 获得精确计数：

```bash
npm install tiktoken
```

## 下一步

- [Model Router](/llm/model-router) — 按任务类型路由不同模型
- [上下文管理](/advanced/context-compression) — 控制上下文窗口大小
- [Eval 评估](/advanced/eval) — 评估 Agent 执行效率
