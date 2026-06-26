# API - Session

## SessionManager

```ts
import { SessionManager } from 'kagent-ts'

new SessionManager(config?: SessionManagerConfig)
```

```ts
interface SessionManagerConfig {
  sessionsDir?: string          // 默认: ".kagent-sessions"
  autoSaveIntervalMs?: number   // 默认: 0 (每次迭代后保存)
}
```

### 方法

```ts
class SessionManager {
  saveCheckpoint(state: SessionState): Promise<void>
  loadSession(sessionId: string): Promise<SessionState | null>
  listSessions(): Promise<SessionInfo[]>
  deleteSession(sessionId: string): Promise<void>
  markStatus(sessionId: string, status: SessionStatus): Promise<void>
}
```

---

## SessionState

```ts
interface SessionState {
  sessionId: string
  agentType: AgentType
  status: SessionStatus
  systemPrompt: string
  messages: MessageData[]
  agentState?: PlanSolveSessionState | FusionSessionState | OrchestratorSessionState
  metadata: SessionMetadata
}

type AgentType = "react" | "plan-solve" | "fusion" | "orchestrator"

enum SessionStatus {
  ACTIVE = "active",
  INTERRUPTED = "interrupted",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
}

interface SessionMetadata {
  createdAt: string
  updatedAt: string
  iterations: number
  toolCalls: number
  tokenUsage: number
  input: string
}
```

---

## Agent 特定状态

### PlanSolveSessionState

```ts
interface PlanSolveSessionState {
  currentPlan: string[]
  completedSteps: number[]
  replanCount: number
  currentStep: number
}
```

### FusionSessionState

```ts
interface FusionSessionState {
  routingResult: { complexity: string; reason: string }
  currentPlan: string[]
  completedSteps: number[]
  reflectionHistory: ReflectionResult[]
  phase: "routing" | "planning" | "executing" | "reflecting"
}
```

### OrchestratorSessionState

```ts
interface OrchestratorSessionState {
  taskGraph: TaskGraph
  completedNodes: Record<string, string>
  currentRound: number
  synthesisResult?: string
}
```

## 下一步

- [API - Context](/api/context) — Context & Compression API
- [API - Agent](/api/agent) — Agent 类 API
- [Session 指南](/advanced/session) — 会话持久化详细指南
