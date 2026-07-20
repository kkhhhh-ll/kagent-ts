# 上下文管理

kagent-ts 提供自动化的上下文窗口管理和 **4 步渐进式压缩**策略，确保长对话不会超出 LLM 的 Token 限制。

## 为什么需要上下文压缩？

LLM 的上下文窗口有限（如 128K tokens）。当 Agent 执行多轮工具调用时，消息历史会快速增长：

```
系统提示词:      ~2,000 tokens
用户输入:        ~500 tokens
迭代 1 (LLM + Tool):  ~3,000 tokens
迭代 2 (LLM + Tool):  ~4,000 tokens
...
迭代 20:         ~50,000+ tokens  ← 可能超出窗口
```

## ContextManager 配置

```ts
import { ContextManager } from 'kagent-ts'

const contextManager = new ContextManager({
  maxTokens: 128000,              // 上下文窗口最大 Token 数
  compressionThreshold: 0.8,      // 80% 阈值触发压缩
  keepTurns: 20,                  // Step 2: 保留最近 N 轮对话
  summaryKeepTurns: 10,           // Step 4: 保留最近 N 轮原文（其他压缩为摘要）
  toolResultMaxAgeMs: 300000,    // 工具结果最大保留时间 (5 分钟)
})
```

## 4 步渐进式压缩

当 Token 用量达到 `compressionThreshold` 阈值时，按以下优先级执行压缩：

### 第 1 步: 截断大型工具输出

> 200KB 的输出 → 截断到 2KB 摘要，原始内容保存到 `.kagent-context/`

```
[原始输出 500KB]
  ↓
[摘要 "文件内容共 2000 行，前 50 行为: ..." (2KB)]
  ↓
完整内容保存在: .kagent-context/tool-output-1719000000.txt
```

### 第 2 步: 压缩旧轮次（保留用户提问）

超过 `keepTurns` 的消息轮次中，**保留所有用户消息**，删除对应的 assistant 和 tool 消息：

```
轮次 1-50 (旧):
  User: "帮我分析项目结构"        → 保留
  Assistant: "好的，我读取了..."    → 删除
  Tool (read_file): "文件内容..."   → 删除
  User: "重构这个模块"             → 保留
  Assistant: "我来重构..."          → 删除
  ...

轮次 51-70 (最近 20 轮) → 完全保留
```

同时注入提醒标记，告知 LLM：如果当前任务与这些历史请求相关，**必须重新执行**，不可依赖已删除的结果。

### 第 3 步: 清除过期的读取型工具结果

读文件、搜索等工具的结果可以被重新获取，过期的优先清除：

```
ReadFileTool 结果   → 优先清除 (可以重新读取)
GrepTool 结果       → 优先清除 (可以重新搜索)
WriteFileTool 结果  → 保留 (副作用不可逆)
```

### 第 4 步: LLM 摘要（保留最近 10 轮原文）

当有 LLM Provider 可用时，将**旧轮次**（最近 N 轮之前的部分）压缩为摘要，
**最近 N 轮**（默认 10 轮）则完整保留原文：

```
[旧对话 30 轮]
  ↓ LLM 摘要
"之前的对话摘要: 用户要求分析项目结构，Agent 读取了 15 个文件，
发现了 3 个关键模块，讨论了架构问题..."
  ↓
[最近 10 轮对话原文] → 完整保留
```

摘要聚焦于：

1. 用户的主要请求和意图

2. 关键技术概念和决策

3. 涉及的文件和代码

4. 错误和修复记录

5. 问题解决过程

6. 待完成任务

7. 当前工作状态（中断时的上下文）

## 在 Agent 中使用

```ts
const contextManager = new ContextManager({
  maxTokens: 100000,
  compressionThreshold: 0.75,
  keepTurns: 15,
  summaryKeepTurns: 10,           // Step 4 保留最近 N 轮原文
  toolResultMaxAgeMs: 180000,     // 3 分钟
})

const agent = new ReActAgent({
  systemPrompt: '...',
  llm: provider,
  tools: BUILTIN_TOOLS,
  contextManager,
})
```

## 上下文状态

```ts
interface ContextState {
  messages: MessageData[]      // 当前上下文中的消息
  tokenCount: number            // 当前 Token 估算
  compressedRounds: number      // 已压缩的轮次数
  truncatedOutputs: number      // 已截断的输出数
  lastCompressionAt: number     // 上次压缩时间戳
}
```

## 最佳实践

1. **合理设置 `keepTurns`**: 大多数任务 10-20 轮足够
2. **降低 `toolResultMaxAgeMs`**: 对于快速迭代型 Agent，缩短工具结果保留时间
3. **监控 Token 使用**: 通过 `AgentHooks` 记录每次 LLM 调用的 Token 消耗
4. **选择性压缩**: 对写操作类工具的结果设置更长的保留时间

## 下一步

- [Session 持久化](/advanced/session) — 会话的保存与恢复
- [Trace 追踪](/advanced/trace) — 记录执行的完整追踪
- [Token Budget](/llm/token-budget) — 会话级 Token 消耗控制
