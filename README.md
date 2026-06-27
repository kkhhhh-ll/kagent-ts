# kagent-ts

一个 TypeScript AI Agent 框架，提供 ReAct / Plan-Solve / Fusion / Orchestrator 多种 Agent 循环范式，内置工具管理（Circuit Breaker）、会话持久化、渐进式 Skill 系统、MCP 协议支持、RAG 知识检索（混合检索 + Re-rank）、Reflection 反思与 Eval 评估。

## 安装

```bash
npm install kagent-ts
```

## 快速开始

```ts
import { ReActAgent, createLLMProvider } from "kagent-ts"

const llm = createLLMProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
})

const agent = new ReActAgent({
  llm,
  tools: [],
  maxIterations: 10,
})

const answer = await agent.run("请介绍一下 TypeScript 的特点。")
console.log(answer)
```

## 核心特性

- 🧠 **4 种 Agent 范式** — ReAct → Plan-Solve → Fusion → Orchestrator，从简单问答到大规模多代理编排
- 🔧 **工具系统** — Circuit Breaker 熔断、JSON Schema 参数校验、HITL 审批、错误追踪链
- 🔌 **多 LLM 后端** — OpenAI / Anthropic，Fallback 降级、Rate Limiter 限流、Model Router 路由
- 💾 **会话持久化** — 自动 Checkpoint，支持网络中断恢复和取消续跑
- 📦 **渐进式 Skill** — 基于 SKILL.md 文件，按需激活，Token 友好
- 🌐 **MCP 协议** — 动态发现外部工具，支持 stdio / SSE 传输
- 📚 **RAG 知识库** — 混合检索（BM25 + 向量 + RRF 融合）、Chroma/Milvus 等向量数据库、Re-rank 精排
- 🔍 **反思与评估** — Reflection + ErrorNotebook + EvalRunner + Benchmark
- 🛡️ **安全防护** — 多层 Prompt Injection 防御

## 文档

完整文档请访问：**[https://kkhhhh-ll.github.io/kagent-ts](https://kkhhhh-ll.github.io/kagent-ts)**

本地运行文档：

```bash
npm run docs:dev
```
