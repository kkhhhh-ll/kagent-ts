# Intent Recognition 意图识别

Intent Recognition 系统在 Agent 执行前对用户输入做**零 LLM 开销**的信号检测和关键词匹配，提取三类信息：**风险等级、任务场景、复杂度预估**，同时决定哪些 Skill 应该提前激活。

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
  ├── detectInputSignals(input)               ← 正则匹配（< 1ms）
  │     ├── wantsRemember → 强制触发 Precipitation + MemoryReflection
  │     ├── riskLevel     → "none" / "low" / "high"（否定感知）
  │     ├── scenarios[]   → 多标签任务场景（0–N 个）
  │     └── complexity    → "simple" / "moderate" / "complex"
  │
  ├── matchInputSkills(input)                 ← 关键词/名字匹配（< 1ms）
  │     ├── 命中 Skill → activate → rebuildSystemPrompt → LLM 即刻可见
  │     └── 未命中 → LLM 仍可通过 `skill` 工具手动激活
  │
  └── LLM 自主决策                             ← Token 开销
        ├── 看到 auto-activated skills 已在 System Prompt 中
        ├── 看到 available skills → 调用 `skill` 工具
        └── 看到 available subagents → 调用 `spawn_subagent` 工具
```

全部在 Agent 基类中完成，三个 Agent 类型（ReAct / PlanSolve / Fusion）行为一致。

## 信号检测

### 信号类型

```ts
export type RiskLevel = "none" | "low" | "high";

export type TaskComplexity = "simple" | "moderate" | "complex";

export type AgentScenario =
  | "file-search"
  | "code-read"
  | "code-write"
  | "refactoring"
  | "debugging"
  | "deployment"
  | "testing"
  | "configuration";

interface UserSignals {
  wantsRemember: boolean;       // 用户明确要求记住/保存
  riskLevel: RiskLevel;         // 风险分级（否定感知）
  scenarios: AgentScenario[];   // 多标签任务场景（0–N 个）
  complexity: TaskComplexity;   // 基于表面特征的任务复杂度预估
}
```

### 风险分级

`riskLevel` 替代了旧版的 `hasRiskyOps: boolean`，提供三级风险：

| 等级 | 关键词 | 效果 |
|------|--------|------|
| `"none"` | 无匹配 | 不干预执行 |
| `"low"` | `deploy`, `release`, `publish`, `ship`, `migrate`, `reset` | FusionAgent `planConfirmation: "auto"` **不触发**确认（低风险操作视为常规） |
| `"high"` | `delete`, `drop`, `destroy`, `purge`, `format`, `truncate`, `rm -rf`, `force push`, `hard reset` | FusionAgent `planConfirmation: "auto"` 时强制请求用户确认 |

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

`scenarios` 从旧的单个 `scenario: AgentScenario | null` 升级为 `scenarios: AgentScenario[]`（多标签）：

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

| 场景 | Latin 词干 | CJK 关键词 |
|------|-----------|-----------|
| `refactoring` | `refactor`, `restructur`, `renam`, `mov`, `extract` | `重构`, `重命名`, `重構` |
| `debugging` | `bug`, `debug`, `fix`, `error`, `crash`, `broken` | `调试`, `修复`, `报错`, `調試`, `修復`, `報錯` |
| `deployment` | `deploy`, `releas`, `publish`, `ship` | `部署`, `发布`, `上线`, `發布`, `上線` |
| `testing` | `test`, `spec`, `coverage` | `测试`, `单元测试`, `測試`, `單元測試` |
| `configuration` | `config`, `setup`, `install`, `env`, `dependenc` | `配置`, `安装`, `环境`, `安裝`, `環境` |
| `file-search` | `grep`, `search`, `find`, `look`, `locate` | `搜索`, `查找`, `找` |
| `code-read` | `read`, `understand`, `explain`, `review` | `阅读`, `解释`, `审查`, `閱讀`, `解釋`, `審查` |
| `code-write` | `writ`, `implement`, `add`, `creat`, `generat` | `写`, `实现`, `创建`, `寫`, `實現`, `創建` |

### 复杂度预估

`complexity` 基于输入的表面特征进行累计评分，为零 LLM 成本的任务复杂度预估：

**评分因子**（每满足一项 +1 分）：

| 条件 | 说明 |
|------|------|
| 输入长度 > 100 字符 | 中长查询 |
| 输入长度 > 500 字符 | 长查询 |
| ≥ 3 个文件路径引用 | `auth.ts`, `user.ts` 等 |
| ≥ 6 个文件路径引用 | 大量文件涉及 |
| ≥ 3 个句子 | 多步骤描述 |
| ≥ 6 个句子 | 长篇幅描述 |
| 范围关键词 | `refactor`, `migrate`, `整个`, `全部`, `all`, `entire` |
| 多任务连接词 | `and also`, `同时`, `并且`, `以及`, `additionally` |

**阈值**：

| 分数 | 复杂度 | 含义 |
|------|--------|------|
| 0–1 | `"simple"` | 单步查询，简单问答 |
| 2–3 | `"moderate"` | 涉及多文件或中等长度的任务 |
| 4+ | `"complex"` | 大规模重构、多文件修改 |

```ts
detectSignals("read auth.ts").complexity     // "simple"
detectSignals("Look at auth.ts, user.ts, config.ts. Fix the types. Write tests.")
  .complexity  // "moderate"
detectSignals("Refactor the entire auth system. Migrate from JWT to session-based...")
  .complexity  // "complex"
```

> **注意**：`complexity` 目前仅作为前瞻性信号，尚未用于路由决策。未来可用于自动选择 Agent 范式（简单任务 → ReAct，复杂任务 → Plan-Solve/Fusion）。

### 触发规则

| 信号 | 匹配模式 | 效果 |
|------|---------|------|
| `wantsRemember` | `remember` / `save this` / `记住` / `保存` / `記住` / `儲存` / `记录下来` / `記錄下來` | 直接覆盖 mode 配置，强制触发 Precipitation 和 MemoryReflection |
| `riskLevel: "high"` | 含高风险关键词且未被否定 | FusionAgent `planConfirmation: "auto"` 时请求用户审批 |
| `riskLevel: "low"` | 含低风险关键词且无高风险 | 不触发确认（常规操作） |
| `riskLevel: "none"` | 无风险关键词或全部被否定 | 不干预 |

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

## 场景驱动的错题本注入

检测到的场景不仅用于分类，还直接影响错题本的提示词注入：

```ts
// Agent 基类 buildSystemPrompt() 中：
this.notebook.buildScenarioPrompt(this.inputSignals.scenarios, 5, 1);
// 传入多标签场景 → 匹配任一场景的错题条目都会被注入 System Prompt
```

详见 [Reflection 反思](/advanced/reflection#场景过滤)。

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
- [Reflection 反思](/advanced/reflection) — Precipitation 和 MemoryReflection 的触发规则
- [Fusion Agent](/core/fusion-agent) — `planConfirmation` 如何使用 `riskLevel`
