---
layout: home

hero:
  name: "kagent-ts"
  text: "TypeScript AI Agent 框架"
  tagline: ReAct / Plan-Solve / Fusion / Orchestrator — 多模式 LLM Agent 框架，内置完善的工具管理、会话持久化、反思与安全机制
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
    details: 支持 ReAct、Plan-Solve、Fusion（混合）和 Orchestrator（多代理编排）四种 Agent 循环范式，灵活应对不同复杂度的任务。
  - icon: 🔧
    title: 完善的工具系统
    details: 内置 13 种工具（文件读写、搜索、Shell 执行、网络抓取等），支持 Circuit Breaker 熔断、JSON Schema 参数验证、工具输出截断和 HITL 审批。
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
    details: 基于 SKILL.md 文件的渐进式技能加载，Lazy-loading 按需激活，支持 Reference 文档和 Scripts 脚本。
  - icon: 🌐
    title: MCP 协议支持
    details: 支持 Model Context Protocol，可连接外部 MCP Server（stdio/SSE），自动发现工具并注册到 Tool Registry。
---

## 快速体验

```bash
npm install kagent-ts
```

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({
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
│   └── fusion-agent.ts      # Fusion Agent (路由 + 计划 + 执行 + 反思)
├── orchestrator/   # Orchestrator Agent (DAG 任务分解 + 并行调度)
├── llm/            # LLM Provider (OpenAI, Anthropic, Fallback, Router)
├── tools/          # 工具系统 (Registry, Circuit Breaker, Validator)
│   └── builtin/    # 13 个内置工具
├── session/        # 会话持久化与恢复
├── context/        # 上下文窗口管理
├── compression/    # 4 步渐进式上下文压缩
├── skills/         # 渐进式 Skill 系统 (SKILL.md)
├── subagent/       # 子代理定义与调度
├── mcp/            # MCP 协议客户端管理
├── reflection/     # 反思代理 + 错误笔记本
├── security/       # Prompt Injection 防御
├── memory/         # 长期记忆 (MEMORY.md)
├── eval/           # 评估框架 (EvalRunner, Benchmark)
├── trace/          # 执行追踪 (HTML Trace Logger)
└── utils/          # Token 计数等工具
```
