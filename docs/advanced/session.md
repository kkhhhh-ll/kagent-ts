# 会话持久化

kagent-ts 提供自动 Checkpoint 持久化机制，支持会话的**保存、恢复、取消、优雅关闭**。即使发生网络中断，也能从中断点继续执行。

## 工作原理

```
Agent 执行循环
  ↓ (每次迭代后)
自动保存 Checkpoint  →  .kagent-sessions/<session-id>.json
  ↓
[发生网络错误?]
  ├── 保存 interrupted 状态 Checkpoint
  └── 继续执行
  ↓
用户可以 resume(sessionId) 恢复
```

## 基本用法

### 创建持久化会话

通过 `sessionId` 指定会话标识：

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  llm: provider,
  tools: BUILTIN_TOOLS,
  sessionId: 'my-task-001',  // 指定 Session ID 以启用持久化
})

await agent.run('分析项目结构')
```

### 恢复中断的会话

```ts
// 发生网络中断后...
// 恢复会话 (可选的继续提示)
const answer = await agent.resume('my-task-001', '继续之前的分析')
console.log(answer)
```

## 会话文件

会话保存在 `.kagent-sessions/` 目录下，每个会话一个 JSON 文件：

```
.kagent-sessions/
├── my-task-001.json
├── code-review-2024.json
└── ...
```

## 会话状态结构

```ts
interface SessionState {
  sessionId: string
  agentType: 'react' | 'plan-solve' | 'fusion' | 'orchestrator'
  status: SessionStatus
  systemPrompt: string
  messages: MessageData[]
  agentState: PlanSolveSessionState | FusionSessionState | OrchestratorSessionState
  metadata: {
    createdAt: string
    updatedAt: string
    iterations: number
    toolCalls: number
    tokenUsage: number
    input: string
  }
}

enum SessionStatus {
  ACTIVE = 'active',
  INTERRUPTED = 'interrupted',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}
```

## SessionManager API

可以直接使用 `SessionManager` 管理会话：

```ts
import { SessionManager } from 'kagent-ts'

const manager = new SessionManager('./.kagent-sessions')

// 列出所有会话
const sessions = await manager.listSessions()
for (const s of sessions) {
  console.log(`${s.sessionId}: ${s.status} (${s.metadata.iterations} 轮)`)
}

// 加载会话
const state = await manager.loadSession('my-task-001')

// 保存 Checkpoint
await manager.saveCheckpoint(state)

// 标记会话状态
await manager.markStatus('my-task-001', 'completed')

// 删除会话
await manager.deleteSession('my-task-001')
```

## 不同 Agent 的会话状态

### Plan-Solve 会话状态

```ts
interface PlanSolveSessionState {
  currentPlan: string[]
  completedSteps: number[]
  replanCount: number
  currentStep: number
}
```

### Fusion 会话状态

```ts
interface FusionSessionState {
  routingResult: { complexity: string; reason: string }
  currentPlan: string[]
  completedSteps: number[]
  reflectionHistory: ReflectionResult[]
  phase: 'routing' | 'planning' | 'executing' | 'reflecting'
}
```

### Orchestrator 会话状态

```ts
interface OrchestratorSessionState {
  taskGraph: TaskGraph
  completedNodes: Map<string, string>
  currentRound: number
  synthesisResult?: string
}
```

## 网络错误处理

框架在网络错误时自动保存 `interrupted` 状态的 Checkpoint：

```ts
// 框架内部伪代码
try {
  await llmCall()
} catch (error) {
  if (error instanceof LLMNetworkError) {
    await sessionManager.saveCheckpoint({
      ...state,
      status: 'interrupted',
    })
    throw new Error(
      `网络中断，会话已保存。使用 agent.resume("${sessionId}") 恢复。`
    )
  }
}
```

## 完整示例

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

async function runWithRetry() {
  const agent = new ReActAgent({
    systemPrompt: '你是一个有用的 AI 助手。',
    llm: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' }),
    tools: BUILTIN_TOOLS,
    sessionId: 'important-task',
  })

  try {
    const answer = await agent.run('请分析整个 src/ 目录的代码结构并生成报告。')
    console.log('完成:', answer)
  } catch (error) {
    console.error('执行中断:', error)
    console.log('可以稍后调用 agent.resume() 恢复')
  }
}
```

## 下一步

- [上下文管理](/advanced/context-compression) — 控制长对话的 Token 使用
- [Reflection 反思](/advanced/reflection) — 执行后的自我反思
- [Trace 追踪](/advanced/trace) — 生成执行追踪日志
