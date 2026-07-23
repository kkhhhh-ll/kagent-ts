---
layout: home

hero:
  name: "kagent-ts"
  text: "TypeScript AI Agent 框架"
  tagline: ReAct / Plan-Solve / Fusion / Orchestrator — 多模式 LLM Agent 框架，内置完善的工具管理、会话持久化、RAG 知识检索、反思与安全机制
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/kkhhhh-ll/kagent-ts

features:
  - icon: 🧠
    title: 多种 Agent 范式
    details: 支持 ReAct、Plan-Solve、Fusion（混合）和 Orchestrator（多agent编排）四种 Agent 循环范式，灵活应对不同复杂度的任务。
  - icon: 🔧
    title: 完善的工具系统
    details: 内置 15 种工具（文件读写、搜索、Shell 执行、网络抓取、知识检索等），支持 Circuit Breaker 熔断、JSON Schema 参数验证、工具输出截断和 HITL 审批。
  - icon: 🔌
    title: 多 LLM 后端
    details: 同时支持 OpenAI 和 Anthropic，内置 Fallback 降级、Rate Limiter 限流、Model Router 路由和 Token Budget 预算控制。
  - icon: 💾
    title: 会话持久化
    details: 自动 Checkpoint 持久化，支持会话恢复、取消和优雅关闭。网络中断时自动保存现场。
  - icon: 🔍
    title: 反思与评估
    details: 内置 Reflection 反思代理和 Error Notebook 错误笔记本，支持 Eval 评估框架、Benchmark 回归测试和 Trace 执行追踪。
  - icon: 🛡️
    title: 安全防护
    details: 多层 Prompt Injection 防御体系：系统提示引导 + 边界标记包裹 + 签名模式扫描 + 名称字段检测。
  - icon: 📦
    title: 渐进式 Skill 系统
    details: 基于 SKILL.md 文件的渐进式技能加载，Lazy-loading 按需激活。技能由用户手动创建为 SKILL.md 文件。
  - icon: 🌐
    title: MCP 协议支持
    details: 支持 Model Context Protocol，可连接外部 MCP Server（stdio/SSE），自动发现工具并注册到 Tool Registry。
  - icon: 📚
    title: RAG 知识检索
    details: 开箱即用的 RAG 模块，自动加载本地文档、递归文本切分、向量语义检索。Agent 自动调用 search_knowledge 工具检索相关知识。
---

## 快速体验

```bash
npm install kagent-ts
```

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  tools: [],
  maxIterations: 10,
})

const answer = await agent.run('请介绍一下 TypeScript 的特点。')
console.log(answer)
```

## 项目架构

```
kagent-ts
├── core/           # Agent 基类 + 4 种 Agent 循环实现
│   ├── agent.ts             # Agent 基类（共享基础设施）
│   ├── react-agent.ts       # ReAct Agent (Thought → Action → Observation)
│   ├── plan-solve-agent.ts  # Plan-Solve Agent (Plan → Execute → Answer)
│   ├── fusion-agent.ts      # Fusion Agent (路由 + 计划 + 执行 + 反思)
│   ├── types.ts             # Agent 公共类型定义
│   ├── hooks.ts             # Agent 生命周期钩子
│   ├── system-prompts.ts    # 系统提示模板
│   └── response-schema.ts   # LLM 结构化输出解析
├── orchestrator/   # Orchestrator Agent (DAG 任务分解 + 并行调度)
│   ├── orchestrator-agent.ts      # 编排 Agent 主逻辑
│   ├── orchestrator-response.ts   # 结构化响应解析（分解/综合/适配）
│   ├── orchestrator-types.ts      # DAG 任务图类型定义
│   └── json-extractor.ts          # JSON 提取工具
├── llm/            # LLM Provider 体系
│   ├── interface.ts          # LLM Provider 统一接口
│   ├── openai-provider.ts    # OpenAI Provider
│   ├── anthropic-provider.ts # Anthropic Provider
│   ├── factory.ts            # Provider 工厂函数
│   ├── fallback-provider.ts  # Fallback 降级 Provider
│   ├── rate-limiter.ts       # Rate Limiter 限流
│   ├── model-router.ts       # Model Router 路由
│   ├── token-budget.ts       # Token Budget 预算控制
│   ├── errors.ts             # 网络错误类型
│   └── retry.ts              # 重试策略
├── tools/          # 工具系统
│   ├── types.ts                  # 工具类型 + Circuit Breaker 状态
│   ├── tool-registry.ts          # 工具注册中心
│   ├── circuit-breaker.ts        # Circuit Breaker 熔断器
│   ├── tool-validator.ts         # JSON Schema 参数验证
│   ├── tool-output-truncator.ts  # 大输出裁剪到磁盘
│   ├── tool-filter.ts            # 子代理工具权限过滤
│   └── builtin/            # 15 个内置工具（bash, read_file, write_file, edit_file,
│                            #   grep_search, glob_search, web_fetch, skill,
│                            #   spawn_subagent, remember, recall）
├── session/        # 会话持久化与恢复（Checkpoint + 优雅关闭）
├── context/        # 上下文窗口管理（Token 预算 + 智能裁剪）
├── compression/    # 4 步渐进式上下文压缩
├── messages/       # 消息构造与类型定义
├── skills/         # 渐进式 Skill 系统（SKILL.md, Lazy-loading）
├── subagent/       # 子代理定义、加载与调度
├── mcp/            # MCP 协议客户端管理（stdio / SSE）
├── rag/            # RAG 知识检索
│   ├── rag-manager.ts         # RAG 主管理器
│   ├── document-loader.ts     # 文档加载器（Markdown, TXT, PDF）
│   ├── text-splitter.ts       # 递归文本切分（token/chunk 双模式）
│   ├── embedding-provider.ts  # Embedding 向量化（OpenAI）
│   ├── vector-store.ts        # 向量存储接口
│   ├── chroma-store.ts        # ChromaDB 向量存储实现
│   ├── keyword-index.ts       # BM25 关键词索引
│   ├── search-knowledge.ts    # 知识搜索工具
│   ├── rrf.ts                 # RRF 融合算法
│   ├── llm-reranker.ts        # LLM 重排序
│   ├── cross-encoder-reranker.ts  # Cross-Encoder 重排序（默认）
│   └── rag-types.ts           # 类型定义
├── reflection/     # 记忆提取 (MemoryReflector)
├── security/       # Prompt Injection 防御（边界标记 + 注入签名扫描）
├── git/            # Git Worktree 隔离（子代理并行执行文件隔离）
├── memory/         # 长期记忆 (MEMORY.md)
├── rules/          # 项目规则注入 (CLAUDE.md)
├── eval/           # 评估框架（Benchmark 回归测试）
├── trace/          # 执行追踪 (HTML Trace Logger)
├── logging/        # 结构化日志接口
└── utils/          # Token 计数等工具
```
