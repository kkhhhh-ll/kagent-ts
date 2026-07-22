# API - Session

## SessionManager

```ts
import { SessionManager } from 'kagent-ts'

new SessionManager(config?: SessionManagerConfig)
```

```ts
interface SessionManagerConfig {
  sessionId?: string            // 会话 ID
  sessionDir?: string           // 会话存储目录
}
```

### 方法

```ts
class SessionManager {
  getSessionId(): string
  getSessionDir(): string
  setSessionId(id: string): void
  saveCheckpoint(state: SessionState): void
  loadSession(sessionId: string): SessionState | undefined
  listSessions(): SessionState[]
  deleteSession(sessionId: string): void
  markStatus(status: SessionStatus): void
}
```

> **注意**：所有方法均为同步方法（非 Promise）。会话数据以 JSON 文件形式存储在 `sessionDir` 目录下。

---

## SessionState

```ts
interface SessionState {
  sessionId: string
  agentType: AgentType
  systemPrompt: string
  messages: MessageData[]
  planState?: PlanSolveSessionState
  fusionState?: FusionSessionState
  orchestratorState?: OrchestratorSessionState
  createdAt: string
  updatedAt: string
  status: SessionStatus
  metadata?: Record<string, unknown>
}

type AgentType = "react" | "plan-solve" | "fusion" | "orchestrator"
type SessionStatus = "active" | "completed" | "interrupted" | "cancelled"
```

---

## Agent 特定状态

### PlanSolveSessionState

```ts
interface PlanSolveSessionState {
  currentPlan: string[]
  hasPlan: boolean
  completedSteps: number
  consecutiveFailures: number
}
```

### FusionSessionState

```ts
interface FusionSessionState {
  complexity: "simple" | "complex"
  routed: boolean
  currentPlan: string[]
  hasPlan: boolean
  completedSteps: number
  consecutiveFailures: number

}
```

### OrchestratorSessionState

```ts
interface OrchestratorSessionState {
  taskGraph: TaskGraph
  completedRounds: number
  worktreeState?: WorktreeSessionState
}
```

---

## 会话恢复

Agent 的 `resume()` 方法可用于从断点恢复：

```ts
// 网络中断后恢复会话
const answer = await agent.resume('my-task-001', '继续之前的任务')
```

## 下一步

- [API - Context](/api/context) — Context & Compression API
- [API - Agent](/api/agent) — Agent 类 API
- [Session 指南](/advanced/session) — 会话持久化详细指南
