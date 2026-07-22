# Intent Recognition 意图识别

Intent Recognition 系统在 Agent 执行前对用户输入做**零 LLM 开销**的信号检测和关键词匹配，提取三类信息：**风险等级、任务场景、复杂度预估**，同时决定哪些 Skill 应该提前激活。

## 为什么需要？

Agent 框架有三种行为控制方式：

|------|------|---------|

配置开关是死的（mode: "off" → 永不触发），LLM 决策是贵的（每次都要消耗 Token 和等待 LLM 响应）。意图识别填补了中间地带——**当用户输入已经包含了明确信号时，零成本做出反应**。

## 架构

```text
用户输入 → Agent.run()
  ├── detectInputSignals(input)               ← 正则匹配（< 1ms）
  │     ├── wantsRemember → 强制触发 Precipitation + MemoryReflection
  │     ├── riskLevel     → "none" / "low" / "high"（否定感知）
  │     ├── scenarios[]   → 多标签任务场景（0–N 个）
  │     └── complexity    → "simple" / "moderate" / "complex"
  │
  ├── matchInputContext(input)                ← BM25 检索 + 记忆检索（< 1.5ms）
  │     ├── 命中 Skill → activate → rebuildSystemPrompt → LLM 即刻可见
  │     ├── 命中 Memory → 完整内容注入 System Prompt
  │     └── 未命中 → LLM 仍可通过 `skill` / `recall` 工具手动激活
  │
  └── LLM 自主决策                             ← Token 开销
        ├── 看到 auto-activated skills 已在 System Prompt 中
        ├── 看到 BM25 匹配的记忆完整内容已注入
        ├── 看到 available skills → 调用 `skill` 工具
        └── 看到 remaining memories → 调用 `recall` 工具
```

全部在 Agent 基类中完成，三个 Agent 类型（ReAct / PlanSolve / Fusion）行为一致。

## 信号检测

### 信号类型

```ts
export type RiskLevel = "none" 
export type TaskComplexity = "simple" 
export type AgentScenario =

interface UserSignals {
  wantsRemember: boolean;       // 用户明确要求记住/保存
  riskLevel: RiskLevel;         // 风险分级（否定感知）
  scenarios: AgentScenario[];   // 多标签任务场景（0–N 个）
  complexity: TaskComplexity;   // 基于表面特征的任务复杂度预估
}
```

### 风险分级

`riskLevel` 替代了旧版的 `hasRiskyOps: boolean`，提供三级风险：

|------|--------|------|

#### 否定感知

当风险关键词出现在**含否定标记的句子**中时，该关键词被排除。否定标记包括：

- 中文：`不要`、`千万别`、`禁止`、`切勿`、`请勿`、`避免`
- 英文：`don't`、`do not`、`never`、`without`、`avoid`、`prevent`、`shouldn't`、`can't`、`cannot`

```ts
detectSignals("不要删除这个文件").riskLevel      // "none" — "删除" 在否定句中
detectSignals("删除临时文件").riskLevel           // "high" — 无否定
detectSignals("deploy but don't delete").riskLevel // "low" — "delete" 被否定排除，"deploy" 仍然是低风险
detectSignals("don't delete files. Drop the table.").riskLevel // "high" — 只否定第一句，第二句不被否定
```

否定是**句子级别**的——只有同一句中的风险关键词被排除。

### 任务场景（多标签）

`scenarios` 从旧的单个 `scenario: AgentScenario 
```ts
// 单个场景
detectSignals("debug the auth bug").scenarios
// → ["debugging"]

// 多个场景——先匹配先赢的时代结束了
detectSignals("find the bug in auth.ts and fix it, then deploy").scenarios
// → ["debugging", "file-search", "code-write", "deployment"]
```

#### 匹配策略

Latin（英文）和 CJK（中日韩）分词采用不同策略：

- **Latin**：`(?:^|\s)` 词首锚定正则，词干匹配（`bug` 匹配 `bugs`，`writ` 匹配 `writes`/`writing`，`creat` 匹配 `creates`/`creating`）
- **CJK**：`String.includes()` 子串匹配（CJK 无空格分词，`\b` 对非 `\w` 字符无效）
- 同时收录简繁体变体（`阅读` + `閱讀`，`写` + `寫` 等）

|------|-----------|-----------|

### 复杂度预估

`complexity` 基于输入的表面特征进行累计评分，为零 LLM 成本的任务复杂度预估：

**评分因子**（每满足一项 +1 分）：

|------|------|

**阈值**：

|------|--------|------|

```ts
detectSignals("read auth.ts").complexity     // "simple"
detectSignals("Look at auth.ts, user.ts, config.ts. Fix the types. Write tests.")
  .complexity  // "moderate"
detectSignals("Refactor the entire auth system. Migrate from JWT to session-based...")
  .complexity  // "complex"
```

> **注意**：`complexity` 目前仅作为前瞻性信号，尚未用于路由决策。未来可用于自动选择 Agent 范式（简单任务 → ReAct，复杂任务 → Plan-Solve/Fusion）。

### 触发规则

|------|---------|------|

### wantsRemember vs mode 配置

关键设计：用户说"记住"时，**无视** `precipitation` 和 `memoryReflection` 的 mode 配置：

```ts
// 不管 mode 是 "off" 还是 "post-hoc"，用户显式表态就执行
if (this.inputSignals.wantsRemember) {
  shouldPrecipitate = true;
  shouldReflectMemory = true;
}
```

|------|--------|---------------|

### hard-won success（踩坑后成功）

当 Agent 连续失败 ≥ 2 次后最终成功时，框架自动触发 Precipitation（保存来之不易的解决方案）。MemoryReflection 不受此条件触发——记忆提取与工具失败无关。

## Skill 与 Memory BM25 检索

### 检索方式

Agent 在每次 `run()` 启动时使用 **BM25 关键词检索**（`matchInputContext()`）自动匹配相关 Skill 和 Memory：

- **Skill 索引**：首次运行时预加载所有 Skill 的 systemPrompt，建立 BM25 索引。后续运行复用缓存（除非 `reloadFromDirectory()` 检测到新 Skill 文件）
- **Memory 索引**：每次 `run()` 重建（记忆可通过 `remember` 工具动态增删）

BM25 使用**双阈值过滤**：
- **比值阈值**：得分低于最高分 10% 的结果被舍弃
- **绝对阈值**：得分低于 1.5 的结果被舍弃（排除常见词误匹配）

### keywords 字段

Skill 的 `keywords` 字段被纳入 BM25 索引文本，用于跨语言匹配：

```
Skill: "test-writer"  keywords: ["测试", "单元测试"]
查询: "帮我写几个单元测试"
  → BM25 tokenize: [帮] [我] [写] [几] [个] [单元测试] ← 命中 keywords "单元测试"
  → score: 6.90 → 自动激活 ✅
```

### 匹配后行为

```
用户输入 → matchInputContext()
  ├─ BM25 检索 Skills → activate → rebuildSystemPrompt → LLM 即刻可见
  └─ BM25 检索 Memories → 完整内容注入 System Prompt → LLM 即刻可见
```

未匹配的 Skill 和 Memory 仍走渐进式披露路径——`buildAvailableSkillsHint()` 和 `buildMemoryPrompt()` 列出剩余项，LLM 按需调用 `skill` / `recall` 工具。

## 场景驱动的

检测到的场景不仅用于分类，还直接影响

```ts
// Agent 基类 buildSystemPrompt() 中：
this.notebook.buildScenarioPrompt(this.inputSignals.scenarios, 5, 1);
// 传入多标签场景 → 匹配任一场景的错题条目都会被注入 System Prompt
```

详见 
## 配置

意图识别无需额外配置，Agent 基类自动执行。相关配置项：

```ts
// AgentConfig 中已有的配置（控制后续行为）
{
  precipitation: "off"   memoryReflection: "off"   skillsDir: "./skills",                  // Skill 扫描目录
}
```

## 可扩展性

### 添加新信号

在 `src/intent/signal-detector.ts` 中：

1. 向 `UserSignals` 接口添加新字段
2. 添加匹配逻辑到 `detectSignals()` 函数
3. 在对应 Agent 的 `run()` 中消费新信号

### 添加新场景

在 `SCENARIO_PATTERNS` 数组中添加新条目：

```ts
{
  latin: ["keyword1", "stem2"],
  cjk: ["关键词1", "關鍵詞1"],
  scenario: "new-scenario",
}
```

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
- - [Fusion Agent](/core/fusion-agent) — `planConfirmation` 如何使用 `riskLevel`
