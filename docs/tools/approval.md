# HITL 审批

Human-In-The-Loop (HITL) 审批允许你在工具实际执行前进行人工确认，确保高风险操作（如 Shell 命令、文件写入、网络请求）在可控范围内。

## 基本用法

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider,
  tools: BUILTIN_TOOLS,
  onToolApproval: async (toolName, args) => {
    console.log(`\n⚠️  工具审批请求:`)
    console.log(`   工具: ${toolName}`)
    console.log(`   参数: ${JSON.stringify(args, null, 2)}`)
    console.log(`\n   允许执行? (y/n)`)

    // 在实际应用中，这里可以接入 UI 弹窗、消息队列等
    const answer = await getUserInput()
    return answer === 'y'
  },
})
```

## 超时配置

审批通过 `onToolApproval` 回调实现，但如果用户不在电脑前，Agent 就会一直挂起。框架内置了超时保护，避免无限等待。

### 配置参数

```ts
const agent = new ReActAgent({
  // ...
  onToolApproval: async (toolName, args) => {
    // 弹出 UI 或等待用户响应
    return await askUser(toolName, args);
  },
  approvalTimeoutMs: 120_000,           // 默认 2 分钟
  approvalTimeoutStrategy: "deny",      // "deny"（默认）| "allow"
})
```

### 超时策略

| 策略 | 超时后行为 | 适用场景 |
| ---- | ---- | ---- |
| `"deny"` (默认) | 拒绝工具执行，返回 `APPROVAL_DENIED`，LLM 必须找其他方法 | 通用场景——安全优先 |
| `"allow"` | 放行工具执行 | 非破坏性工具 + 可信环境 |

### 三种超时路径

```
onToolApproval() 被调用
  ├── 正常返回 true/false → 按返回值执行/拒绝
  ├── 超时（approvalTimeoutMs 内无响应）→ 按 approvalTimeoutStrategy 处理
  └── Agent 被 cancel() → 一律拒绝
```

与 `AbortController` 集成：调用 `agent.cancel()` 会立即中断挂起的审批等待，无需等到超时。

> **Fusion Agent 的计划确认**也使用同一套 `approvalTimeoutMs` 配置。计划确认超时时，Agent 会将计划以文本形式返回给用户，等待用户手动恢复执行。

## 审批回调

```ts
type ToolApprovalCallback = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<boolean>
```

- 返回 `true` → 执行工具
- 返回 `false` → 拒绝执行，返回 `APPROVAL_DENIED` 错误

## 工具级审批标记

通过 `requireApproval` 标记需要审批的特定工具：

```ts
const dangerousTool: Tool = {
  name: 'delete_files',
  description: '删除指定文件',
  parameters: { /* ... */ },
  requireApproval: true,  // 标记需要审批
  async execute(args) {
    // ...
  },
}
```

## 执行顺序

```
LLM 发起 tool_call
  ↓
1. 检查 requireApproval 标记
  ├── false → 跳过审批
  └── true  → 调用 onToolApproval()（带超时 + abort 保护）
       ├── 用户确认 → 继续
       ├── 用户拒绝 → 返回 APPROVAL_DENIED
       └── 超时/cancel → 按 approvalTimeoutStrategy 处理
  ↓
2. validateToolArgs() → 参数验证
  ↓
3. tool.execute() → 实际执行
```

## 审批拒绝处理

当审批被拒绝时，LLM 会收到清晰的反馈：

```
工具 bash 返回错误:
[APPROVAL_DENIED] 用户拒绝了该工具调用。
请尝试其他方式或向用户解释为什么需要执行该操作。
```

## 完整示例 (CLI 交互)

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'
import * as readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer))
  })
}

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  onToolApproval: async (toolName, args) => {
    console.log(`\n🔐 工具审批: ${toolName}`)
    console.log(JSON.stringify(args, null, 2))
    const answer = await ask('允许执行? (y/n): ')
    return answer.toLowerCase() === 'y'
  },
})

await agent.run('帮我查找并删除 src/ 目录下的临时文件')

rl.close()
```

## 安全建议

1. **高风险工具默认启用审批**: BashTool、WriteFileTool、EditFileTool
2. **使用审批标记**: 在自定义工具上合理设置 `requireApproval`
3. **结合白名单**: 审批模式下使用 `allowlist` 限制工具可用性
4. **配置超时**: 通过 `approvalTimeoutMs` 设置合理的等待上限（框架已内置超时保护，无需在回调中手动实现）

## 下一步

- [Circuit Breaker](/tools/circuit-breaker) — 自动熔断保护
- [参数验证](/tools/validation) — JSON Schema 参数校验
- [安全防护](/advanced/security) — Prompt Injection 防御
