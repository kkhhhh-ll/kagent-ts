# MCP 协议

kagent-ts 支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io)，可以连接到外部 MCP Server，自动发现并使用其提供的工具。

## 什么是 MCP？

MCP 是一种开放协议，允许 AI 应用安全地连接到外部数据源和工具。通过 MCP，Agent 可以访问：
- 文件系统
- 数据库
- API 服务
- 版本控制系统
- ...任何 MCP Server 提供的能力

## 配置 MCP Server

**推荐方式：使用 JSON 配置文件**（便于复用、分享，密钥不入 git）

创建 `mcp.json`：

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
  },
  "weather": {
    "url": "http://localhost:3001/sse"
  }
}
```

在 Agent 中引用：

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  mcpConfigPath: './mcp.json',  // 从文件加载
})
```

也可以内联配置（优先级高于文件中的同名 server）：

```ts
const agent = new ReActAgent({
  mcpConfigPath: './mcp.json',
  mcpServers: {
    filesystem: {                                // 覆盖 mcp.json 中的 filesystem
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "./project"],
    },
  },
})
```

两种传输方式：
- **stdio**：`command` + `args`（可选 `env`），启动本地进程
- **SSE**：`url`，连接远程服务

## 连接配置

```ts
interface McpServerConfig {
  /** stdio 传输：启动命令 */
  command?: string

  /** stdio 传输：命令参数 */
  args?: string[]

  /** stdio 传输：进程环境变量 */
  env?: Record<string, string>

  /** SSE 传输：远程端点 URL */
  url?: string
}
```

- **stdio 模式**：设置 `command`（必填）和 `args`/`env`（选填）
- **SSE 模式**：设置 `url`（选填）
- `command` 和 `url` 互斥，至少提供一个

## 工具发现流程

```
1. Agent 启动 → McpClientManager.connect()
   ├── 启动 MCP Server 进程 / 建立 SSE 连接
   └── 发送 tools/list 请求
   ↓
2. 收到工具列表
   ├── 包装为 Tool 对象
   ├── 添加 {serverName}_ 前缀 (避免名称冲突)
   └── 注册到 ToolRegistry
   ↓
3. Agent 正常执行 → LLM 可以调用 MCP 工具
   ├── 调用 {serverName}_tool
   ├── McpClientManager 转发到 MCP Server
   └── 返回结果
```

## 工具名称前缀

为避免 MCP 工具与内置工具的名称冲突，所有 MCP 工具会自动加上 `{serverName}_` 前缀：

```
MCP Server: "filesystem"
  ├── read_file    → filesystem_read_file
  ├── write_file   → filesystem_write_file
  └── list_dir     → filesystem_list_dir

MCP Server: "database"
  ├── query        → database_query
  └── execute      → database_execute
```

## 连接管理

```ts
import { McpClientManager, ToolRegistry } from 'kagent-ts'

const toolRegistry = new ToolRegistry()
const mcpManager = new McpClientManager(toolRegistry)

// 连接所有 Server
await mcpManager.connectAll({
  filesystem: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  },
})

// 检查连接状态
const status = mcpManager.getStatus()
// [{ serverName: 'filesystem', connected: true, toolCount: 5 }]

// 断开连接
await mcpManager.disconnect('filesystem')
await mcpManager.disconnectAll()
```

## 超时配置

可以通过构造函数配置连接超时和工具调用超时（毫秒）：

```ts
const mcpManager = new McpClientManager(toolRegistry, undefined, {
  connectTimeoutMs: 15_000,  // 连接 + 工具发现超时 (默认: 15000)
  toolTimeoutMs: 30_000,     // 单次工具调用超时 (默认: 30000)
})
```

- `connectTimeoutMs` — 覆盖 `transport.start()` 和 JSON-RPC 初始化握手
- `toolTimeoutMs` — 覆盖单次 `callTool()` 调用，防止工具死循环或等待外部资源导致 agent 循环永久阻塞

超时时底层连接和资源会被自动清理（`client.close()`），不会泄漏子进程或 SSE socket。

## 错误处理

连接失败时会抛出 `McpConnectionError`，可通过 `connectAll()` 的返回值收集各 server 的错误：

```ts
const errors = await mcpManager.connectAll(servers)
// errors: { serverName: string; error: string }[]
```

## 完整示例

`mcp.json`：

```json
{
  "fs": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "./project"]
  },
  "pg": {
    "url": "http://localhost:3001/sse"
  }
}
```

```ts
import { ReActAgent, AnthropicProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个全栈开发者 AI 助手，可以操作文件系统和查询数据库。',
  llm: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  tools: BUILTIN_TOOLS,
  mcpConfigPath: './mcp.json',
})

await agent.run('查询数据库中有多少用户，然后生成一份用户统计报告文件。')
```

## 与 Agent 关闭集成

调用 `agent.shutdown()` 时会自动断开所有 MCP 连接：

```ts
await agent.shutdown()
// 自动调用 mcpManager.disconnectAll()
```

## 与 Sub-Agent 共享工具

MCP 工具通过 `ToolRegistry` 与 [子代理](/advanced/subagents) 共享——子代理**不需要自己连接 MCP Server**。

MCP 工具的 `execute` 函数通过闭包持有主 Agent 的连接引用，子代理拿到的是同一个 tool 对象，调用时直接走主 Agent 的 MCP 连接。

在 `AGENT.md` 中使用通配符即可引入整个 MCP Server 的工具：

```markdown
---
name: file-worker
description: 处理所有文件操作
tools:
  - filesystem_*       # 匹配 filesystem Server 的全部工具
  - pg_query           # 精确匹配 database Server 的特定工具
---
```

这样主 Agent 连接一次 MCP，所有子代理按需共享工具，不会重复启动 MCP 进程。

## 下一步

- [Tool Registry](/tools/tool-registry) — 理解工具注册机制
- [Sub-Agent 子代理](/advanced/subagents) — 子代理配置与 MCP 工具共享
- [RAG 知识库](/advanced/rag) — 语义检索本地文档
- [Session 持久化](/advanced/session) — MCP 状态不持久化，恢复后需重连
