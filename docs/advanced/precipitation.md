# Skill Precipitation 技能沉淀

Skill Precipitation 让 Agent 在任务完成后**自动提取可复用的技能**，保存为 `SKILL.md` 文件。沉淀下来的技能在后续会话中会被自动发现和加载。

## 为什么需要沉淀？

Agent 在执行中积累了大量隐性知识——某个项目特有的部署流程、踩过的坑、有效的工具组合——这些如果没有沉淀，下次遇到同类任务又得从零开始。

沉淀机制自动捕获这些经验，让 Agent **越用越聪明**。

## 架构

```text
Agent 执行完成 → 返回答案给用户
  ↓ (后台 fire-and-forget，不阻塞)
runPrecipitation()
  ├── Fork PrecipitateAgent (ReAct, max 15 turns by default)
  │     ├── 审查完整对话历史
  │     ├── 用 read_file / grep_search 验证发现
  │     ├── 与已有 Skills 对比去重
  │     └── 提取 SkillCandidate[] (name, description, content)
  │
  └── 写入 SKILL.md 文件
        ↓
        skillManager.reloadFromDirectory() → 下次 Agent 调用时自动加载
```

PrecipitateAgent Fork 一个轻量的 ReAct Agent，拥有独立上下文和只读工具，不污染主 Agent 上下文。沉淀在后台执行，失败不阻塞——每个 Agent 类型的调用方用 `try-catch` 包裹，沉淀失败以 `error` 级别记录日志，不会影响用户拿到的答案。

整个沉淀过程有 **5 分钟硬超时**保护：通过 `AbortController` 将取消信号传递到 fork → ReActAgent → LLM `chat()` 调用，**真正中止** HTTP 请求，而非仅让 Promise 超时后后台继续消耗 API 配额。主 Agent 的 `hooks`（如 TraceLogger）自动透传到 fork 子 Agent，fork 内部的工具调用和 LLM 交互都会出现在 trace 文件中。新技能在下一次 Agent 调用时自动生效。

## 触发条件

三种条件可以触发沉淀，最终取决于 `precipitation` 配置：

| 条件 | 检测方式 | 开销 |
|------|----------|------|
| **配置开启** | `precipitation: "post-hoc"` | 零 |
| **踩坑后成功** | `consecutiveFailures >= 2` 且最终成功 | 零（已有计数） |
| **用户说"记住"** | 输入正则匹配：`remember\|save (this\|it)\|记住\|保存\|記住\|儲存\|记录下来` | 零 |

```ts
precipitation: "off"       // 永不触发
precipitation: "post-hoc"  // 以上三种条件都生效
```

## 配置

### ReAct Agent / Plan-Solve Agent

```ts
const agent = new ReActAgent({
  llm: provider,
  skillsDir: "./skills",           // 必需：技能存储目录
  precipitation: "post-hoc",       // "off" | "post-hoc"
  precipitationMaxIterations: 15,  // Fork 子 Agent 的 maxIterations（默认 15）
})
```

### Fusion Agent

```ts
const agent = new FusionAgent({
  llm: provider,
  skillsDir: "./skills",
  precipitation: "post-hoc",
  precipitationMaxIterations: 15,
})
```

Fusion Agent 中沉淀作为 **Phase 5** 在后台运行（与 Phase 4 Reflection 一样，均为 fire-and-forget，不阻塞最终答案的返回）。

## PrecipitateAgent（Fork 子 Agent）

Fork 子 Agent 的分析维度：

| 维度 | 说明 |
|------|------|
| **可复用模式** | 工作流、策略、工具组合 |
| **领域知识** | 项目特有的约定、配置、限制 |
| **工具使用洞察** | 特定工具在特定场景下的高效用法 |
| **错误恢复策略** | 遇到某类失败时的可靠解决方案 |

子 Agent 会将以上维度的发现与**已有 Skill 列表**对比，避免重复沉淀。

### 结构化输出

子 Agent 的最终答案是 JSON：

```json
{
  "analysis": "本次会话学到了什么（2-4 句话）",
  "skills": [
    {
      "name": "deploy-nextjs-to-vercel",
      "description": "将 Next.js 应用部署到 Vercel 的完整流程",
      "content": "## Steps\n1. 确保 vercel.json 存在...\n2. 运行 vercel --prod..."
    }
  ]
}
```

## precipitate_skill 工具

Agent 执行过程中，LLM 也可以**主动调用** `precipitate_skill` 工具保存技能：

```ts
// 工具参数
{
  name: "prisma-migration-workflow",        // kebab-case 唯一名称
  description: "Prisma 数据库迁移流程",       // 在可用技能列表中展示
  content: "## Steps\n1. 修改 schema.prisma\n2. 运行 prisma migrate dev..."
}
```

工具默认 `requireApproval: true`，需要用户审批后才会写入。

## 沉淀产物

生成的 `SKILL.md` 带有 `precipitated: true` 的 frontmatter 标记：

```markdown
---
name: deploy-nextjs-to-vercel
description: Deploy a Next.js app to Vercel
precipitated: true
---
## Steps
1. Ensure `vercel.json` exists with correct config
2. Run `vercel --prod`
...
```

这样手动创建的技能和自动沉淀的技能可以明确区分，方便后续人工审查和清理。

## 去重策略

两层防御：

1. **子 Agent 层面**：Prompt 中包含已有 Skill 的 `name + description` 列表，要求 LLM 对比去重
2. **框架层面**：`persistCandidates()` 写入前检查 `skillManager.has(name)`，已存在的直接跳过

## 安全

| 问题 | 缓解措施 |
|------|----------|
| LLM 幻觉写入低质量技能 | 技能惰性加载，LLM 需显式激活才会生效 |
| 技能名路径遍历 | 正则检查（同 `FileSkillLoader`） |
| 技能数量膨胀 | `precipitated: true` 标记方便人工审查清理 |
| 沉淀失败阻塞主流程 | 调用方 try-catch + 5 分钟 AbortController 硬超时（中止 LLM 请求） |
| Fork 内部事件不可见 | hooks 自动透传（TraceLogger 可记录 fork 内的工具调用和 LLM 交互） |

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
} from "kagent-ts"

const agent = new ReActAgent({
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o",
  }),
  systemPrompt: "你是一个全栈工程师。",
  tools: BUILTIN_TOOLS,
  skillsDir: "./skills",
  precipitation: "post-hoc",
})

// 正常情况下不会触发沉淀（无失败）
await agent.run("列出 src/ 目录下的所有 .ts 文件")

// 踩坑后成功 → 触发沉淀
await agent.run("部署我的 Next.js 应用到生产环境")
// 1. LLM 尝试 vercel deploy → 失败（未登录）
// 2. LLM 运行 vercel login → 成功
// 3. LLM 再次 vercel deploy → 成功
// → consecutiveFailures >= 2, 最终成功 → 触发沉淀

// 用户明确意图 → 触发沉淀
await agent.run("帮我记住怎么配置这个项目的 CI/CD")
// → 输入匹配 "记住" → 触发沉淀

// 执行中调用工具沉淀
// LLM 发现可复用模式，主动调用 precipitate_skill 工具
```

## 追踪与调试

Precipitation 的 fork 内部运行在独立上下文中，控制台默认看不到 fork 的工具调用和 LLM 交互。通过 `TraceLogger` 可以完整记录这些事件。

### 基本用法

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS, TraceLogger,
} from "kagent-ts"

// 1. 创建 TraceLogger
const trace = new TraceLogger({
  sessionId: "precipitate-demo",
  outputDir: ".kagent-traces",  // trace 文件输出目录
})

// 2. 放入主 Agent 的 hooks
const agent = new ReActAgent({
  llm: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-4o",
  }),
  tools: BUILTIN_TOOLS,
  skillsDir: "./skills",
  precipitation: "post-hoc",
  hooks: [trace],   // ← TraceLogger 自动透传到 fork 内部
})

await agent.run("帮我审查 src/precipitation/ 目录下的代码")

// 3. 查看生成的 trace 文件
// → .kagent-traces/trace-precipitate-demo.html
```

### Trace 文件里能看到什么

打开生成的 HTML 文件，页面结构如下：

- **主 Agent 时间线**：Thought、LLM 调用、工具调用、Final Answer
- **🔀 Fork Agents 区域**（独立折叠区）：
  - Precipitation fork 内部的 `read_file` / `grep_search` 调用及参数
  - Fork 内部每轮 LLM 调用的 token 消耗
  - Fork 的最终 JSON 输出（分析结果 + 提取的技能）
- **🤖 Sub-Agents 区域**（独立折叠区，如果有的话）：
  - 通过 `spawn_subagent` 工具派生的子 Agent 轨迹

Fork 和 Sub-Agent 在两个独立区域中展示，不会混在一起，一眼就能区分"后台沉淀的 fork"和"LLM 主动 spawn 的子 Agent"。

> **原理**：传给 fork 的 `hooks` 中的 `TraceLogger` 会被自动替换为 `createForkChildTrace()` 创建的子实例。Fork 的事件写入子 trace，fork 完成后子 trace 数据推入父 trace 的 `childrenTraces` 数组并标记 `kind: "fork"`，父 trace HTML 文件自动重新刷新。

### 只用自动沉淀（ReAct / PlanSolve / Fusion Agent）

无需额外配置——Agent 构造时把 `hooks` 放进去即可，`runPrecipitation()` 内部会把 `this.hooks` 传给 fork：

```ts
// ReActAgent
new ReActAgent({ ..., hooks: [trace], precipitation: "post-hoc" })

// FusionAgent
new FusionAgent({ ..., hooks: [trace], precipitation: "post-hoc" })
```

### 直接调用 PrecipitateAgent

手动传 `hooks`：

```ts
const precipitator = new PrecipitateAgent({
  llm,
  skillsDir: "./skills",
  skillManager,
  hooks: [trace],   // ← 手动传
})

const candidates = await precipitator.precipitate({ ... })
```

或通过静态方法：

```ts
await PrecipitateAgent.runFromAgent({
  input, answer, skillsDir, skillManager, llm,
  sessionId, maxIterations: 15, logger,
  contextMessages,
  hooks: [trace],   // ← 手动传
})
```

### 取消 / 超时时的轨迹

即使 fork 被 5 分钟硬超时取消，TraceLogger 也会在 `onFinish` 中正常生成 trace 文件。轨迹包含取消前所有已完成的事件，`finish` 事件的 `answer` 字段为取消消息。

## 下一步

- [Fork — Agent 派生](/core/fork) — 沉淀子 Agent 使用的轻量派生机制
- [Skills 渐进式技能](/advanced/skills) — 技能定义和加载机制
- [Reflection 反思](/advanced/reflection) — 执行后反思（错题本 + 记忆提取）
- [Fusion Agent](/core/fusion-agent) — 内置沉淀的 Agent 范式
