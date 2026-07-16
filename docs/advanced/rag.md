# RAG 知识库

RAG（Retrieval-Augmented Generation）允许 Agent 基于本地文档进行**语义检索**，在回答问题前自动找到最相关的上下文，注入 LLM 对话中。

支持三种检索模式：**纯向量检索**（默认）、**混合检索**（BM25 + 向量 + RRF）、**Re-rank 精排**（可选）。

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
  ├─ Re-rank 精排（可选）
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
| `.md` | Markdown 文件 |
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
| 1 | 段落边界 | `\n\n`（空行） |
| 2 | 句子结束 | `。！？. ! ?` |
| 3 | 子句停顿 | `，；、, ; :` |
| 4 | 兜底硬切 | 按 chunkSize 截断 |

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

## 检索质量评估

`RAGEvaluator` 提供两种互补的评估模式，帮你衡量"检索出来的 chunk 对不对"：

| 模式 | 需要标注？ | API 成本 | 适用场景 |
|------|-----------|---------|---------|
| Ground-Truth 指标 | 是 | 零 | CI 回归、精确对比 |
| LLM-as-Judge | 否 | 每条若干 token | 快速探索、无标注数据 |

### 评估维度

```
Layer 1: 检索质量        Layer 2: 上下文利用       Layer 3: 最终答案
"找对了吗？"            "用对了吗？"             "答对了吗？"

Precision@K / MRR       Faithfulness            EvalRunner (已有的)
NDCG@K / Recall@K       (RAGAS 风格，待建)       正确性/完整性/清晰度
```

`RAGEvaluator` 覆盖 Layer 1——直接衡量检索系统的输出质量，在答案被 LLM 消费之前发现问题。

### 基本用法

```ts
import { RAGEvaluator } from 'kagent-ts'

// ragManager 可从 Agent 获取（Agent 初始化后通过 (agent as any).ragManager），
// 或单独创建 RAGManager 实例
const evaluator = new RAGEvaluator({ ragManager, defaultTopK: 5 })

const result = await evaluator.evaluate([
  {
    name: "MCP 配置",
    query: "怎么配置 MCP？",
    // 标注的 relevant chunk ID（格式: "sourcePath#chunkIndex"）
    relevantChunks: ["docs/advanced/mcp.md#3", "docs/advanced/mcp.md#5"],
    topK: 5,
  },
  {
    name: "Embedding 设置",
    query: "How to set up embeddings?",
    topK: 5, // 没有 relevantChunks → 仅靠 LLM judge（如已配置）
  },
])

// 打印摘要
const s = result.summary
console.log(`Precision@K : ${s.avgPrecisionAtK.toFixed(3)}`)
console.log(`MRR         : ${s.avgMRR.toFixed(3)}`)

// 输出完整 Markdown 报告
console.log(evaluator.generateReport(result))
```

### 模式 1: Ground-Truth 指标（零成本）

需要标注数据。复用 `chunkKey()` 生成 chunk ID：

```ts
import { chunkKey } from 'kagent-ts'

// 构建标注数据集
const cases = [
  {
    name: "MCP 配置",
    query: "怎么配置 MCP？",
    relevantChunks: [
      "docs/advanced/mcp.md#3",   // chunkKey 格式: sourcePath#chunkIndex
      "docs/advanced/mcp.md#5",
    ],
    topK: 5,
  },
]

const evaluator = new RAGEvaluator({ ragManager })
const result = await evaluator.evaluate(cases)
```

**计算指标：**

| 指标 | 公式 | 含义 |
|------|------|------|
| **Precision@K** | `|检索 ∩ 相关| / K` | 返回的 K 个里有多少真正相关 |
| **Recall@K** | `|检索 ∩ 相关| / |全部相关|` | 所有相关文档被找回的比例 |
| **MRR** | `1 / 第一个相关结果的排名` | 第一个相关结果排第几位（0 表示没找到） |
| **NDCG@K** | `DCG / IDCG`（二值相关度） | 考虑排序位置的折损累积增益，1.0 = 完美排序 |

### 模式 2: LLM-as-Judge（无标注也能评）

不需要标注数据——LLM 自动判断每个 chunk 是否与 query 相关：

```ts
const evaluator = new RAGEvaluator({
  ragManager,
  judgeLLM: new OpenAIProvider({        // 用小模型控制成本
    apiKey: '...',
    model: 'gpt-4o-mini',
  }),
  defaultTopK: 5,
})

const result = await evaluator.evaluate([
  { name: "MCP", query: "怎么配置 MCP？", topK: 5 },
  { name: "团队", query: "团队介绍", topK: 5 },
])

// 每个 chunk 都有 LLM 的 relevance 判断
for (const c of result.cases) {
  for (const j of c.judgments) {
    console.log(`${j.relevant ? '✅' : '❌'} [${j.score}/10] ${j.chunkId}`)
    console.log(`  ${j.reasoning}`)
  }
}
```

**LLM Judge 输出：**

```ts
interface ChunkJudgment {
  chunkId: string      // "sourcePath#chunkIndex"
  relevant: boolean    // 是否相关（部分相关也算 true）
  score: number        // 0–10 相关性分数
  reasoning: string    // 一句话判断理由
}
```

**LLM-judge 指标：**

| 指标 | 含义 |
|------|------|
| **LLM Precision@K** | LLM 判断为相关的 chunk 占比 |
| **LLM NDCG@K** | 用 LLM 分数（0-10）算的分级 NDCG |
| **Avg Relevance Score** | K 个 chunk 的 LLM 平均分（0-10） |

### 同时使用两种模式

同时提供 `relevantChunks` 和 `judgeLLM` 时，还会计算 **Judge-Label Agreement（Cohen's κ）**——衡量 LLM judge 和人工标注的一致性：

```ts
const evaluator = new RAGEvaluator({
  ragManager,
  judgeLLM: smallLLM,
})

const result = await evaluator.evaluate([
  {
    name: "MCP",
    query: "怎么配置 MCP？",
    relevantChunks: ["docs/advanced/mcp.md#3"],  // 人工标注
    topK: 5,
  },
])

// κ = 1.0 → LLM judge 和人工标注完全一致
// κ ≈ 0.0 → LLM judge 和随机差不多
console.log('Judge-Label Agreement:', result.cases[0].metrics.judgeLabelAgreement)
```

### 评估时机

| 阶段 | 工具 | 数据 | 频率 | 目的 |
|------|------|------|------|------|
| **开发迭代** | `RAGEvaluator` | 伪标注 or 手写几条 | 每次改配置 | 快速验证 chunkSize / topK / embedding |
| **CI / 合码** | `RAGEvaluator` + 固定数据集 | 20-50 条标注 query | 每次 PR | 防退化 |
| **线上监控** | `RAGEvaluator` + `judgeLLM` | 真实用户 query | 持续/每日 | 发现检索 drift |

### 解读评估结果

```
✅ 完美 → Precision@K = 1.0, NDCG@K = 1.0
   可能是文档太少（只有 1 个 chunk），样本量不够时指标无意义

✅ 正常 → Precision@K ≈ 0.4-0.8
   检索能命中大部分相关文档，有少量噪声

⚠️ 需改进 → Precision@K < 0.3, MRR < 0.3
   检索结果噪声大，建议调整 chunk 策略或开 hybridSearch

⚠️ 排序差 → NDCG@K << 1.0 但 Precision@K 不低
   相关文档被找到了但排在了后面，建议加 reRanker

⚠️ Judge 不可靠 → κ < 0.4
   LLM judge 和人工标注不一致，可能需要换 judge 模型或调整 prompt
```

### 完整示例

```ts
import { RAGEvaluator, OpenAIProvider, chunkKey } from 'kagent-ts'

// 假设已经初始化了 agent，从中获取 ragManager
const ragManager = (agent as any).ragManager

// ── 模式 1: Ground-Truth（零成本） ──
const evaluator = new RAGEvaluator({ ragManager, defaultTopK: 5 })
const gtResult = await evaluator.evaluate([
  {
    name: "MCP 配置",
    query: "怎么配置 MCP？",
    relevantChunks: ["docs/advanced/mcp.md#3", "docs/advanced/mcp.md#5"],
    topK: 5,
  },
])
console.log(`Precision@5: ${gtResult.summary.avgPrecisionAtK.toFixed(3)}`)
console.log(`MRR: ${gtResult.summary.avgMRR.toFixed(3)}`)

// ── 模式 2: LLM-as-Judge ──
const judgeEval = new RAGEvaluator({
  ragManager,
  judgeLLM: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
  defaultTopK: 5,
})
const llmResult = await judgeEval.evaluate([
  { name: "MCP", query: "怎么配置 MCP？", topK: 5 },
  { name: "团队", query: "团队介绍", topK: 5 },
])

// 逐条看 LLM 判断
for (const c of llmResult.cases) {
  console.log(`\n── ${c.caseName} ──`)
  for (const j of c.judgments ?? []) {
    console.log(`  ${j.relevant ? '✅' : '❌'} [${j.score}/10] ${j.reasoning}`)
  }
}

// 输出完整 Markdown 报告
console.log(judgeEval.generateReport(llmResult))
```

## 下一步

- [Eval 评估](/advanced/eval) — 完整的评估框架（工具调用 / 端到端 / 回归测试）
- [Sub-Agent 子代理](/advanced/subagents) — 子代理如何共享 RAG 工具
- [MCP 协议](/advanced/mcp) — 连接外部工具服务
- [Memory 记忆](/advanced/memory) — 长期事实和规则存储
- [安全防护](/advanced/security) — Prompt Injection 防御
