# Fork — 轻量 Agent 派生

`forkAgent` 是一种**内联派生**机制——创建一个最小化的 ReActAgent 来执行一个独立的子任务，完成后返回结果。它与 [Sub-Agent](/advanced/subagents) 不同：fork 不走 SubAgentManager，不注册，不隔离进程，只是一个轻量的函数调用。

## 为什么用 Fork？

| | Fork | Sub-Agent |
|---|---|---|
| 触发方式 | 代码直接调用 | LLM 通过 `Task` 工具动态 spawn |
| 定义位置 | 代码内 | `./subagents/` 目录 |
| 上下文 | 调用方显式传入（prompt 字符串） | 继承主 Agent 上下文 |
| 工具 | 默认只读（`read_file` + `grep_search`），可自定义 | 完整工具集 |
| 隔离 | 无（共享进程） | 可选 worktree 隔离 |
| 开销 | 极低（一个函数调用） | 较高（spawn + 管理） |

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
  /** 可用工具。默认 read_file + grep_search。 */
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
  hooks?: AgentHooks | AgentHooks[]
}
```

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

| 区域 | 图标 | 内容 |
|------|------|------|
| 主 Agent 时间线 | 📤📥 | Thought、LLM 调用、工具调用、Final Answer |
| 🔀 Fork Agents | 🔀 | Precipitation / Reflection / Memory 等 fork 的内部轨迹 |
| 🤖 Sub-Agents | 🤖 | `spawn_subagent` 工具派生的子 Agent 轨迹 |

Fork 和 Sub-Agent 在 trace HTML 中**分区域展示**，不会混在一起。Fork 标记 `kind: "fork"`，Sub-Agent 标记 `kind: "subagent"`。

## 框架内部使用

Fork 是 Precipitation、Reflection、Memory 三大后台系统的共同基础：

```text
forkAgent()
  ├── PrecipitateAgent.forkAndRun()     → 审查会话 → 提取 SkillCandidate[]
  ├── ReflectionAgent.forkAndRun()      → 审查会话 → 输出 ReflectionFinding[]
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
