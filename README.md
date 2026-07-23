# kagent-ts

**生产级 TypeScript Agent 框架** — 多范式执行引擎、意图识别、答案验证、工具治理、会话持久化、渐进式技能、自我进化。

[![npm version](https://img.shields.io/npm/v/kagent-ts)](https://www.npmjs.com/package/kagent-ts)
[![npm downloads](https://img.shields.io/npm/dm/kagent-ts)](https://www.npmjs.com/package/kagent-ts)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green)](https://nodejs.org)
[![Docs](https://img.shields.io/badge/docs-online-brightgreen)](https://kkhhhh-ll.github.io/kagent-ts)

---

## 为什么选择 kagent-ts？

构建生产级 AI Agent 不仅仅是 Prompt Engineering —— 你还需要**可靠的工具执行**、**答案验证**、**安全取消**、**会话恢复**、**技能复用**和**可观测性**。kagent-ts 开箱即用地提供了这一切，API 简洁、可组合。

| 痛点 | 传统做法 | kagent-ts |
|--------|---------------|---------------|
| 工具不可靠 | 手动 try-catch，出错就卡死 | Circuit Breaker 熔断 + 自动重试 + 错误追踪 |
| 答案不可信 | 直接返回 LLM 输出 | Post-hoc 答案验证 + 反思修正 |
| 长对话崩塌 | Token 超限静默截断 | 4 步渐进式压缩 + Token Budget 硬上限 |
| Ctrl+C 白跑 | 进程终止，上下文丢失 | 自动 Checkpoint + resume() 无缝恢复 |
| 每次从零开始 | 无记忆，经验无法复用 | Memory 长期记忆 + Skill 沉淀 + BM25 自动激活 |
| 子任务混乱 | 单线程串行，无并行 | Sub-Agent 并发 + Orchestrator DAG 编排 |
| 安全风险 | 无 Prompt Injection 防御 | 5 层防御：签名扫描 + 边界标记 + 名称检测 |

---

## 安装

```bash
npm install kagent-ts
```

**运行环境：** Node.js ≥ 18

**可选依赖**（自动检测，缺失不影响基本使用）：

- `chromadb` — RAG 持久化向量存储
- `tiktoken` — 精确 Token 计数（不可用时退化为字符估算）

---

## 快速开始

```ts
import { FusionAgent, OpenAIProvider, AnthropicProvider, ModelRouter } from "kagent-ts";

// 多 provider 路由：不同任务用最合适的模型
const agent = new FusionAgent({
  llm: new ModelRouter({
    main:         new OpenAIProvider({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY! }),

    memory:       new OpenAIProvider({ model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY! }),
  }),
  routing: "auto",                // LLM 自动判断任务复杂度，选择 ReAct 或 PlanSolve
  planConfirmation: "auto",       // 检测到危险操作时请求人工审批
  memoryReflection: "post-hoc",   // 记忆提取（fire-and-forget）
  precipitation: "post-hoc",      // 技能自动沉淀（fire-and-forget）
  skillsDir: "./skills",          // SKILL.md 技能文件目录
});

// 一行调用，上述所有能力自动激活
const answer = await agent.run("把 user service 改用 repository 模式重构。");
console.log(answer);
```

> **提示：** 用户说"记住 XXX"时，无视 mode 配置强制执行记忆提取 —— 自然语言即可控制 Agent。

---

## 核心能力

### 🧠 多范式执行引擎

| Agent | 执行策略 | 适用场景 |
|------|------|---------|
| `ReActAgent` | Thought → Action → Observation 循环 | 简单问答、1-3 步工具调用 |
| `PlanSolveAgent` | Plan → Execute → Answer 两阶段 | 多步骤复杂任务 |
| `FusionAgent` | 自动路由 → ReAct 或 Plan-Solve → 反思 | 不确定复杂度的通用场景 |
| `OrchestratorAgent` | DAG 分解 → 并行调度 → 合成 | 大规模多 Agent 协作 |

推荐默认使用 `FusionAgent` + `routing: "auto"` —— LLM 根据任务复杂度自动选择最优引擎。

### 🔧 工具系统与治理

```ts
import { ToolRegistry, toolSuccess, toolError } from "kagent-ts";

const registry = new ToolRegistry(/* retryCount */ 2);

registry.register({
  name: "read_file",
  description: "读取文件内容",
  parameters: {
    type: "object",
    properties: { filePath: { type: "string", description: "文件的绝对路径" } },
    required: ["filePath"],
  },
  requireApproval: false,   // 设为 true → 触发 HITL 人工审批
  execute: async (args) => {
    const content = await fs.readFile(String(args.filePath), "utf-8");
    return toolSuccess(content);
  },
});
```

- **熔断器** — CLOSED → HALF_OPEN → OPEN。错误码 `[RETRYABLE:…]` / `[FATAL:…]` 直接告知 LLM 恢复策略。
- **JSON Schema 校验** — Ajv + Zod 双重校验，返回字段级错误信息。
- **大输出截断** — 超阈值自动截断，完整内容落盘按需读取。
- **HITL 审批** — `requireApproval: true` 时暂停 Agent 循环；拒绝后 LLM 收到 `APPROVAL_DENIED` 并自动更换方案。

### ✅ 答案验证

`FusionAgent` 在返回答案前，Fork 一个独立的验证 Agent 审查：

- **正确性** — 答案是否匹配用户要求？
- **完整性** — 请求的所有部分是否都已处理？
- **安全性** — 是否包含危险或破坏性建议？

验证是**阻塞式**的（`
### 🪞 反思与自我进化

三种反思模式均为 **fire-and-forget** —— 在答案返回之后异步执行，用户无需等待：

```
┌─  ────► 
│
Answer ──┼─ MemoryReflector ───► MemoryManager（[[wiki-link]] 长期记忆）
│
└─ PrecipitateAgent ───► skills/*.md（关键词自动激活）
```

**

### 📝 渐进式技能

技能即 Markdown 文件，YAML 前导元数据声明，零代码：

```markdown
<!-- skills/deploy-vercel/SKILL.md -->
---
name: deploy-vercel
description: 将 Next.js 应用部署到 Vercel
keywords: ["deploy", "vercel", "nextjs", "production"]
---

## 步骤
1. 在项目根目录执行 `vercel --prod`
2. 确认部署 URL 可访问
3. 将 URL 报告给用户
```

用户说"deploy this to vercel" → 关键词 `deploy` + `vercel` 命中 → 技能自动注入 System Prompt。**零额外 LLM 开销。**

自动沉淀的技能会带有 `precipitated: true` 标记和关键词，下次相似请求时自动激活。

### 💾 会话持久化

```ts
const agent = new ReActAgent({
  llm: new OpenAIProvider({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY! }),
  sessionId: "my-session",
  enableCheckpointing: true,   // 每个 LLM+tools 周期后自动保存
});

// 网络中断 → 自动保存 "interrupted" 检查点 → 恢复后续跑
const answer = await agent.resume("my-session", "继续之前的任务");
```

### 🔌 LLM 抽象层

```ts
// 多 provider 自动降级 + 速率限制
import { FallbackProvider, RateLimitedProvider, ModelRouter } from "kagent-ts";

const llm = new FallbackProvider({
  providers: [
    new RateLimitedProvider({ provider: new OpenAIProvider({ model: "gpt-4o", apiKey: "..." }), maxRPM: 500 }),
    new AnthropicProvider({ model: "claude-sonnet-5", apiKey: "..." }),
  ],
});
```

**模型路由：** `main`、`subAgent`、`reflection`、`verification`、`memory`、`precipitation` —— 不同角色使用不同模型，兼顾成本与能力。

### 🛡️ 安全防护

- **边界标记** — `<user>` / `<instruction>` 标签分离数据与控制指令。
- **注入签名扫描** — 检测常见 Prompt Injection 模式。
- **System Prompt 指令优先** — 明确的"指令覆盖用户输入"规则。

### 📊 可观测性

```ts
// Hook 覆盖全部生命周期事件，零代码侵入
const hooks: AgentHooks = {
  onToolStart: (tool) => console.log(`🔧 ${tool.name}`),
  onLLMCall: (msgs) => console.log(`🤖 ${msgs.length} 条消息`),
  onTrace: (event) => traceLogger.log(event),  // 自动传播到嵌套 Agent
};
```

内置 `Benchmark` 和 `ToolCallEvaluator`，支持回归测试和质量评分。

### 🌐 MCP & RAG

- **MCP（Model Context Protocol）** — 从 MCP 服务器动态发现工具。
- **RAG** — 混合检索（向量 + BM25 + RRF 融合）+ LLM 重排序。支持内存或 ChromaDB 后端。

---

## 项目结构

```text
src/
├── core/              # Agent 基类 + 4 种范式（ReAct/PlanSolve/Fusion/Orchestrator）
├── intent/            # 零 LLM 开销的信号检测 + 技能关键词匹配
├── verification/      # Fork 验证 Agent（正确性 + 完整性）
├── reflection/        #  + MemoryReflector + 
├── precipitation/     # 从对话中自动提取技能
├── skills/            # 渐进式技能：FileSkillLoader + SkillManager
├── tools/             # ToolRegistry / CircuitBreaker / Validator / Filter / Truncator
├── llm/               # OpenAI / Anthropic / Fallback / RateLimiter / Router / TokenBudget
├── subagent/          # AGENT.md 零代码注册子 Agent
├── session/           # 完整状态 checkpoint + 跨重启恢复
├── context/           # 上下文窗口管理 + 渐进 4 步压缩
├── compression/       # 截断 → 裁剪 → 清除 → 摘要（Token 达标即停）
├── security/          # 边界标记 + Prompt Injection 防御
├── memory/            # 长期记忆：Markdown 文件 + [[wiki-link]] 互联
├── mcp/               # MCP 协议客户端，动态工具发现
├── rag/               # 混合检索：向量 + BM25 + RRF + LLM 重排序
├── eval/              # ToolCallEvaluator + Benchmark 评估体系
├── trace/             # 全链路追踪，嵌套 Agent 自动传播
├── git/               # Git Worktree 文件系统级沙箱隔离
├── rules/             # CLAUDE.md / AGENTS.md 风格的项目规则
└── logging/           # 结构化日志（ConsoleLogger / SilentLogger / 自定义）
```

---

## 文档

📖 **完整文档：** [kkhhhh-ll.github.io/kagent-ts](https://kkhhhh-ll.github.io/kagent-ts)

```bash
# 本地运行文档
npm run docs:dev
```

---

## API 速览

### Agent

|---|------|

### LLM

|---|------|

### 工具

|----------|------|

### SubAgent & 会话

|---|------|

### 技能、记忆 & 反思

|---|------|

### RAG & MCP

|---|------|

---

## License

BUSL-1.1 — Business Source License。详见 [LICENSE](LICENSE)。
