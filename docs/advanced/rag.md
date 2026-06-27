# RAG 知识库

RAG（Retrieval-Augmented Generation）允许 Agent 基于本地文档进行**语义检索**，在回答问题前自动找到最相关的上下文。零外部依赖，开箱即用。

## 工作原理

```
启动时:
  documentsDir/ 目录
    ↓ 加载 .md / .txt / .json
  TextSplitter（递归优先级切分）
    ↓ chunks
  EmbeddingProvider（OpenAI / 自定义）
    ↓ 向量化
  VectorStore（内存余弦相似度）
    ↓ 索引就绪

运行时:
  用户提问
    ↓ LLM 调用 search_knowledge({ query: "..." })
  查询向量化 → 相似度搜索 → top-K chunks
    ↓ 注入上下文
  LLM 基于检索结果生成回答
```

## 基本用法

```ts
import { ReActAgent, OpenAIProvider, OpenAIEmbeddingProvider } from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  systemPrompt: '你是一个技术支持助手，请基于知识库回答用户问题。',

  rag: {
    documentsDir: './docs',
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    }),
    topK: 5,
  },
})

// LLM 看到用户问"怎么配置 MCP？"
// → 调用 search_knowledge({ query: "MCP 配置方法" })
// → 返回 docs/advanced/mcp.md 中最相关的 5 个 chunks
// → LLM 基于检索结果生成回答
await agent.run('怎么配置 MCP？')
```

## 配置参数

```ts
interface RAGConfig {
  /** 文档目录路径（必填） */
  documentsDir: string

  /** 向量化 Provider（必填） */
  embeddingProvider: EmbeddingProvider

  /** 检索时返回的 top-K 数量（默认: 5） */
  topK?: number

  /** chunk 最大字符数（默认: 1000） */
  chunkSize?: number

  /** 相邻 chunk 之间的重叠字符数（默认: 200） */
  chunkOverlap?: number
}
```

## 支持的文档格式

| 格式 | 说明 |
| ---- | ---- |
| `.md` | Markdown 文件，优先按标题结构切分 |
| `.txt` | 纯文本文件 |
| `.json` | JSON 文件（按纯文本处理） |

- 扫描 `documentsDir` **递归遍历子目录**
- 跳过以 `.` 开头的文件和目录
- 跳过超过 5 MiB 的文件
- 跳过空文件和纯空白文件

## 文本切分策略

切分器按**优先级从高到低**查找切分边界，确保不会在句子中间截断：

| 优先级 | 分隔符 | 示例 |
| ------ | ------ | ---- |
| 1 | Markdown 标题 | `## `, `### ` |
| 2 | 段落边界 | `\n\n`（空行） |
| 3 | 句子结束 | `。！？. ! ?` |
| 4 | 子句停顿 | `，；、, ; :` |
| 5 | 兜底硬切 | 按 chunkSize 截断 |

### Chunk 重叠

相邻 chunk 之间有 `chunkOverlap` 个字符的上下文重叠，防止关键信息恰好落在边界上。重叠边界同样遵循分隔符优先级，确保重叠区域从自然的句子/段落边界开始。

```
Chunk 1: "...MCP Server 的配置方法如下：首先你需要安装 SDK。"
                          └── overlap ──┐
Chunk 2: "首先你需要安装 SDK。然后配置 mcpServers 参数。"
```

## Embedding Provider

### OpenAI（内置）

```ts
import { OpenAIEmbeddingProvider } from 'kagent-ts'

const provider = new OpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'text-embedding-3-small', // 默认
  // model: 'text-embedding-3-large', // 3072 维，更高精度
  timeoutMs: 30_000,
})
```

| 模型 | 维度 |
| ---- | ---- |
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 |

### 自定义 Provider

实现 `EmbeddingProvider` 接口即可接入本地模型或其他服务：

```ts
import type { EmbeddingProvider } from 'kagent-ts'

class MyEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'my-local-model'
  readonly dimensions = 768

  async embed(texts: string[]): Promise<number[][]> {
    // 调用本地 embedding 服务
    const response = await fetch('http://localhost:8080/embed', {
      method: 'POST',
      body: JSON.stringify({ texts }),
    })
    const json = await response.json()
    return json.embeddings
  }
}
```

## LLM 可用工具

配置 RAG 后，Agent 自动注册两个工具：

| 工具名 | 描述 |
| ------ | ---- |
| `search_knowledge` | 语义搜索知识库。参数：`query`（自然语言查询）。返回 top-K 个最相关的 chunk，含源文件路径和相似度分数。 |
| `list_knowledge_documents` | 列出知识库中所有已索引的文档路径。无参数。 |

## 与子代理共享

RAG 工具与 MCP 工具共享机制一致——子代理在 `AGENT.md` 中声明工具名即可使用，不需要自己配置 RAG：

```markdown
---
name: knowledge-worker
description: 基于知识库搜索并回答问题
tools:
  - search_knowledge
  - list_knowledge_documents
---
```

## 完整示例

```ts
import {
  ReActAgent,
  OrchestratorAgent,
  AnthropicProvider,
  OpenAIEmbeddingProvider,
  BUILTIN_TOOLS,
} from 'kagent-ts'

// 简单场景：单个 Agent + RAG
const agent = new ReActAgent({
  llm: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  systemPrompt: '你是一个技术文档助手，基于知识库回答用户的问题。',

  rag: {
    documentsDir: './project-docs',
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    }),
    chunkSize: 1000,
    chunkOverlap: 200,
    topK: 5,
  },
})

await agent.run('介绍一下 MCP 协议的使用方法？')
```

```ts
// 复杂场景：Orchestrator + RAG + Sub-Agents
const orchestrator = new OrchestratorAgent({
  llm: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-sonnet-4-6',
  }),
  systemPrompt: '你是项目架构师，负责分解任务并委派给子代理。',
  tools: BUILTIN_TOOLS,

  rag: {
    documentsDir: './docs',
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    }),
    topK: 5,
  },

  subAgentsDir: './subagents',
  subAgentLLM: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: 'claude-haiku-4-5',
  }),
})
```

## 下一步

- [Sub-Agent 子代理](/advanced/subagents) — 子代理如何共享 RAG 工具
- [MCP 协议](/advanced/mcp) — 连接外部工具服务
- [Memory 记忆](/advanced/memory) — 长期事实和规则存储
