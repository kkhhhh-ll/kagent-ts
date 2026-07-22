# API - Context & Compression

## ContextManager

```ts
import { ContextManager } from 'kagent-ts'

new ContextManager(config: ContextConfig)
```

```ts
interface ContextConfig {
  maxTokens: number               // 上下文窗口最大 Token 数
  compressionThreshold?: number   // 压缩触发阈值 (0-1, 默认: 0.8)
  keepTurns?: number              // 保留最近 N 轮 (默认: 20)
  toolResultMaxAgeMs?: number     // 工具结果最大保留时间 (默认: 300000)
}
```

### 方法

```ts
class ContextManager {
  addMessage(message: MessageData): void
  getMessages(): MessageData[]
  getTokenCount(): number
  needsCompression(): boolean
  compress(): CompressionResult
  clear(): void
}
```

---

## ContextState

```ts
interface ContextState {
  messages: MessageData[]
  tokenCount: number
  compressedRounds: number
  truncatedOutputs: number
  lastCompressionAt: number
}
```

---

## ProgressiveCompressor

```ts
import { ProgressiveCompressor } from 'kagent-ts'

new ProgressiveCompressor(config?: CompressionConfig)
```

```ts
interface CompressionConfig {
  maxOutputSize?: number           // 默认: 200KB
  truncatedOutputDir?: string      // 默认: ".kagent-context"
}
```

### 策略

```ts
type CompressionStrategy =

interface CompressionResult {
  appliedStrategies: CompressionStrategy[]
  tokensSaved: number
  messagesRemoved: number
  truncatedOutputs: number
}
```

---

## 使用示例

```ts
import { ContextManager, ProgressiveCompressor } from 'kagent-ts'

// ContextManager 自动管理上下文窗口
const ctxManager = new ContextManager({
  maxTokens: 128000,
  compressionThreshold: 0.8,
  keepTurns: 20,
  toolResultMaxAgeMs: 300000,
})

// 添加消息
ctxManager.addMessage({ role: 'user', content: '你好' })

// 检查是否需要压缩
if (ctxManager.needsCompression()) {
  const result = ctxManager.compress()
  console.log(`已压缩: 节省 ${result.tokensSaved} tokens`)
}

// ProgressiveCompressor 提供更细粒度的控制
const compressor = new ProgressiveCompressor({
  maxOutputSize: 100 * 1024,     // 100KB
  truncatedOutputDir: './.context-cache',
})
```

## 下一步

- [API - Session](/api/session) — Session API
- [上下文管理指南](/advanced/context-compression) — 4 步渐进式压缩详解
- [API - Agent](/api/agent) — Agent 类 API
