# 核心概念

kagent-ts 框架围绕 **Agent 循环范式** 构建。每种范式提供不同的执行策略，适用于不同复杂度的任务。

## Agent 范式对比

|------|----------|----------|--------|

## 共享基础设施

所有 Agent 类型都继承自 `Agent` 基类，共享以下能力：

- **LLM Provider 管理** — 统一的 LLM 调用接口
- **工具注册与执行** — Tool Registry + Circuit Breaker 熔断保护
- **上下文管理** — 自动 Token 阈值检测 + 渐进式压缩
- **会话持久化** — Checkpoint 自动保存与恢复
- **生命周期钩子** — `AgentHooks` 事件系统
- **子代理调度** — Sub-Agent 生成与轮询
- **MCP 协议** — 外部 MCP Server 工具发现
- **RAG 知识检索** — 向量/BM25 混合检索 + RRF 融合 + Re-rank 精排
- **安全防护** — 多层 Prompt Injection 防御
- **Token 预算** — 会话级 Token 成本控制

## Agent 基类架构

```
Agent (base class)
├── ContextManager      # 上下文窗口管理
├── ToolRegistry        # 工具注册与执行
├── SessionManager      # 会话持久化
├── SkillManager        # 渐进式技能系统
├── SubAgentManager     # 子代理管理
├── McpClientManager    # MCP 客户端管理
├── RAGManager          # RAG 知识检索（向量/BM25 混合检索 + RRF + Re-rank）
├── MemoryManager       # 长期记忆
├── 
├── ProjectRules        # 项目规则加载
└── Logger              # 结构化日志
```

## 选择指南

- **简单任务**（问答、单次搜索、单文件操作）→ 使用 `ReActAgent`
- **多步骤任务**（代码审查、项目分析、文件重构）→ 使用 `PlanSolveAgent`
- **通用场景**（不确定任务复杂度，希望自动适配）→ 使用 `FusionAgent`
- **大规模任务**（跨模块变更、多代理协作）→ 使用 `OrchestratorAgent`

## 下一步

- [Agent 基类](/core/agent) — 了解共享基础设施的详细配置
- [ReAct Agent](/core/react-agent) — 简单高效的 Thought → Action 循环
- [Plan-Solve Agent](/core/plan-solve-agent) — 先规划后执行
- [Fusion Agent](/core/fusion-agent) — 智能路由 + 反思
- [Orchestrator Agent](/core/orchestrator-agent) — DAG 任务分解与并行编排
