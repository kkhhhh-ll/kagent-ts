# Fork — 轻量 Agent 派生

`forkAgent` 是一种**内联派生**机制——创建一个最小化的 ReActAgent 来执行一个独立的子任务，完成后返回结果。它与 [Sub-Agent](/advanced/subagents) 不同：fork 不走 SubAgentManager，不注册，不隔离进程，只是一个轻量的函数调用。

## 为什么用 Fork？

| 特性 | Fork | Sub-Agent |
|---|---|---|
| 启动方式 | 函数调用 `forkAgent()` | SubAgentManager.spawn() |
| 隔离级别 | 无（内联执行） | 独立 Agent 实例 |
| 工具集 | 强制只读白名单 | 可配置 |
| 适用场景 | 轻量后处理 | 复杂子任务 |

Fork 适合**确定性的、小范围的**任务——比如后处理分析、数据提取、格式转换。它不依赖 LLM 决策，由代码控制，确定性强。

## 基本用法

```ts
import { forkAgent } from 'kagent-ts'

const result = await forkAgent('请分析这段代码的复杂度。', {
  llm: myLLMProvider,
  systemPrompt: '你是一个代码审查专家。',
  maxIterations: 5,
})
// result 是 fork agent 的最终回答字符串
```

## 显式传入上下文

Fork **不继承**主 Agent 的对话历史。需要什么上下文，在 `input` 字符串里自己拼好：

```ts
const context = [
  '请审查以下会话，找出问题。',
  '',
  '=== 用户问题 ===',
  userQuery,
  '',
  '=== 最终答案 ===',
  finalAnswer,
  '',
  '=== 完整对话 ===',
  ...conversation.map(m => `[${m.role}] ${m.content}`),
].join('\n')

const findings = await forkAgent(context, {
  llm,
  systemPrompt: '你是审查专家，输出 JSON 格式的分析结果。',
  maxIterations: 4,
})

// 解析 fork 的返回结果
const parsed = JSON.parse(findings)
```

## 配置参数

```ts
interface ForkOptions {
  /** 系统提示词（必填）。 */
  systemPrompt: string
  /** LLM provider（必填）。 */
  llm: LLMProvider
  /**
   * 可用工具。**强制只读白名单**——只允许 `read_file` 和 `grep_search`。
   * 传入写工具（如 `write_file`、`edit_file`、`bash`）会被静默拒绝并写入 warn 日志，
   * 全部被拒时自动 fallback 到默认只读工具。
   */
  tools?: Tool[]
  /** 最大 ReAct 迭代次数（默认 5）。 */
  maxIterations?: number
  /** 阻止自动发现 sub-agent（默认 true）。 */
  preventSubAgents?: boolean
  /** Logger 实例（默认 ConsoleLogger）。 */
  logger?: Logger
  /**
   * 可选 AbortSignal。信号触发时取消正在进行的 LLM 请求，
   * fork 的 ReAct 循环终止，避免浪费 API 配额。
   */
  signal?: AbortSignal
  /**
   * 可选钩子（如 TraceLogger），转发给 fork 内部的 ReActAgent。
   * 不传则 fork 无钩子埋点。
   */
  hooks?: AgentHooks }
```

## 只读白名单安全机制

`forkAgent` 强制实施只读工具白名单。只有 `read_file` 和 `grep_search` 被允许——任何其他工具名都会被拒绝。这不是一个可选的默认值，而是**运行时强制**的安全策略。

**为什么这么严格？**

Fork Agent 的角色是"审查者"而非"执行者"——它验证已有信息，不改变世界：

- **Verification**：检查 Agent 声称的文件路径是否存在
- **Reflection**：验证会话中的错误是否是真实 bug
- **MemoryReflection**：提取关键信息形成记忆条目
- **Precipitation**：分析成功经验，生成 SKILL.md 候选

写入操作（`write_file`、`edit_file`、`bash`）在 fork 中不必要且危险——这是防御 prompt injection 的核心措施：即使攻击载荷成功注入 fork 子 Agent 的 prompt，攻击者也只能读到文件，无法写入或执行命令。

**白名单是如何执行的？**

```ts
const READ_ONLY_TOOL_NAMES = new Set(["read_file", "grep_search"]);

// 当调用方传入自定义 tools 时，按白名单过滤
if (options.tools && options.tools.length > 0) {
  const allowed = [];  // 通过白名单的
  const rejected = []; // 被拒绝的
  for (const t of options.tools) {
    if (READ_ONLY_TOOL_NAMES.has(t.name)) {
      allowed.push(t);
    } else {
      rejected.push(t.name);
    }
  }
  // 被拒绝的 → warn 日志（可观测但不中断）
  // 全部被拒 → fallback 到默认只读工具（不裸奔）
}
```

**三道防线**：

| 防线 | 说明 |
|------|------|
| ① 白名单过滤 | 运行时强制只允许 `read_file` / `grep_search` |
| ② Fork 无写入工具 | 即使绕过白名单，fork 实例也没有注册写工具 |
| ③ 只读约束 | Fork Agent 的 prompt 明确约束为只读角色 |

即使白名单被绕过（如有人伪造了名为 `read_file` 的写工具），防线 ② 和 ③ 仍提供额外保护层。

**可观测性**：被拒绝的工具会写入 `logger.warn` 日志，包含被拒工具名和允许列表。如果所有传入工具均被拒绝，另外输出一条 warn 日志说明已 fallback 到默认只读工具。

## Agent 基类的 fork() 方法

`Agent` 子类可以通过 `this.fork()` 直接派生，自动继承 `this.llm`：

```ts
class MyAgent extends Agent {
  async run(input: string): Promise<string> {
    const answer = await super.someLoop(input)

    // 派生子任务，自动使用 this.llm
    const summary = await this.fork('总结上述问题。', {
      systemPrompt: '你是总结专家。',
      maxIterations: 3,
    })

    return `${answer}\n\n总结：${summary}`
  }
}
```

**注意**：`fork()` 是 `protected` 方法，只能在 `Agent` 子类内部使用。外部用户请使用 `forkAgent()`。

## 超时与取消

通过 `signal` 参数可以设置 fork 的硬超时：

```ts
const abortController = new AbortController();
const timeoutId = setTimeout(() => abortController.abort(), 5 * 60 * 1000); // 5 分钟

try {
  const result = await forkAgent(input, {
    llm,
    systemPrompt: '...',
    signal: abortController.signal,
  });
} finally {
  clearTimeout(timeoutId);
}
```

超时发生后：
- `AbortController.abort()` → `agent.cancel()` → 中止当前 LLM HTTP 请求
- ReAct 循环在下次检查 `isCancelled` 时退出
- `onFinish` 钩子正常触发，TraceLogger 会生成完整的 trace 文件（包含取消前所有事件）

## 钩子透传与 Trace 可视化

传入 `hooks` 的 `TraceLogger` 实例会被 **自动替换为 fork 专用子 trace**（通过 `TraceLogger.wrapHooksForFork()`），fork 内部的事件不会污染主 Agent 时间线。

```ts
const trace = new TraceLogger({ sessionId: 'main' });

// Fork 自动获得独立的子 TraceLogger
const result = await forkAgent(input, {
  llm,
  systemPrompt: '...',
  hooks: [trace],  // ← 自动 wrap 为 fork child trace
});
```

生成的 HTML trace 文件分为三个独立区域：

| 区域 | 内容 | 标记 |
|------|------|------|
| 主 Agent Timeline | 主循环的 LLM/工具调用 | - |
| 🍴 Fork Traces | Fork 子任务的完整时间线 | `kind: "fork"` |
| 🤖 Sub-Agent Traces | 子 Agent 的完整时间线 | `kind: "subagent"` |

Fork 和 Sub-Agent 在 trace HTML 中**分区域展示**，不会混在一起。Fork 标记 `kind: "fork"`，Sub-Agent 标记 `kind: "subagent"`。

## 框架内部使用

Fork 是 Precipitation、Reflection、Memory 三大后台系统的共同基础：

```text
forkAgent()
  ├── PrecipitateAgent.forkAndRun()     → 审查会话 → 提取 SkillCandidate[]
  ├── MemoryReflector.forkAndRun()      → 审查会话 → 输出 ReflectionFinding[]
  └── MemoryReflector.forkAndRun()      → 审查会话 → 提取 Memory[]
```

三个场景的模式完全一致：把对话历史序列化 → 传入 forkAgent → 解析 JSON 返回值 → 持久化。

## 什么时候用 Fork？

✅ **适合**：
- 后处理分析（沉淀技能、反思、记忆提取）
- 数据提取 / 格式转换
- 对一段文本做独立的审查或评分
- 需要一个快速的、确定性的子任务执行

❌ **不适合**：
- 需要完整工具集的复杂任务 → 使用 [Sub-Agent](/advanced/subagents)
- 需要 LLM 自主决策是否 spawn 的场景 → 使用 [Sub-Agent](/advanced/subagents)
- 需要工作区隔离的任务 → 使用 [Sub-Agent](/advanced/subagents) + Git Worktree

## 下一步

- [Sub-Agent 子代理](/advanced/subagents) — 完整的子代理系统
- [生命周期钩子](/core/hooks) — 通过 Hook 注入后台 fork
- [Agent 基类](/core/agent) — fork() 方法的完整说明
