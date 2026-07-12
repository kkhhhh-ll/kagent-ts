# Intent Recognition 意图识别

Intent Recognition 系统在 Agent 执行前对用户输入做**零 LLM 开销**的信号检测和关键词匹配，决定两件事：**后处理要不要触发**（Precipitation、MemoryReflection）以及**哪些 Skill 应该提前激活**。

## 为什么需要？

Agent 框架有三种行为控制方式：

| 方式 | 开销 | 适用场景 |
|------|------|---------|
| **LLM 自主决策** | 高（Token + 延迟） | "这个任务需要什么工具？" |
| **配置开关** | 零 | "始终 / 永不触发沉淀" |
| **意图识别** | 零（纯本地正则/字符串） | "用户说'记住'→ 立刻触发沉淀" |

配置开关是死的（mode: "off" → 永不触发），LLM 决策是贵的（每次都要消耗 Token 和等待 LLM 响应）。意图识别填补了中间地带——**当用户输入已经包含了明确信号时，零成本做出反应**。

## 架构

```text
用户输入 → Agent.run()
  ├── 1. detectInputSignals(input)    ← 正则匹配（< 1ms）
  │     ├── wantsRemember → 强制触发 Precipitation + MemoryReflection
  │     └── hasRiskyOps   → FusionAgent planConfirmation 使用
  │
  ├── 2. matchInputSkills(input)      ← 关键词/名字匹配（< 1ms）
  │     ├── 命中 Skill → activate → rebuildSystemPrompt → LLM 即刻可见
  │     └── 未命中 → LLM 仍可通过 `skill` 工具手动激活
  │
  └── 3. LLM 自主决策                  ← Token 开销
        ├── 看到 auto-activated skills 已在 System Prompt 中
        ├── 看到 available skills → 调用 `skill` 工具
        └── 看到 available subagents → 调用 `spawn_subagent` 工具
```

全部在 Agent 基类中完成，三个 Agent 类型（ReAct / PlanSolve / Fusion）行为一致。

## 信号检测

### 信号类型

```ts
interface UserSignals {
  wantsRemember: boolean   // 用户明确要求记住/保存
  hasRiskyOps: boolean     // 输入包含破坏性操作关键词
}
```

### 触发规则

| 信号 | 匹配模式 | 效果 |
|------|---------|------|
| `wantsRemember` | `remember` / `save this` / `记住` / `保存` / `記住` / `儲存` / `记录下来` | 直接覆盖 mode 配置，强制触发 Precipitation 和 MemoryReflection |
| `hasRiskyOps` | `deploy` / `delete` / `drop` / `migrate` / `truncate` / `destroy` / `purge` / `reset` / `format` / `rm -rf` | FusionAgent `planConfirmation: "auto"` 时请求用户审批 |

### wantsRemember vs mode 配置

关键设计：用户说"记住"时，**无视** `precipitation` 和 `memoryReflection` 的 mode 配置：

```ts
// 不管 mode 是 "off" 还是 "post-hoc"，用户显式表态就执行
if (this.inputSignals.wantsRemember) {
  shouldPrecipitate = true;
  shouldReflectMemory = true;
}
```

| mode | 无信号 | wantsRemember |
|------|--------|---------------|
| `"off"` | ❌ | ✅ 强制执行 |
| `"post-hoc"` | ✅ 每次执行 | ✅ 强制执行（冗余但不影响） |

### hard-won success（踩坑后成功）

当 Agent 连续失败 ≥ 2 次后最终成功时，框架自动触发 Precipitation（保存来之不易的解决方案）。MemoryReflection 不受此条件触发——记忆提取与工具失败无关。

## Skill 关键词匹配

### 匹配规则

两阶段匹配，均在 LLM 调用前完成：

**阶段 1：名字匹配**。将 Skill 名拆分为 token（按 `-` / `_` / 空格），所有 token 都必须以**完整词**形式出现在输入中。

```
Skill: "code-reviewer" → tokens: ["code", "reviewer"]
输入: "帮我审查代码" → "reviewer" 不在输入中 → 不匹配
输入: "code review please" → 两个 token 都在 → 匹配 ✅
```

**阶段 2：关键词匹配**。Skill 的 `keywords` 数组中任意一个关键词以完整词形式出现在输入中 → 匹配。

```
Skill: { name: "deploy-to-prod", keywords: ["deploy", "release", "production"] }
输入: "部署到生产环境" → "production" 没有精确命中，"deploy" 和 "release" 也没有 → 不匹配
输入: "deploy to production" → "deploy" 命中 ✅
```

### 词边界保护

单字关键词使用正则词边界匹配，避免假阳性：

```
关键词: "code"
输入: "unicode support" → "code" 不是独立词（在 "unicode" 中）→ 不匹配 ✅
输入: "review this code" → "code" 是独立词 → 匹配 ✅
```

多词短语不做词边界检查（短语本身即边界）。

### 匹配后行为

匹配到的 Skill 立即被 activate → 完整 System Prompt 注入 → LLM 不需要调用 `skill` 工具：

```
用户输入 → matchSkills() 命中 "code-reviewer"
  → skillManager.activate("code-reviewer")     // 加载完整 prompt
  → rebuildSystemPrompt()                        // 注入 System Prompt
  → LLM 调用时就已经看到 code-reviewer 的指令
```

未匹配的 Skill 仍然走渐进式披露路径——`buildAvailableSkillsHint()` 列出名字和描述，LLM 需要时调用 `skill` 工具激活。

## 配置

意图识别无需额外配置，Agent 基类自动执行。相关配置项：

```ts
// AgentConfig 中已有的配置（控制后续行为）
{
  precipitation: "off" | "post-hoc",      // wantsRemember 会覆盖此配置
  memoryReflection: "off" | "post-hoc",   // wantsRemember 会覆盖此配置
  skillsDir: "./skills",                  // Skill 扫描目录
}
```

## 可扩展性

### 添加新信号

在 `src/intent/signal-detector.ts` 中：

1. 向 `UserSignals` 接口添加新字段
2. 添加匹配逻辑到 `detectSignals()` 函数
3. 在对应 Agent 的 `run()` 中消费新信号

### Skill 添加关键词

在 SKILL.md 的 frontmatter 中添加 `keywords`：

```markdown
---
name: my-skill
description: Does something useful
keywords: ["keyword1", "keyword2", "keyword3"]
---
```

PrecipitateAgent 自动沉淀时也会生成关键词。

## 下一步

- [Skills 渐进式技能](/advanced/skills) — Skill 定义、关键词、自动激活
- [Precipitation 沉淀](/advanced/precipitation) — 自动提取技能并生成关键词
- [Reflection 反思](/advanced/reflection) — Precipitation 和 MemoryReflection 的触发规则
- [Fusion Agent](/core/fusion-agent) — `planConfirmation` 如何使用 `hasRiskyOps`
