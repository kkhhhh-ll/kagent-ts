# KAgent-TS

一个 TypeScript Agent 框架，提供结构化的 Agent 循环范式、工具管理、会话持久化、子 Agent 调度、反思机制等多方面的能力，帮助开发者快速构建基于 LLM 的应用。

## 特性

- **Agent 循环范式** — `ReActAgent`（思考→行动→观察→最终答案）+ `PlanSolveAgent`（规划→执行→修订→最终答案）
- **多 LLM 后端** — 支持 OpenAI 和 Anthropic，通过 `createLLMProvider()` 工厂函数自动检测后端类型
- **模型路由** — `ModelRouter` 按任务类型路由到不同模型：主循环 → 主力模型，子 Agent → 轻量模型，反思 → 独立模型，每条路由内置灾备链
- **Anthropic Prompt Caching** — 支持对系统提示词启用 Anthropic 的 ephemeral 缓存，降低 token 成本
- **网络韧性** — 自动重试（指数退避 + 抖动），网络错误分类，`LLMNetworkError` 携带 `cause` 字段
- **备选模型切换** — `FallbackProvider` 在主模型网络异常时自动切换到备选 LLM
- **调用频率控制** — `RateLimitedProvider` 基于滑动窗口限制每分钟最大 LLM 调用次数
- **Token 预算** — 会话级别的 Token 消耗追踪与硬上限控制
- **工具系统** — `ToolRegistry` + `CircuitBreaker`（熔断器：连续失败自动禁用）+ 错误追踪链（失败→LLM分析→规则提取→预防）+ 并行执行（同轮独立工具并发调用）
- **工具输出截断** — 超大工具输出自动落盘（`.kagent-context/`），保留摘要 + 按需读取
- **工具过滤器** — 白名单/黑名单/正则匹配，灵活控制子 Agent 可用工具集
- **Human-in-the-Loop** — 危险工具（`requireApproval: true`）执行前回调审批，安全默认拒绝
- **渐进式上下文压缩** — 4 步渐进压缩（大输出截断→旧轮丢弃→过期结果清除→LLM 摘要压缩）
- **会话持久化** — 检查点 & 恢复：自动保存，网络中断后可从断点续跑
- **生命周期钩子** — `AgentHooks`：`onLLMStart` / `onLLMEnd` / `onToolStart` / `onToolEnd` / `onThought` / `onFinish` 等
- **用户偏好** — 纯文本 Markdown 文件（`key: value`），注入系统提示词，文件变化自动重载
- **Skills 渐进式技能** — 按需加载：从 SKILL.md 自动注册技能，匹配关键词自动激活
- **MCP 协议支持** — 接入 Model Context Protocol 服务端，动态发现并注册外部工具
- **子 Agent 调度** — 定义 `AGENT.md`，主 Agent 通过 `spawn_subagent` 工具异步派发任务
- **长期记忆** — 基于文件的持久化记忆系统（`MEMORY.md` 索引 + 独立 markdown 文件）
- **项目规则** — 用户自定义规则文件（`RULES.md`），始终注入系统提示词
- **反思 & 错题本** — `ReflectionAgent` 执行后自检 + `ErrorNotebook` 持久化错误记录，支持独立模型审查
- **结构化输出** — LLM 以 JSON 格式返回思考与答案，解析可靠、无自由文本歧义
- **执行追踪** — `TraceLogger` 记录 LLM 调用、工具执行、思考过程的完整事件时间线
- **内置工具** — `ReadFile`、`WriteFile`、`EditFile`、`GrepSearch`、`GlobSearch`、`Bash`、`WebFetch` 等

## 安装

```bash
npm install kagent-ts
```

## 快速开始

```typescript
import { ReActAgent, createLLMProvider, Tool } from "kagent-ts";

// 1. 创建 LLM Provider（自动检测 OpenAI / Anthropic）
const llm = createLLMProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
});

// 2. 定义一个工具
const calculator: Tool = {
  name: "calculator",
  description: "执行数学运算",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "要计算的数学表达式",
      },
    },
    required: ["expression"],
  },
  async execute(args) {
    const { expression } = args as { expression: string };
    return String(eval(expression));
  },
};

// 3. 创建 Agent
const agent = new ReActAgent({ llm, tools: [calculator] });

// 4. 运行
const response = await agent.run("25 * 4 + 10 是多少？");
console.log(response);
```

## 项目架构

```text
src/
├── core/                  # Agent 基类、ReActAgent、PlanSolveAgent
│   ├── agent.ts           # 抽象基类（共享基础设施）
│   ├── react-agent.ts     # 思考→行动→观察 循环
│   ├── plan-solve-agent.ts# 规划→执行→修订 循环
│   ├── types.ts           # Tool 等核心类型
│   ├── hooks.ts           # 生命周期钩子接口
│   ├── response-schema.ts # 结构化 JSON 输出解析
│   └── system-prompts.ts  # 系统提示词片段
├── llm/                   # LLM Provider 接口与实现
│   ├── interface.ts       # LLMProvider 通用接口
│   ├── openai-provider.ts # OpenAI 实现（含重试）
│   ├── anthropic-provider.ts # Anthropic 实现（含 prompt caching）
│   ├── factory.ts         # createLLMProvider 工厂函数
│   ├── model-router.ts    # 模型路由器（按任务类型分发）
│   ├── fallback-provider.ts # 备选模型自动切换
│   ├── rate-limiter.ts    # 滑动窗口频率控制
│   ├── token-budget.ts    # 会话级 Token 预算
│   ├── retry.ts           # 通用重试逻辑
│   └── errors.ts          # 网络错误分类
├── messages/              # 消息类型与构造器
├── context/               # 上下文窗口管理（Token 追踪）
├── compression/           # 渐进式 4 步压缩策略
├── session/               # 会话检查点持久化 & 恢复
├── preferences/           # 用户偏好（Markdown 文件，自动重载）
├── skills/                # 渐进式 Skill 系统（SKILL.md）
├── subagent/              # 子 Agent 定义、加载、调度
├── mcp/                   # MCP 协议客户端管理
├── memory/                # 长期记忆（MEMORY.md + 独立文件）
├── rules/                 # 项目规则加载
├── reflection/            # 反思 Agent + 错题本（ErrorNotebook）
├── tools/                 # 工具注册表、熔断器、错误追踪
│   ├── builtin/           # 内置工具集
│   ├── circuit-breaker.ts # 熔断器
│   ├── tool-registry.ts   # 工具注册表
│   ├── error-tracker.ts   # 工具错误链追踪
│   ├── tool-output-truncator.ts # 大输出截断落盘
│   └── tool-filter.ts     # 工具过滤器
├── eval/                   # Agent 评估体系
│   ├── types.ts             # 共享评估类型
│   ├── tool-call-evaluator.ts # 工具调用指标收集（AgentHooks）
│   ├── eval-runner.ts       # 端到端评估 + LLM 评判
│   ├── benchmark.ts         # 回归测试 & 基线对比
│   └── index.ts             # 统一导出
├── trace/                 # 执行追踪事件日志
├── logging/               # 结构化日志接口
├── utils/                 # Token 计数等工具函数
└── index.ts               # 公共 API 导出
```

```

## Agent 循环范式

### ReActAgent

经典的思考 → 行动 → 观察 循环，带有工具调用支持：

```typescript
import { ReActAgent } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  tools: [myTool],
  systemPrompt: "你是一个有用的助手。",
  maxIterations: 10,
});

const response = await agent.run("搜索最新的新闻。");
```

### PlanSolveAgent

规划 → 执行 → 修订 循环，适合复杂的多步骤任务：

```typescript
import { PlanSolveAgent } from "kagent-ts";

const agent = new PlanSolveAgent({
  llm,
  tools: [searchTool, calculatorTool],
  maxIterations: 15,
  maxPlanSteps: 12,
  replanThreshold: 2,   // 连续失败 2 次后自动建议调整计划
});

const response = await agent.run("分析 Q3 财务数据并生成报告。");
```

Agent 将会：

1. 制定详细计划
2. 使用工具逐步执行
3. 遇到障碍时中途修订计划
4. 输出最终答案

## LLM 后端

### 工厂函数（推荐）

使用 `createLLMProvider()` 自动检测后端类型：

```typescript
import { createLLMProvider } from "kagent-ts";

// 自动检测：baseURL 含 "anthropic" → AnthropicProvider，否则 → OpenAIProvider
const llm = createLLMProvider({
  apiKey: process.env.API_KEY!,
  model: "claude-sonnet-4-6",
  baseURL: "https://api.anthropic.com",
});

// 显式指定后端
const llm2 = createLLMProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
  provider: "openai",
});
```

### OpenAI Provider

```typescript
import { OpenAIProvider } from "kagent-ts";

const llm = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
  retry: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
});
```

- **可重试错误**：超时、连接拒绝/重置、DNS 失败、HTTP 429（限流）、HTTP 5xx（服务端错误）
- **立即传播错误**：HTTP 401（鉴权）、HTTP 400（请求错误）、abort 信号
- 重试耗尽后抛出 `LLMNetworkError`，`cause` 字段标识具体原因

### Anthropic Provider

完整的 Anthropic SDK 集成，支持消息格式自动转换和 Prompt Caching：

```typescript
import { AnthropicProvider } from "kagent-ts";

const llm = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-sonnet-4-6",
  cacheSystemPrompt: true,  // 启用 Prompt Caching（适合静态系统提示词）
});
```

- 自动将 OpenAI 兼容的 `MessageData[]` 格式转换为 Anthropic 原生格式
- 支持 Claude 4.x 系列模型的 extended thinking（thinking 块合并到 content）
- 暂不支持流式中断重连（由 Agent 外层循环处理）

### 备选模型切换（FallbackProvider）

主模型网络异常时自动切换到备选模型：

```typescript
import { FallbackProvider, OpenAIProvider, AnthropicProvider } from "kagent-ts";

const llm = new FallbackProvider({
  primary: new OpenAIProvider({ apiKey: "...", model: "gpt-4o" }),
  fallbacks: [
    new AnthropicProvider({ apiKey: "...", model: "claude-haiku-4-5-20251001" }),
    new OpenAIProvider({ apiKey: "...", model: "gpt-4o-mini" }),
  ],
});
```

- 按顺序尝试，首个成功即返回
- 非网络错误（鉴权、请求格式）立即传播，不切换

### 调用频率控制（RateLimitedProvider）

基于滑动窗口限制每分钟最大调用次数，防止触发服务端限流（HTTP 429）：

```typescript
import { RateLimitedProvider } from "kagent-ts";

const llm = new RateLimitedProvider({
  provider: new OpenAIProvider({ ... }),
  maxCallsPerMinute: 500,
});
```

### 模型路由（ModelRouter）

按任务类型将 LLM 调用路由到不同模型，避免所有决策都压在主力模型上：

```typescript
import { ModelRouter, OpenAIProvider, AnthropicProvider } from "kagent-ts";

const router = new ModelRouter({
  // 主力模型 — 复杂推理
  main: new OpenAIProvider({ apiKey: "...", model: "gpt-4o" }),

  // 子 Agent — 降本用轻量模型
  subAgent: new OpenAIProvider({ apiKey: "...", model: "gpt-4o-mini" }),

  // 反思 QA — 换独立模型，避免"自审自"
  reflection: new AnthropicProvider({ apiKey: "...", model: "claude-haiku-4-5-20251001" }),

  // 轻量任务 — 记忆操作、错误列表等
  lightweight: new OpenAIProvider({ apiKey: "...", model: "gpt-4o-mini" }),

  // 共享灾备链 — 每条路由自动继承
  fallbacks: [new AnthropicProvider({ apiKey: "...", model: "claude-sonnet-4-6" })],
});

// 直接当 LLMProvider 用 — Agent 自动检测并提取各路由
const agent = new ReActAgent({
  llm: router,                   // 主循环自动用 gpt-4o
  subAgentsDir: "./subagents",   // 子 Agent 自动用 gpt-4o-mini
});

// 反思钩子 — 显式指定独立模型
const hook = createReflectionHook({
  llm: router.forReflection(),   // haiku 独立审查
  notebook: errorNotebook,
});
```

**路由优先级**：`forSubAgent()` / `forReflection()` / `forLightweight()` 各自返回配置的模型，未配置时回退到 `main`。每条路由自动包裹灾备链（`fallbacks`）。

**Agent 自动检测**：当 `llm` 是 `ModelRouter` 时，Agent 构造器自动调用 `router.forSubAgent()` 为子 Agent 分配模型。也可通过 `subAgentLLM` 显式覆盖。

### Token 预算

会话级别的 Token 消耗控制，超出预算自动停止 LLM 调用：

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  tokenBudgetConfig: {
    maxTotalTokens: 200_000,     // 会话总 Token 上限
    warnAtPercent: 80,           // 80% 时警告
  },
});

// 查询当前消耗
const cost = agent.getSessionCost();
console.log(cost);  // { totalTokens: 150000, callCount: 12, ... }
```

## 工具系统

### ToolRegistry + Circuit Breaker（熔断器）

工具注册时自动接入失败检测与熔断保护：

```typescript
import { ToolRegistry } from "kagent-ts";

const registry = new ToolRegistry(
  2,  // 最多重试 2 次（共 3 次尝试）
  errorTracker,
  truncator,
);

registry.register(calculatorTool);
const result = await registry.execute("calculator", { expression: "2+2" });
```

熔断状态机：`CLOSED`（正常）→ `OPEN`（禁用）→ `HALF_OPEN`（试探）→ `CLOSED`（恢复）。

### 工具错误追踪

记录完整的工具失败生命周期，自动捕获 LLM 分析并提取预防规则：

```text
工具执行失败 → recordFailure() 创建跟踪链
    ↓
LLM 看到错误 → thought 自动捕获为 recordAnalysis()
    ↓
工具恢复成功 → recordRecovery() 标记解决 + extractRuleFromTrace() 提取规则
    ↓
规则注入 → buildRulesPrompt() 注入 system prompt，防止下次再犯
```

```typescript
// 启用错误追踪
import { ToolErrorTracker } from "kagent-ts";

const tracker = new ToolErrorTracker({ storageDir: ".error-traces" });
const registry = new ToolRegistry(2, tracker);

// 或通过 Agent 配置
const agent = new ReActAgent({
  llm,
  toolRegistry: registry,
});

// 生成 Markdown 报告（含完整失败链 + LLM 分析 + 规则）
const report = agent.generateErrorReport();

// LLM 也可通过内置工具查询错误记录
// → 调用 list_errors 工具，过滤特定工具或只看未解决错误
```

### 工具输出截断

超大工具输出自动截断落盘（`.kagent-context/`），上下文保留 2KB 摘要，完整内容按需读取：

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  toolOutputMaxBytes: 50 * 1024,  // 超过 50KB 自动截断
});
```

### 工具过滤器

限制子 Agent 可使用的工具范围：

```typescript
import { allowlist, denylist, pattern, filterTools } from "kagent-ts";

// 白名单：只允许特定工具
const filter = allowlist(["read_file", "grep_search"]);

// 黑名单：排除危险工具
const filter2 = denylist(["write_file", "bash"]);

// 正则匹配
const filter3 = pattern(/^(read|grep|glob)/);
```

### Human-in-the-Loop 审批

标记 `requireApproval: true` 的工具在执行前会触发审批回调：

```typescript
const dangerousTool: Tool = {
  name: "delete_file",
  description: "删除文件",
  requireApproval: true,  // 需要人工审批
  // ...
};

const agent = new ReActAgent({
  llm,
  tools: [dangerousTool],
  onToolApproval: async (toolName, args) => {
    // 展示给用户，等待确认
    return confirm(`确认执行 ${toolName}？参数：${JSON.stringify(args)}`);
  },
});
```

未配置 `onToolApproval` 时，所有需审批的工具默认被**拒绝**（安全默认值）。

### 并行工具执行

同一轮 LLM 响应中的多个工具调用默认**并行执行**，延迟从 `sum(各工具耗时)` 降为 `max(各工具耗时)`：

```typescript
// 默认开启——LLM 同时调用 read_file A、read_file B、grep C
// → 三个工具并发执行，总耗时 = max(200ms, 300ms, 150ms) = 300ms
// → 串行模式下总耗时 = 200ms + 300ms + 150ms = 650ms

const agent = new ReActAgent({ llm, tools });  // 默认并行
```

**关闭并行**（回退串行）：

```typescript
const agent = new ReActAgent({
  llm,
  tools,
  enableParallelToolExecution: false,  // 恢复旧行为
});
```

**标记工具为串行**（有副作用、不可并发的工具）：

```typescript
const writeAndRead: Tool = {
  name: "atomic_write_read",
  description: "写入后立即校验",
  sequential: true,  // 始终串行执行，不与其他工具并发
  // ...
};
```

当同一轮 LLM 响应中任一工具标记了 `sequential: true`，整批工具回退为串行执行。

**设计原理**：LLM 在同一轮 response 中发出的多个 `tool_calls` 本质上是彼此独立的（LLM 发出时还未看到任何工具结果），因此可以安全并行。有依赖关系的调用自然会跨轮次发生。

### 内置工具

```typescript
import { registerAllBuiltinTools } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  tools: [...registerAllBuiltinTools()],
});
```

| 工具 | 说明 |
| ---- | ---- |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `edit_file` | 精确字符串替换编辑 |
| `grep_search` | 正则内容搜索（基于 ripgrep） |
| `glob_search` | 文件模式匹配 |
| `bash` | 执行 Shell 命令 |
| `web_fetch` | 获取 URL 内容并转为 Markdown |
| `skill` | LLM 驱动的 Skill 激活 |
| `remember` | 写入长期记忆 |
| `recall` | 检索长期记忆 |
| `list_subagents` | 列出可用子 Agent |
| `spawn_subagent` | 派发子 Agent 任务 |
| `list_errors` | 列出工具错误追踪记录 |

## 会话持久化

Agent 可在运行中保存检查点，断网后恢复：

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  sessionId: "my-session",
  enableCheckpointing: true,
});

// 正常执行 — 每轮 LLM+tools 后自动保存检查点
const result = await agent.run("做某某任务...");

// 网络中断时：保存 "interrupted" 检查点并返回恢复指引
// 网络恢复后：
const resumed = await agent.resume("my-session", "继续之前的任务");
```

用户主动取消（SIGINT / `agent.cancel()`）时检查点会被丢弃，不残留过期状态。

### 会话生命周期

```typescript
// 清空当前对话，保留系统提示词和配置
agent.clearConversation();

// 多轮对话续接（保留历史消息）
const reply = await agent.chat("上一个结果能详细说明吗？");

// 开启新话题（自动清除历史 + 重置 Token 预算）
const reply2 = await agent.newTopic("帮我分析另一个问题");

// 获取会话 Token 消耗
const cost = agent.getSessionCost();

// 完全重置到初始状态
agent.reset();
```

## 上下文管理 & 渐进式压缩

自动 Token 追踪 + 4 步渐进式压缩：

```typescript
import { ContextManager, ProgressiveCompressor } from "kagent-ts";

const ctx = new ContextManager({
  maxTokens: 128000,
  compressionThresholdRatio: 0.75,  // 达到 75% 时触发压缩
});

// 4 步渐进压缩：
// Step 1: 截断超大工具结果（>200KB → 保留 2KB，落盘）
// Step 2: 丢弃 keepTurns 之前的旧对话轮次
// Step 3: 清除过期的"读取型"工具结果（可重新执行获取）
// Step 4: LLM 全对话摘要压缩（最终手段）
```

## 用户偏好

偏好以 Markdown 文件（默认 `.kagent/preferences.md`）存储，注入到系统提示词中作为 `=== User Preferences ===` 段落。每次运行前自动检测文件变更。

```markdown
# 用户偏好

codeStyle: 使用 TypeScript 函数式风格，优先使用 interface。
language: 始终使用中文回复。
forbidden: 禁止使用 `any` 类型。避免修改函数参数。
```

```typescript
// 通过构造函数设置
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  preferences: {
    codeStyle: "使用 TypeScript 函数式风格。",
    language: "始终使用中文回复。",
  },
});

// 文件持久化
import { PreferenceManager } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  tools: [myTool],
  preferenceManager: new PreferenceManager(),
});

// 运行时 CRUD（配置了 PreferenceManager 则自动持久化）
agent.setPreference("codeStyle", "使用函数式风格。");
agent.getPreference("language");   // "始终使用中文回复。"
agent.removePreference("forbidden");
agent.clearPreferences();
```

## Skills（渐进式技能）

Skills 以文件目录形式定义，提供领域知识和工具，按需加载：

```
skills/
├── sql/
│   ├── SKILL.md              # Frontmatter（元数据）+ 系统提示词正文
│   ├── reference/            # 激活时加载的参考文档
│   │   └── cheatsheet.md
│   └── scripts/              # 作为工具注册的可执行脚本
│       └── format_sql.sh
├── git/
│   ├── SKILL.md
│   └── scripts/
│       └── list_branches.sh
└── ...
```

### SKILL.md 格式

```markdown
---
name: sql
description: SQL 查询编写与优化
keywords: sql, query, database, select, join
---

你是一位 SQL 专家。编写高效查询，合理使用索引，关注 EXPLAIN 计划。
```

### 使用方式

```typescript
const agent = new ReActAgent({
  llm,
  tools: myTools,
  skillsDir: "./skills",  // 自动发现文件式 Skill
});

// 手动激活
agent.activateSkill("sql");

// 或依赖自动检测：用户输入匹配关键词时自动激活
const response = await agent.run("帮我写一个查询前10名客户的 SQL");
```

### Skill 组成

| 组件 | 位置 | 行为 |
| ---- | ---- | ---- |
| **元数据** | SKILL.md frontmatter (`---`) | 扫描时注册 — name、description、keywords |
| **系统提示词** | SKILL.md 正文 | 激活时加载 — 注入 Agent 系统提示词 |
| **参考文档** | `reference/*.md`、`*.txt` | 激活时追加到系统提示词，带 `[Reference: 文件名]` 标题 |
| **脚本** | `scripts/*.sh`、`.py`、`.js`、`.bat` | 激活时注册为可执行 `Tool`，命名格式 `{skillName}_{scriptName}` |

## MCP（Model Context Protocol）

接入 MCP 服务端，动态发现并注册外部工具：

```typescript
const agent = new ReActAgent({
  llm,
  tools: myTools,
  mcpServers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
    weather: {
      url: "http://localhost:3001/sse",
    },
  },
});
// 连接在 agent.run() 时异步建立
// 工具自动注册，命名格式：{serverName}_{toolName}
```

## 子 Agent 调度

通过 `AGENT.md` 定义子 Agent，主 Agent 使用 `spawn_subagent` 工具异步派发任务：

```
subagents/
├── code-reviewer/
│   └── AGENT.md              # Frontmatter (name, description, tools, skills) + 系统提示词
└── researcher/
    └── AGENT.md
```

### AGENT.md 格式

```markdown
---
name: code-reviewer
description: 代码审查专家，检查代码质量和潜在 Bug
tools: [read_file, grep_search, glob_search]
skills: []
---

你是一位资深的代码审查专家。仔细审查代码，关注：
1. 潜在的 Bug 和边界情况
2. 性能优化机会
3. 代码风格和可读性
```

### 使用子 Agent

```typescript
import { ReActAgent, ModelRouter, OpenAIProvider } from "kagent-ts";

// 模型路由：子 Agent 自动使用轻量模型降本
const router = new ModelRouter({
  main: new OpenAIProvider({ model: "gpt-4o" }),
  subAgent: new OpenAIProvider({ model: "gpt-4o-mini" }),
});

const agent = new ReActAgent({
  llm: router,                  // 主 Agent 用 gpt-4o，子 Agent 自动用 gpt-4o-mini
  tools: [myTools],
  subAgentsDir: "./subagents",
  skillsDir: "./skills",
});

// 也可用 subAgentLLM 显式覆盖（优先级高于 ModelRouter）
const agent2 = new ReActAgent({
  llm: new OpenAIProvider({ model: "gpt-4o" }),
  subAgentLLM: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
  subAgentsDir: "./subagents",
});

// 主 Agent 会自动注册 spawn_subagent 和 list_subagents 工具
// LLM 可以在推理过程中自主决定派发子 Agent 执行子任务
```

子 Agent 异步运行，结果在后续 ReAct 迭代中自动注入上下文。

## 长期记忆

基于文件的持久化记忆系统，跨会话保存：

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTools],
  memoryDir: ".memory",
});

// LLM 可通过 remember 工具写入记忆
// LLM 可通过 recall 工具检索记忆
// 记忆以 MEMORY.md 索引 + 独立 markdown 文件存储
```

## 项目规则

用户自定义规则文件，始终注入系统提示词，每次运行前自动检测变更：

```markdown
# RULES.md 示例
- 始终使用 TypeScript strict 模式
- 优先使用 interface 而非 type
- 禁止使用 any 类型
```

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTools],
  rulesPath: "RULES.md",
});
```

## 反思 & 错题本

### ReflectionAgent

Agent 执行完毕后，`ReflectionAgent` 回顾完整会话，识别推理错误、工具误用、遗漏等问题：

```typescript
import { ReflectionAgent, ErrorNotebook } from "kagent-ts";

const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });
const reflector = new ReflectionAgent({ llm, notebook, maxIterations: 3 });

const findings = await reflector.reflect({
  userQuery: input,
  finalAnswer: answer,
  conversation: contextMessages,
  errorTraces: errorTraces,
  sessionId: "sess_123",
});
```

### ErrorNotebook（错题本）

持久化错误记录，供后续 Agent 运行参考，形成学习闭环：

```typescript
const notebook = new ErrorNotebook({ storageDir: ".error-notebook" });

// 条目类别：reasoning_error | tool_misuse | missed_optimization |
//           incomplete_answer | hallucination | context_mismanagement | other
```

### 生命周期钩子

```typescript
import { createReflectionHook, ModelRouter } from "kagent-ts";

// 使用 ModelRouter 时，反思可指定独立模型避免"自审自"
const router = new ModelRouter({
  main: new OpenAIProvider({ model: "gpt-4o" }),
  reflection: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
});

const hook = createReflectionHook({
  llm: router.forReflection(),  // 独立模型审查
  notebook: errorNotebook,
});

const agent = new ReActAgent({
  llm: router,
  tools: [myTool],
  hooks: [hook],  // 每次 run() 结束后自动触发反思
});
```

## 生命周期钩子（AgentHooks）

观察 Agent 执行的各个环节：

```typescript
const hooks: AgentHooks = {
  onLLMStart: (messages, tools) => { /* LLM 调用开始 */ },
  onLLMEnd: (response) => { /* LLM 调用结束 */ },
  onLLMError: (error) => { /* LLM 调用出错 */ },
  onToolStart: (name, args, toolCallId?) => { /* 工具开始执行 */ },
  onToolEnd: (name, output, toolCallId?) => { /* 工具执行成功 */ },
  onToolError: (name, error, toolCallId?) => { /* 工具执行失败 */ },
  onThought: (thought) => { /* Agent 思考内容 */ },
  onFinish: (answer) => { /* Agent 产生最终答案 */ },
};

const agent = new ReActAgent({
  llm,
  tools: [myTool],
  hooks,  // 单个或数组
});
```

## 执行追踪（TraceLogger）

记录 Agent 执行过程的完整事件时间线：

```typescript
import { TraceLogger } from "kagent-ts";

const traceLogger = new TraceLogger({ outputDir: ".kagent-traces" });

// 事件类型：llm_start | llm_end | llm_error | tool_start | tool_end |
//          tool_error | thought | plan_created | plan_revised | finish
```

## 结构化输出

LLM 以结构化 JSON 格式返回思考内容和最终答案，解析可靠：

```typescript
import { parseReActResponse, parsePlanSolveResponse } from "kagent-ts";

// ReAct 输出格式：
// { "thought": "...", "answer": "..." }      ← 最终答案
// { "thought": "..." }                        ← 中间思考（继续循环）

// PlanSolve 输出格式：
// { "phase": "plan", "plan": [...] }
// { "phase": "resolve", "current_step": "...", "done": false }
// { "phase": "resolve", "current_step": "...", "done": true, "final_answer": "..." }
```

## 消息 API

```typescript
import { Message } from "kagent-ts";

Message.user("你好");
Message.system("你是一个有用的助手。");
Message.assistant("你好！有什么可以帮你的？");
Message.tool("结果内容", "call_123", "calculator");

msg.toDict();      // { role: "user", content: "你好" }
msg.toJSON();      // JSON 字符串
Message.fromJSON(json);          // 反序列化
Message.fromJSONBulk(array);     // 批量反序列化
```

## 日志

框架内部日志通过 `Logger` 接口输出，默认使用 `ConsoleLogger`（带 `[Tag]` 前缀），可替换为 `SilentLogger` 完全静默：

```typescript
import { ConsoleLogger, SilentLogger } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  logger: new SilentLogger(),  // 静默模式
});
```

## Agent 评估

框架提供三层评估体系，从工具调用指标到端到端回归测试：

```text
ToolCallEvaluator  →  工具级：成功率 / 延迟 / 错误分布 / 熔断统计
EvalRunner         →  用例级：工具调用检查 + 输出匹配 + LLM 评判
Benchmark          →  回归级：基线对比 + 退化检测 + 改进标记
```

### 1. 工具调用指标（ToolCallEvaluator）

挂载到 `AgentHooks`，自动收集每次工具调用的指标：

```typescript
import { ToolCallEvaluator } from "kagent-ts";

const evaluator = new ToolCallEvaluator();
const agent = new ReActAgent({ llm, hooks: [evaluator] });

await agent.run("帮我计算 2+2");

// 聚合指标
const scorecard = evaluator.getScorecard();
// {
//   totalCalls: 3, overallSuccessRate: 1.0, avgLatencyMs: 120,
//   circuitBreakerTrips: 0, uniqueToolsUsed: 2,
//   perTool: [{ toolName: "calculator", successRate: 1.0, p50LatencyMs: 100, ... }]
// }

// Markdown 报告
console.log(evaluator.generateReport());
```

报告示例：

```text
# Tool Call Evaluation Report

## Summary
| Total Calls | Success Rate | Avg Latency | Circuit Breaker Trips |
|-------------|-------------|-------------|----------------------|
| 3           | 100%        | 120ms       | 0                    |

## Per-Tool Breakdown
| Tool | Calls | Success Rate | Avg Latency | P50 | P99 | Avg Retries | CB Trips |
|------|-------|-------------|-------------|-----|-----|-------------|----------|
| `calculator` | 2 | 100% | 100ms | 98ms | 102ms | 0.0 | 0 |
| `read_file`  | 1 | 100% | 160ms | 160ms | 160ms | 0.0 | 0 |
```

### 2. 端到端评估（EvalRunner）

用测试用例集跑 Agent，检查工具调用正确性 + 输出匹配 + 可选的 LLM 独立评判：

```typescript
import { EvalRunner, ModelRouter } from "kagent-ts";

const router = new ModelRouter({
  main: new OpenAIProvider({ model: "gpt-4o" }),
  reflection: new AnthropicProvider({ model: "claude-haiku-4-5-20251001" }),
});

const runner = new EvalRunner({
  judgeLLM: router.forReflection(),  // 独立模型评判，避免"自审自"
});

const results = await runner.run(
  // Agent 工厂 — 每个用例创建全新实例，避免上下文污染
  (evaluator) => new ReActAgent({ llm: router, hooks: [evaluator] }),
  [
    {
      name: "basic math",
      input: "2+2=?",
      expectedTools: ["calculator"],           // 必须调用这些工具
      forbiddenTools: ["bash", "write_file"],   // 绝不能调用这些
      expectedOutput: /4/,                      // 答案必须匹配
    },
    {
      name: "readme exists",
      input: "读取 README.md 的前 10 行",
      expectedTools: ["read_file"],
      timeoutMs: 30_000,                        // 超时覆盖
    },
  ],
);

// 报告
console.log(runner.generateReport(results));
```

### 3. 回归测试（Benchmark）

对比两次运行的基线，自动标记退化和改进，结果持久化到磁盘：

```typescript
import { Benchmark } from "kagent-ts";

const benchmark = new Benchmark({
  name: "tool-calling-v2",
  agentFactory: (evaluator) => new ReActAgent({ llm, hooks: [evaluator] }),
  cases: myEvalCases,
  baselinePath: ".kagent-benchmarks/tool-calling-v1.json",  // 上次的基线
});

const result = await benchmark.run();
console.log(benchmark.generateReport(result));
```

```text
# Benchmark: tool-calling-v2

## ⚠️ Regressions
| Target | Metric | Baseline | Current | Details |
|--------|--------|----------|---------|---------|
| overall | passRate | 95.0% | 82.0% | Pass rate dropped by 13.0 percentage points. |
| complex_query | passed | true | false | Went from PASS to FAIL. Failures: ... |

## 📈 Improvements
| Target | Metric | Baseline | Current |
|--------|--------|----------|--------|
| overall | avgLatencyMs | 520ms | 340ms |
```

每次运行结果自动保存到 `.kagent-benchmarks/`，下次跑时可直接当基线用。

### 测试 Mock

测试 Agent 行为无需真实 API 调用。框架提供了共享的 Mock LLM Provider 工厂：

```typescript
import {
  mockAnswerLLM,    // 直接返回最终答案
  mockToolCallLLM,  // 返回工具调用
  mockSequenceLLM,  // 多轮序列响应
  answerContent,    // 预设的"最终答案"JSON content
  toolCallContent,  // 预设的"工具调用"JSON content
} from "./tests/mocks/mock-llm-provider";

// 模拟"调用工具 → 得到结果 → 回答"的多轮交互
const llm = mockSequenceLLM([
  [toolCallContent("calculator"), [{
    id: "c1", type: "function",
    function: { name: "calculator", arguments: '{"expr":"2+2"}' },
  }]],
  [answerContent("结果是 4")],
]);

const agent = new ReActAgent({ llm, maxIterations: 3 });
const result = await agent.run("2+2=?");
expect(result).toContain("4");
```

## 运行测试

```bash
npm test
```

## License

MIT
