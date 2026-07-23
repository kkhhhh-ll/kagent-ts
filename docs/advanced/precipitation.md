# Skill Precipitation 技能沉淀

Skill Precipitation 让 Agent 在任务完成后**自动提取可复用的技能**，保存为 `SKILL.md` 文件。沉淀下来的技能包含**自动生成的关键词**，在下一次会话中可以被意图识别系统自动激活。

## 为什么需要沉淀？

Agent 在执行中积累了大量隐性知识——某个项目特有的部署流程、踩过的坑、有效的工具组合——这些如果没有沉淀，下次遇到同类任务又得从零开始。

沉淀机制自动捕获这些经验，让 Agent **越用越聪明**。

## 架构

```text
Agent 产出 answer
  ↓
  ↓ (答案返回给用户)
  ↓ (后台 fire-and-forget，不阻塞)
runPrecipitation()
  ├── Fork PrecipitateAgent (ReAct, max 15 turns by default)
  │     ├── 审查完整对话历史
  │     ├── 用 read_file / grep_search 验证发现
  │     ├── 与已有 Skills 对比去重
  │     └── 提取 SkillCandidate[] (name, description, keywords, content)
  │
  └── 写入 SKILL.md 文件（含 keywords frontmatter）
        ↓
        skillManager.reloadFromDirectory() → 下次 Agent 调用时自动加载
        ↓
        关键词匹配 → 自动激活
```

PrecipitateAgent Fork 一个轻量的 ReAct Agent，拥有独立上下文和只读工具，不污染主 Agent 上下文。沉淀在后台执行，失败不阻塞——调用方用 `try-catch`（旧版）或 `.catch()`（当前：fire-and-forget）包裹，沉淀失败以 `error` 级别记录日志，不会影响用户拿到的答案。

整个沉淀过程有 **5 分钟硬超时**保护：通过 `AbortController` 将取消信号传递到 fork → ReActAgent → LLM `chat()` 调用，**真正中止** HTTP 请求，而非仅让 Promise 超时后后台继续消耗 API 配额。

## 触发条件

三种条件可以触发沉淀：

| 条件 | 说明 | mode 要求 | 适用 Agent |
|------|----------|-----------|------|
| `post-hoc` 模式 | 每次执行完成后触发 | `precipitation: "post-hoc"` | ReAct / PlanSolve / Fusion |
| `wantsRemember` 信号 | 用户说"记住"时 | 无视 mode 配置 | ReAct / PlanSolve / Fusion |
| hard-won success | 连续失败 ≥ 2 次后成功 | `mode !== "off"` | ReAct / PlanSolve / Fusion |

> **wantsRemember 信号优先级最高**：即使 `precipitation: "off"`，用户说"记住"时仍会触发。但 MemoryReflection（记忆提取）**不受**踩坑后成功条件触发——记忆提取与工具失败无关，仅受配置模式和 wantsRemember 信号控制。

### 触发逻辑（三个 Agent 一致）

```
Precipitation 触发：
├── mode: "post-hoc"      → ✅ 每次触发
├── wantsRemember 信号    → ✅ 强制触发（无视 mode）
└── hard-won success (≥2) → ✅ 触发（需 mode !== "off"）

MemoryReflection 触发：
├── mode: "post-hoc"      → ✅ 每次触发
└── wantsRemember 信号    → ✅ 强制触发（无视 mode）
```

## 配置

### ReAct Agent / Plan-Solve Agent

```ts
const agent = new ReActAgent({
  llm: provider,
  skillsDir: "./skills",           // 必需：技能存储目录
  precipitation: "post-hoc",       // "off"   precipitationMaxIterations: 15,  // Fork 子 Agent 的 maxIterations（默认 15）
  memoryReflection: "post-hoc",    // 可选：记忆提取
})
```

### 自定义 Precipitation 的 LLM

```ts
const agent = new ReActAgent({
  llm: new OpenAIProvider({ model: "gpt-4o" }),
  precipitationLLM: new OpenAIProvider({ model: "gpt-4o-mini" }),  // 沉淀专用
  skillsDir: "./skills",
  precipitation: "post-hoc",
})
```

也可以使用 `ModelRouter` 集中管理：

```ts
const router = new ModelRouter({
  main: new OpenAIProvider({ model: "gpt-4o" }),
  precipitation: new OpenAIProvider({ model: "gpt-4o-mini" }),
})

const agent = new ReActAgent({
  llm: router,  // Agent 自动检测 ModelRouter
  skillsDir: "./skills",
  precipitation: "post-hoc",
})
```

**LLM 决策优先级**：显式 `precipitationLLM` → `ModelRouter.forPrecipitation()` → 主模型 `llm`

## PrecipitateAgent（Fork 子 Agent）

### 分析维度

| 维度 | 说明 |
|------|------|
| 工具组合 | 识别有效的工具调用序列 |
| 错误恢复 | 记录遇到的错误和解决方法 |
| 项目约定 | 发现项目特有的命名、结构约定 |
| 流程模式 | 抽象可复用的工作流程 |

子 Agent 分析以上维度，与**已有 Skill 列表**对比去重。同时生成 3-8 个关键词用于后续自动激活。

### 结构化输出

```json
{
  "analysis": "本次会话学到了什么（2-4 句话）",
  "skills": [
    {
      "name": "deploy-nextjs-to-vercel",
      "description": "将 Next.js 应用部署到 Vercel 的完整流程",
      "keywords": ["deploy", "vercel", "nextjs", "production", "release"],
      "content": "## Steps\n1. 确保 vercel.json 存在...\n2. 运行 vercel --prod..."
    }
  ]
}
```

> **keywords 字段**：PrecipitateAgent 的 System Prompt 包含关键词生成指引，LLM 需要输出 3-8 个关键词。这些关键词使沉淀的 Skill 在下一次用户输入匹配时自动激活。

## 沉淀产物

生成的 `SKILL.md` 带有 `precipitated: true` 标记和自动生成的关键词：

```markdown
---
name: deploy-nextjs-to-vercel
description: Deploy a Next.js app to Vercel
keywords: ["deploy","vercel","nextjs","production","release"]
precipitated: true
---
## Steps
1. Ensure `vercel.json` exists with correct config
2. Run `vercel --prod`
...
```

- `precipitated: true` — 区分手动 vs 自动沉淀，方便人工审查清理
- `keywords` — 下次用户说 "deploy" 时自动激活，无需 LLM 调用 `skill` 工具

## 去重策略

两层防御：

1. **子 Agent 层面**：Prompt 中包含已有 Skill 的 `name + description` 列表，要求 LLM 对比去重
2. **框架层面**：`persistCandidates()` 写入前检查 `skillManager.has(name)`，已存在的直接跳过

## 安全

| 措施 | 说明 |
|------|----------|
| Fork 隔离 | PrecipitateAgent 在独立 fork 中运行，不污染主 Agent 上下文 |
| 只读工具 | Fork 仅允许 `read_file` / `grep_search` |
| 硬超时 | 5 分钟 AbortController 超时保护 |
| 去重 | 框架层面双重去重，防止重复写入 |

## 完整示例

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS,
} from "kagent-ts"

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: "gpt-4o" }),
  systemPrompt: "你是一个全栈工程师。",
  tools: BUILTIN_TOOLS,
  skillsDir: "./skills",
  precipitation: "post-hoc",
  memoryReflection: "post-hoc",
})

// 用户明确意图 → 触发沉淀 + 记忆提取（无视 mode 配置）
await agent.run("帮我记住怎么配置这个项目的 CI/CD")

// 踩坑后成功 → 仅触发沉淀（不触发记忆提取）
await agent.run("部署我的 Next.js 应用到生产环境")
// 1. LLM 尝试 vercel deploy → 失败（未登录）
// 2. LLM 运行 vercel login → 成功
// 3. LLM 再次 vercel deploy → 成功
// → consecutiveFailures >= 2, 最终成功 → 触发沉淀
```

## 下一步

- [Intent Recognition 意图识别](/advanced/intent) — 信号检测与 Skill 关键词匹配
- [Skills 渐进式技能](/advanced/skills) — 技能定义和加载机制
- [Fork — Agent 派生](/core/fork) — 沉淀子 Agent 使用的轻量派生机制
