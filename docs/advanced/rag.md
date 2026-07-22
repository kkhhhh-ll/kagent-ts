# RAG 知识库

RAG（Retrieval-Augmented Generation）允许 Agent 基于本地文档进行**语义检索**，在回答问题前自动找到最相关的上下文，注入 LLM 对话中。

检索管线采用两阶段架构：**粗筛**（向量 / BM25 + RRF）→ **精排**（Cross-Encoder，默认启用）。

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

运行时:
  用户提问
    ↓ LLM 调用 search_knowledge({ query: "..." })
  ┌─ 并发 ──┬─ 向量检索（语义相似度）
  │          └─ BM25 检索（关键词匹配）  ← hybridSearch: true
  ├─ RRF 融合（可选）
  ├─ Cross-Encoder 精排（默认，本地 ONNX）
  └─ 取 top-K chunks → 注入上下文
    ↓
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

  /** Re-rank 精排器（默认: CrossEncoderReRanker，本地 BGE-Reranker ONNX 模型）。
   *  传 null 显式禁用精排；也可传 LLMReRanker 使用 LLM 打分。 */
  reRanker?: ReRanker }
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

### Re-rank 精排（默认启用）

框架默认使用 **Cross-Encoder**（BGE-Reranker）做精排。每次检索后，Cross-Encoder 对候选 chunk 逐条做 `(query, doc)` 联合编码打分，重排序后返回最相关的结果。

```
Stage 1 — Bi-Encoder（粗筛）              Stage 2 — Cross-Encoder（精排，默认）
EmbeddingProvider + VectorStore           CrossEncoderReRanker
query / doc 独立编码 → 余弦相似度           (query, doc) 拼接送入 Transformer → 标量分数
从全部文档筛出 top-N 候选                  对 N 个候选逐条打分重排
（毫秒级）                                  （本地 ONNX，< 100ms / 条）
```

Cross-Encoder 不依赖外部 API，首次运行自动从 HuggingFace Hub 下载量化 ONNX 模型（~100 MB），后续缓存复用。

**默认配置（无需额外设置）：**

```ts
rag: {
  // ...基础配置...
  // CrossEncoderReRanker 自动生效，无需显式指定
}
```

**自定义模型：**

```ts
import { CrossEncoderReRanker } from 'kagent-ts'

rag: {
  reRanker: new CrossEncoderReRanker({
    model: 'Xenova/bge-reranker-v2-m3',  // 多语言（中英），默认 bge-reranker-base
    maxCandidates: 20,                    // 默认 20
  }),
}
```

**禁用精排：**

```ts
rag: {
  reRanker: null,  // 显式禁用，检索结果不做重排
}
```

**备选方案 — LLM 打分：**

如果不想依赖本地 ONNX 模型，可以用 `LLMReRanker` 让 LLM 打分（复用已有 LLM，零额外模型下载）：

```ts
import { LLMReRanker } from 'kagent-ts'

rag: {
  reRanker: new LLMReRanker({
    llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
    maxCandidates: 20,
  }),
}
```

LLMReRanker 把候选 chunk 和 query 拼成 prompt，让 LLM 逐一打 0-10 分。比 Cross-Encoder 慢（网络往返）且贵（token 计费），但优点是不需要本地模型文件。

**备选方案 — 外部 API：**

也可以实现 `ReRanker` 接口，接入 Cohere、Jina、Voyage AI 等专用 Re-rank API：

```ts
class CohereReRanker implements ReRanker {
  async rerank(query: string, results: RAGSearchResult[]): Promise<RAGSearchResult[]> {
    // POST https://api.cohere.com/v2/rerank
  }
}
```

### 精排方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| Cross-Encoder（默认） | 精度高，本地运行 | 需下载 ~100MB 模型 |
| LLMReRanker | 零本地模型，复用已有 LLM | 较慢（网络往返），计 token 费 |
| 外部 API（Cohere 等） | 专业服务，效果好 | 需额外 API 费用 |

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

- 扫描 `documentsDir` **递归遍历子目录**
- 跳过以 `.` 开头的文件和目录
- 跳过超过 5 MiB 的文件
- 跳过空文件和纯空白文件

## 文本切分策略

切分器按**优先级从高到低**查找切分边界，确保不会在句子中间截断：

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

## LLM 可用工具

配置 RAG 后，Agent 自动注册两个工具：

- **`search_knowledge`** — 语义搜索知识库，返回最相关的文档片段和分数
- **`list_knowledge_documents`** — 列出知识库中已索引的所有文档

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
  OpenAIProvider,
  OpenAIEmbeddingProvider,
  ChromaVectorStore,
} from 'kagent-ts'

// 生产级配置：Chroma 持久化 + 混合检索 + Cross-Encoder 精排（默认）
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

    // CrossEncoderReRanker 默认自动启用 —— 无需显式配置
    // 如需切换为 LLM 精排：
    // reRanker: new LLMReRanker({ llm: ..., maxCandidates: 20 }),
    // 如需禁用精排：
    // reRanker: null,
  },
})

await agent.run('介绍一下 MCP 协议的使用方法？')
```

> **检索质量评估**：推荐使用 [RAGAS](https://docs.ragas.io/) 等成熟工具，在 Python 生态中离线评估 RAG 检索和生成质量。框架不再内置 RAG 评估模块。

## 下一步

- [Eval 评估](/advanced/eval) — 完整的评估框架（工具调用 / 端到端 / 回归测试）
- [Sub-Agent 子代理](/advanced/subagents) — 子代理如何共享 RAG 工具
- [MCP 协议](/advanced/mcp) — 连接外部工具服务
- [Memory 记忆](/advanced/memory) — 长期事实和规则存储
- [安全防护](/advanced/security) — Prompt Injection 防御
