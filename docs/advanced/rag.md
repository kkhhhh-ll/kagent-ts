# RAG 知识库

RAG（Retrieval-Augmented Generation）允许 Agent 基于本地文档进行**语义检索**，在回答问题前自动找到最相关的上下文，注入 LLM 对话中。

支持三种检索模式：**纯向量检索**（默认）、**混合检索**（BM25 + 向量 + RRF）、**Re-rank 精排**（可选）。

除了启动时的目录扫描，还支持**运行时动态摄入**——Agent 可以通过 `ingest_knowledge` 工具将 URL 网页、内联文本、本地文件随时加入知识库，立即变为可搜索。

## 工作原理

```
启动时:
  documentsDir/ 目录
    ↓ 加载 .md / .txt / .json
  TextSplitter（递归优先级切分）
    ↓ chunks
  EmbeddingProvider（OpenAI / 自定义）
    ↓ 向量化
  VectorStore（内存 / Chroma / 自定义）← 向量索引
  KeywordIndex（可选）                 ← BM25 倒排索引
    ↓ 索引就绪

运行时 (检索):
  用户提问
    ↓ LLM 调用 search_knowledge({ query: "..." })
  ┌─ 并发 ──┬─ 向量检索（语义相似度）
  │          └─ BM25 检索（关键词匹配）  ← hybridSearch: true
  ├─ RRF 融合（可选）
  ├─ Re-rank 精排（可选）
  └─ 取 top-K chunks → 注入上下文
    ↓
  LLM 基于检索结果生成回答

运行时 (摄入):
  LLM 调用 ingest_knowledge({ source: "url" | "text" | "file", ... })
    ↓
  UrlLoader / TextLoader / FileLoader → 加载内容
    ↓
  TextSplitter → chunks → EmbeddingProvider → 向量化
    ↓
  VectorStore + KeywordIndex（增量追加，不清空已有数据）
    ↓ 立即可搜索
  search_knowledge 可立即命中新文档
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

  /** 自定义向量存储（默认: InMemoryVectorStore） */
  store?: VectorStore

  /** 启用混合检索：BM25 + 向量 + RRF 融合（默认: false） */
  hybridSearch?: boolean

  /** 混合检索时每路取 topK × factor 条候选（默认: 3） */
  hybridRetrievalFactor?: number

  /** Re-rank 精排器（可选） */
  reRanker?: ReRanker
}
```

## 检索模式

### 纯向量检索（默认）

不做任何配置即可使用。查询向量化 → 余弦相似度搜索 → 返回 top-K。适合语义相近的查询，但可能错过精确关键词匹配。

### 混合检索

```ts
rag: {
  // ...基础配置...
  hybridSearch: true,          // 开启 BM25 + 向量双路检索
  hybridRetrievalFactor: 3,   // 每路取 topK×3 再融合
}
```

两路并发，然后用 **RRF (Reciprocal Rank Fusion)** 合并排序：

- **向量检索** — 语义相似度，擅长同义词、改写、跨语言
- **BM25 检索** — 关键词匹配，擅长领域术语、精确词、稀有词
- **RRF 融合** — `RRF_score(d) = Σ 1 / (60 + rank_i(d))`，无需手动调权

混合检索对中文、日文、韩文同样适用——BM25 分词器自动识别 CJK 字符。

### Re-rank 精排

```ts
import { LLMReRanker } from 'kagent-ts'

rag: {
  hybridSearch: true,
  reRanker: new LLMReRanker({
    llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }), // 小模型降成本
    maxCandidates: 20,  // 最多送给 LLM 打分的候选数
  }),
}
```

两阶段架构：

```
Stage 1 — Bi-Encoder（粗筛）        Stage 2 — Cross-Encoder（精排）
store.search(queryEmbedding, N)    reRanker.rerank(query, candidates)
从全部文档筛出 top-N 候选           对这 N 个候选逐条打分重排
（毫秒级）                           （LLM / 专用 Cross-Encoder，秒级）
```

`LLMReRanker` 用现有 LLM 做精排，零额外依赖。用户也可以实现 `ReRanker` 接口接真正的 Cross-Encoder（Cohere Rerank API、Jina、本地 ONNX 等）：

```ts
class CohereReRanker implements ReRanker {
  async rerank(query: string, results: RAGSearchResult[]): Promise<RAGSearchResult[]> {
    // POST https://api.cohere.com/v2/rerank
  }
}
```

## 向量存储

### InMemoryVectorStore（默认）

纯内存，零依赖，进程重启后需重新 indexing。适合文档量 < 10K chunks 的场景。

### ChromaVectorStore（持久化）

```ts
import { ChromaVectorStore } from 'kagent-ts'

rag: {
  store: new ChromaVectorStore({
    url: 'http://localhost:8000',    // Chroma 服务地址
    // path: './.chroma-data',       // 或使用嵌入式模式（无需服务器）
    embeddingDimension: 1536,         // 必须与 EmbeddingProvider 维度一致
  }),
}
```

需要安装可选依赖：`npm install chromadb`。启动 Chroma：`docker run -p 8000:8000 chromadb/chroma`。

### 自定义存储

实现 `VectorStore` 接口即可接入任意向量数据库（Milvus、Pinecone、Qdrant、Weaviate、LanceDB 等）：

```ts
class MyVectorStore implements VectorStore {
  async add(chunks: RAGChunk[]): Promise<void> { ... }
  async search(queryEmbedding: number[], topK: number): Promise<RAGSearchResult[]> { ... }
  get size(): number { ... }
  async clear(): Promise<void> { ... }
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
    const response = await fetch('http://localhost:8080/embed', {
      method: 'POST',
      body: JSON.stringify({ texts }),
    })
    const json = await response.json()
    return json.embeddings
  }
}
```

## Document Loader 接口

除了启动时自动扫描 `documentsDir`，kagent-ts 提供了 `DocumentLoader` 接口，支持从多种来源加载文档：

```ts
interface DocumentLoader {
  load(): Promise<RAGDocument[]>;
}
```

### 内置 Loader

| Loader | 来源 | 用途 |
| ------ | ---- | ---- |
| `DirectoryLoader` | 本地目录 | 递归扫描 .md / .txt / .json（启动时自动使用） |
| `UrlLoader` | URL 网页 | 抓取网页、提取文本、去除 HTML 标签 |
| `TextLoader` | 内联文本 | 将任意文本转为可搜索的文档 |
| `FileLoader` | 单个本地文件 | 运行时加载新文件进知识库 |

### 使用示例

```ts
import { UrlLoader, TextLoader, FileLoader } from 'kagent-ts'

// 从 URL 加载
const urlLoader = new UrlLoader('https://example.com/docs', {
  title: 'External Docs',       // 可选，自动从 <title> 标签检测
  chunkSize: 1000,              // 可选
  chunkOverlap: 200,            // 可选
})
const docs = await urlLoader.load()

// 从内联文本加载
const textLoader = new TextLoader({
  content: '这是一段需要被索引的知识...',
  title: 'my-knowledge',
})
const docs = await textLoader.load()

// 从单个文件加载
const fileLoader = new FileLoader('/path/to/document.md')
const docs = await fileLoader.load()
```

### 自定义 Loader

实现 `DocumentLoader` 接口即可接入任意数据源（数据库、API、云存储等）：

```ts
import type { DocumentLoader, RAGDocument } from 'kagent-ts'

class DatabaseLoader implements DocumentLoader {
  async load(): Promise<RAGDocument[]> {
    const rows = await db.query('SELECT id, content FROM knowledge_base')
    return rows.map(row => ({
      path: `db://${row.id}`,
      content: row.content,
      chunks: [],  // RAGManager 会自动切分和向量化
    }))
  }
}
```

## 运行时文档摄入 API

`RAGManager` 提供了运行时动态管理知识库的 API，支持增量添加和删除文档，无需重建索引：

```ts
// 通过 RAGManager 实例操作（通常由工具层调用）
await manager.addDocument(document)          // 添加单个文档（增量嵌入）
await manager.addDocuments([doc1, doc2])     // 批量添加
await manager.addFromSource({                // 从来源描述符加载并添加
  type: 'url',
  url: 'https://example.com/docs',
  title: 'External Docs',
})
await manager.removeDocument('doc-path.md')  // 按路径删除文档
await manager.clear()                        // 清空全部数据
```

**关键行为：**

- **增量追加**：`addDocument()` 不会清空已有数据，只对新的 chunks 生成嵌入
- **路径去重**：相同 `path` 的文档会自动替换（先删除旧 chunks，再添加新的）
- **立即可搜索**：文档添加后无需任何等待，`search_knowledge` 可立即命中
- **错误恢复**：删除文档时如果向量存储不支持选择性删除，会记录警告并跳过（下次 `index()` 全量重建时彻底清理）

## LLM 可用工具

配置 RAG 后，Agent 自动注册三个工具：

| 工具名 | 描述 |
| ------ | ---- |
| `search_knowledge` | 语义搜索知识库。参数：`query`（自然语言查询）。返回 top-K 个最相关的 chunk，含源文件路径和相似度分数。 |
| `list_knowledge_documents` | 列出知识库中所有已索引的文档路径。无参数。 |
| `ingest_knowledge` | 运行时向知识库添加文档。支持三种来源：`url`（抓取网页）、`text`（内联文本）、`file`（本地文件）。文档添加后立即可搜索。 |

### `ingest_knowledge` 使用示例

**从 URL 摄入：**

```json
{ "source": "url", "url": "https://react.dev/blog/2024/12/05/react-19", "title": "React 19 Release" }
```

Agent 抓取网页 → 提取文本 → 切分 → 向量化 → 存入知识库。此后 `search_knowledge` 可命中该内容。

**从内联文本摄入：**

```json
{ "source": "text", "content": "Kubernetes Pod 是 K8s 中最小的部署单元...", "title": "K8s Pod 概念" }
```

**从本地文件摄入：**

```json
{ "source": "file", "filePath": "/home/user/docs/api-reference.md" }
```

## 与子代理共享

RAG 工具与 MCP 工具共享机制一致——子代理在 `AGENT.md` 中声明工具名即可使用，不需要自己配置 RAG：

```markdown
---
name: knowledge-worker
description: 基于知识库搜索并回答问题
tools:
  - search_knowledge
  - list_knowledge_documents
  - ingest_knowledge
---
```

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
  OpenAIEmbeddingProvider,
  ChromaVectorStore,
  LLMReRanker,
} from 'kagent-ts'

// 生产级配置：Chroma 持久化 + 混合检索 + LLM 精排
const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  systemPrompt: '你是技术文档助手，基于知识库回答用户问题。',

  rag: {
    documentsDir: './project-docs',
    embeddingProvider: new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'text-embedding-3-small',
    }),
    topK: 5,
    chunkSize: 1000,
    chunkOverlap: 200,

    // Chroma 持久化向量存储
    store: new ChromaVectorStore({
      url: 'http://localhost:8000',
      embeddingDimension: 1536,
    }),

    // 混合检索：BM25 + 向量
    hybridSearch: true,
    hybridRetrievalFactor: 4,

    // LLM 精排
    reRanker: new LLMReRanker({
      llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
      maxCandidates: 20,
    }),
  },
})

await agent.run('介绍一下 MCP 协议的使用方法？')
```

## 下一步

- [Sub-Agent 子代理](/advanced/subagents) — 子代理如何共享 RAG 工具
- [MCP 协议](/advanced/mcp) — 连接外部工具服务
- [Memory 记忆](/advanced/memory) — 长期事实和规则存储
- [安全防护](/advanced/security) — Prompt Injection 防御
