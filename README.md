# kagent-ts

生产级 TypeScript Agent 框架，支持多范式执行引擎、意图识别、答案验证、工具治理、会话持久化、渐进式技能与自我进化。

[![npm version](https://img.shields.io/npm/v/kagent-ts)](https://www.npmjs.com/package/kagent-ts)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-green)](package.json)

---

## 核心特性

| 模块 | 能力 |
|------|------|
| **多范式引擎** | ReAct（Think→Act→Observe）、PlanSolve（Plan→Resolve→Revise）、Fusion（Route→Plan/Execute→Verify）、Orchestrator（Decompose→Dispatch→Synthesize） |
| **意图识别** | 零 LLM 开销的信号检测（`记住`/`deploy` 等）+ Skill 关键词自动匹配激活，统一数据源 |
| **答案验证** | 返回前 Fork 独立 Agent 审查正确性与完整性，不通过则自动修正 |
| **工具治理** | 熔断器三态转换 + JSON Schema 字段级校验 + 大输出截断 + HITL 按工具粒度审批 |
| **LLM 抽象** | OpenAI / Anthropic 统一接口 + 模型路由（main/subAgent/reflection/verification/memory/precipitation）+ 自动降级 + Token 预算 |
| **上下文管理** | 渐进 4 步压缩（截断→裁剪→清除→摘要），每步后检测 Token 达标即停 |
| **会话持久化** | 每种 Agent 类型保存完整运行时状态，断点续跑 + AbortController 安全取消 |
| **渐进式技能** | SKILL.md 文件定义，关键词自动激活，Precipitation 自动沉淀含关键词的技能 |
| **长期记忆** | Markdown 文件替代向量库，`[[wiki-link]]` 互联，LLM 自主管理 |
| **反思系统** | 错题本（ErrorNotebook）跨 Session 注入 + 记忆提取 + 技能沉淀，全部 fire-and-forget |
| **安全防护** | 边界标记分离 Data/Instruction + 注入签名扫描 + System Prompt 指令优先 |
| **可观测性** | Hook 系统零侵入全链路追踪，自动传导嵌套 Agent；Eval + Benchmark 量化评估 |
| **SubAgent** | AGENT.md 零代码注册，三级权限过滤，结果作为用户消息注入主 Agent |
| **Git Worktree** | 文件系统级沙箱，默认丢弃不留痕，零外部依赖 |
| **MCP / RAG** | MCP 协议动态工具发现 + 混合检索（向量+BM25+RRF）+ LLM 重排序 |

---

## 安装

```bash
npm install kagent-ts
```

需要 Node.js ≥ 18。可选依赖：`chromadb`（向量存储）、`tiktoken`（精确 Token 计数）。

---

## 快速开始

```ts
import { FusionAgent, OpenAIProvider, AnthropicProvider, ModelRouter } from "kagent-ts";

const router = new ModelRouter({
  main: new OpenAIProvider({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
  verification: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
  memory: new OpenAIProvider({ model: "gpt-4o-mini" }),
});

const agent = new FusionAgent({
  llm: router,
  routing: "auto",                // LLM 自动判断任务复杂度
  planConfirmation: "auto",       // 检测到危险操作时请求审批
  verification: "post-hoc",       // 答案验证（阻塞式，不通过自动修正）
  reflection: "post-hoc",         // 错题本反思（fire-and-forget）
  memoryReflection: "post-hoc",   // 记忆提取（fire-and-forget）
  skillsDir: "./skills",          // Skill 目录，自动扫描
  precipitation: "post-hoc",      // 技能自动沉淀
});

const answer = await agent.run("重构 user service，改用 repository 模式。");
```

核心能力一行配置全开：自适应路由 + 答案验证 + 反思 + 记忆 + 技能沉淀。用户说"记住"时无视 mode 配置强制执行。

---

## 工具系统

```ts
import { ToolRegistry, toolSuccess } from "kagent-ts";

const registry = new ToolRegistry(/* retryCount */ 2);

registry.register({
  name: "read_file",
  description: "读取文件内容",
  parameters: {
    type: "object",
    properties: { filePath: { type: "string" } },
    required: ["filePath"],
  },
  requireApproval: false,   // true → HITL 审批
  execute: async (args) => toolSuccess(await fs.readFile(args.filePath, "utf-8")),
});
```

- **熔断器**：CLOSED → HALF_OPEN → OPEN，错误码 `[RETRYABLE:…]`/`[FATAL:…]` 直接告知 LLM 恢复策略
- **参数校验**：Ajv + Zod 双重 Schema 校验，返回字段级错误
- **大输出截断**：超阈值自动截断，完整版落盘按需读取
- **HITL**：`requireApproval: true` 时暂停 Agent 循环，Deny 后 LLM 看到 `APPROVAL_DENIED` 自动换方案

---

## Skill 渐进式技能

```markdown
<!-- skills/code-reviewer/SKILL.md -->
---
name: code-reviewer
description: 审查代码质量并生成改进建议
keywords: ["review", "code", "quality", "security"]
---

你是一个代码审查专家。审查维度：类型安全、错误处理、性能、可读性。
```

用户说"review this code" → 关键词 `review` 命中 → Skill 在 LLM 调用前自动激活注入 System Prompt，零额外开销。

沉淀的 Skill 自动包含关键词：

```markdown
---
name: deploy-nextjs-to-vercel
description: 将 Next.js 应用部署到 Vercel
keywords: ["deploy","vercel","nextjs","production"]
precipitated: true
---
```

## 会话持久化

```ts
const agent = new ReActAgent({
  llm: provider,
  sessionId: "my-session",
  enableCheckpointing: true,   // 每个 LLM+tools 周期后自动保存
});

// 网络中断 → 自动保存 "interrupted" 检查点 → 恢复网络后续跑
const answer = await agent.resume("my-session", "继续之前的任务");
```

---

## 项目结构

```text
src/
├── core/          # Agent 基类 + 4 种范式（ReAct/PlanSolve/Fusion/Orchestrator）
├── intent/        # 意图识别：信号检测 + Skill 关键词匹配
├── verification/  # 答案验证：Fork VerifyAgent 审查正确性
├── reflection/    # 反思系统：ReflectionAgent + MemoryReflector + ErrorNotebook
├── precipitation/ # 技能沉淀：PrecipitateAgent 自动提取可复用技能
├── skills/        # 渐进式技能：FileSkillLoader + SkillManager
├── tools/         # 工具系统：Registry / CircuitBreaker / Validator / Filter
├── llm/           # LLM 抽象：OpenAI / Anthropic / Fallback / Router / TokenBudget
├── subagent/      # 子 Agent 生命周期管理
├── session/       # 会话持久化：Checkpoint + Resume
├── context/       # 上下文管理 + 渐进 4 步压缩
├── security/      # Prompt Injection 防护
├── memory/        # 长期记忆：Markdown 文件 + [[wiki-link]]
├── mcp/           # MCP 协议客户端
├── rag/           # 混合检索：向量 + BM25 + RRF + LLM 重排序
├── eval/          # 评估体系：ToolCallEvaluator + EvalRunner + Benchmark
├── trace/         # 全链路追踪：TraceLogger
├── git/           # Git Worktree 隔离执行
└── preferences/   # 用户偏好注入 + 项目规则
```

---

## 文档

**[kkhhhh-ll.github.io/kagent-ts](https://kkhhhh-ll.github.io/kagent-ts)**

本地运行：`npm run docs:dev`

## License

BUSL-1.1 — Business Source License.
