# Intent Recognition 意图识别

Intent Recognition 系统在 Agent 执行前对用户输入做**零 LLM 开销**的信号检测和关键词匹配，提取两类信息：**记住意图、风险等级**，同时决定哪些 Skill 应该提前激活。

## 为什么需要？

Agent 框架有三种行为控制方式：

| 方式 | 特点 | 成本 |
|------|------|---------|
| 配置开关 | 确定性，但死板 | 零 |
| 意图识别 | 正则匹配，零 LLM 开销 | 零 |
| LLM 决策 | 灵活，但昂贵 | Token + 延迟 |

配置开关是死的（mode: "off" → 永不触发），LLM 决策是贵的（每次都要消耗 Token 和等待 LLM 响应）。意图识别填补了中间地带——**当用户输入已经包含了明确信号时，零成本做出反应**。

## 架构

```text
用户输入 → Agent.run()
  ├── detectInputSignals(input)               ← 正则匹配（< 1ms）
  │     ├── wantsRemember → 强制触发 MemoryReflection
  │     └── riskLevel     → "none" / "low" / "high"（否定感知）
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
export type RiskLevel = "none" | "low" | "high";

interface UserSignals {
  wantsRemember: boolean;       // 用户明确要求记住/保存
  riskLevel: RiskLevel;         // 风险分级（否定感知）
}
```

### 风险分级

`riskLevel` 替代了旧版的 `hasRiskyOps: boolean`，提供三级风险：

| 级别 | 含义 | 触发条件 |
|------|--------|------|
| `"none"` | 无风险 | 无风险关键词，或被否定排除 |
| `"low"` | 低风险 | 低风险关键词（deploy, release 等） |
| `"high"` | 高风险 | 高风险关键词（delete, drop, rm -rf 等） |

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

### 触发规则

| 信号 | 触发的行为 |
|------|---------|
| `wantsRemember` | 强制 MemoryReflection |
| `riskLevel: "high"` | Fusion planConfirmation 自动请求确认 |

### wantsRemember vs mode 配置

关键设计：用户说"记住"时，**无视** `memoryReflection` 的 mode 配置：

```ts
// 不管 mode 是 "off" 还是 "post-hoc"，用户显式表态就执行
if (this.inputSignals.wantsRemember) {
  shouldReflectMemory = true;
}
```

| mode | `wantsRemember = true` | `wantsRemember = false` |
|------|--------|---------------|
| `"post-hoc"` | 触发 | 触发 |
| `"off"` | 触发 | 不触发 |

### hard-won success（踩坑后成功）

MemoryReflection 不受工具失败条件触发——记忆提取仅受配置模式和 wantsRemember 信号控制。

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

## 配置

意图识别无需额外配置，Agent 基类自动执行。相关配置项：

```ts
// AgentConfig 中已有的配置（控制后续行为）
{
  memoryReflection: "off"   skillsDir: "./skills",                  // Skill 扫描目录
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

## 下一步

- [Skills 渐进式技能](/advanced/skills) — Skill 定义、关键词、自动激活
- [Fusion Agent](/core/fusion-agent) — `planConfirmation` 如何使用 `riskLevel`
