# API - Messages

## Message 类

```ts
import { Message } from 'kagent-ts'

// 工厂方法
Message.user(content: string): Message
Message.system(content: string): Message
Message.assistant(content: string, tool_calls?: ToolCall[]): Message
Message.tool(content: string, tool_call_id: string, name?: string): Message

// 转换
message.toDict(): MessageData
Message.fromData(data: MessageData): Message
```

---

## Role 枚举

```ts
import { Role } from 'kagent-ts'

enum Role {
  System = "system",
  User = "user",
  Assistant = "assistant",
  Tool = "tool",
}
```

---

## MessageData

```ts
interface MessageData {
  role: Role
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  name?: string
}
```

---

## ToolCall

```ts
interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string  // JSON string
  }
}
```

---

## 使用示例

```ts
import { Message, Role } from 'kagent-ts'

// 创建消息
const systemMsg = Message.system('你是一个有用的 AI 助手。')
const userMsg = Message.user('请帮我分析代码。')
const assistantMsg = Message.assistant('我来帮你分析代码。', [
  { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } },
])
const toolMsg = Message.tool('文件内容...', 'call_1', 'read_file')

// 转换为 API 格式
const messages = [systemMsg, userMsg, assistantMsg, toolMsg]
const apiMessages = messages.map(m => m.toDict())
```

## 下一步

- [API - Session](/api/session) — Session API
- [API - Context](/api/context) — Context & Compression API
- [API - Agent](/api/agent) — Agent 类 API
