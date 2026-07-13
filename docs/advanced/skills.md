# Skill 渐进式技能

kagent-ts 的 Skill 系统实现了**渐进式披露**（Progressive Disclosure）模式：技能的元数据在 Agent 启动时注册，但完整内容（系统提示词）只在需要时才加载。同时支持**关键词自动激活**——与用户输入匹配的 Skill 在 LLM 调用前就已注入 System Prompt。

## 为什么需要渐进式加载？

如果将所有 Skill 的内容都注入到系统提示词中，会快速消耗 Token 预算：

```
传统方式:  系统提示词 + Skill1(5000t) + Skill2(8000t) + ... = 30000 tokens
渐进式:    系统提示词 + Skill 摘要(200t) = 2200 tokens
           ↓ LLM 决定激活 或 关键词自动匹配
           系统提示词 + 激活的 Skill(5000t) = 7200 tokens
```

## Skill 定义

Skill 通过 `SKILL.md` 文件定义：

```
skills/
├── code-review/
│   ├── SKILL.md         # Skill 定义 (YAML frontmatter + Markdown body)
│   └── reference/       # 参考文档 (可选)
│       └── guidelines.md
├── test-generation/
│   └── SKILL.md
└── deployment/
    └── SKILL.md
```

### SKILL.md 格式

```markdown
---
name: code-review
description: 审查代码质量并生成改进建议
keywords: ["review", "code", "quality", "lint"]
---

你是一个代码审查专家。在审查代码时，请遵循以下规则：

1. **类型安全**: 检查是否存在类型错误或 `any` 的滥用
2. **错误处理**: 确保所有异步操作有适当的错误处理
3. **性能**: 识别不必要的重复计算或内存泄漏
4. **可读性**: 提出命名和结构改进建议

## 审查输出格式

生成结构化的审查报告，包含:
- 严重程度 (critical/warning/info)
- 文件路径和行号
- 问题描述
- 改进建议
```

> **keywords 字段**：`keywords` 支持 JSON 数组 `["review", "code"]` 或逗号分隔字符串 `"review, code"`。关键词在用户输入中命中时，Skill 自动激活，无需 LLM 调用 `skill` 工具。

### 渐进式加载的两阶段

```
阶段 1: Agent 启动 → scan()  → 只读 frontmatter（name, description, keywords）
                                → 注入 Available Skills 提示

阶段 2: 需要时    → activate() → 加载 body + reference docs → 注入 System Prompt
         触发条件:
           - 关键词/名字匹配 → 自动激活（零 LLM 开销）
           - LLM 调用 `skill` 工具 → 按需激活
```

## 关键词自动激活

当用户输入中的词匹配 Skill 的 `name` 或 `keywords` 时，Skill 在 LLM 调用前自动激活，完整 prompt 已注入 System Prompt，LLM 不需要额外调用工具。

### 名字匹配

Skill 名按 `-` / `_` 拆分为 token，所有 token 必须以完整词形式出现在输入中（词边界匹配，避免 "code" 匹配 "unicode"）：

```
Skill: "code-reviewer" → tokens: ["code", "reviewer"]
输入: "code review please"  → 两个 token 都在 → 匹配 ✅
输入: "review the unicode"  → "code" 不匹配 → 不匹配
```

### 关键词匹配

任意一个 `keywords` 数组中的关键词以完整词形式出现即可匹配：

```
Skill: { keywords: ["deploy", "release", "production"] }
输入: "deploy to production" → "deploy" 命中 ✅
输入: "部署到 production"    → "production" 命中 ✅
```

匹配到的 Skill 会被 `activate()`，然后 `rebuildSystemPrompt()` 将其完整 prompt 注入 System Prompt。

## 配置 Skill Manager

Agent 通过 `skillsDir` 配置自动扫描和注册 Skill：

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

const agent = new ReActAgent({
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  skillsDir: './skills',   // Skill 目录，Agent 启动时自动扫描
  // 或注入自定义存储后端（传入后 skillsDir 被忽略）：
  // skillStore: new PostgresSkillStore(db),
  tools: [
    // ... 其他工具
  ],
  // skill 工具自动注册，无需手动 createSkillTool
})
```

> Agent 会在 `init()` 阶段自动扫描 `skillsDir` 并注册 Skill，同时注册 `skill` 工具（LLM 可调用以手动激活未被自动匹配的 Skill）和 `precipitate_skill` 工具。

> **安全提示：** 框架自动对 Skills 内容进行安全防护：
> - `buildSkillsPrompt()`（活跃 Skill 的完整内容）→ 自动包裹 `wrapUserAuthored` + 注入签名扫描
> - `buildAvailableSkillsHint()`（Skill 名称/描述摘要）→ 同上
>
> Skill 文件是用户编写的，存在被篡改或意外包含注入文本的风险。

## Skill 接口

```ts
interface Skill {
  /** 技能名称（kebab-case，唯一） */
  name: string

  /** 简短描述（注入 System Prompt 的可用技能列表） */
  description: string

  /**
   * 可选关键词，用于零 LLM 开销的自动激活。
   * 用户输入命中关键词时，Skill 在 LLM 调用前自动注入 System Prompt。
   */
  keywords?: string[]

  /** 完整系统提示内容（激活后加载） */
  systemPrompt?: string
}

interface SkillStatus {
  name: string
  description: string
  active: boolean
  loadedAt?: Date
}
```

## 执行流程

```
1. Agent.init() → SkillManager.registerFromDirectory(skillsDir)
   → 扫描 SKILL.md frontmatter → 注册 name + description + keywords

2. Agent.reloadDynamicResources() → 重新扫描目录，获取新增 Skill

3. Agent.matchInputSkills(input) → 关键词/名字匹配 → activate 命中的 Skill
   → rebuildSystemPrompt() → 自动激活的 Skill 已注入

4. buildAvailableSkillsHint() → 列出未激活 Skill 的名字和描述

5. LLM 调用时：
   - 已自动激活的 Skill 在 System Prompt 中可见
   - 未激活的 Skill 通过 `skill` 工具按需激活
```

## 完整示例

```ts
import {
  ReActAgent, OpenAIProvider, BUILTIN_TOOLS,
} from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个 AI 编程助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
  skillsDir: './skills',    // 自动扫描注册
})

// 用户输入 "review this code"  → 关键词 "review" 匹配 code-reviewer
// → Skill 自动激活，LLM 不需要调用 skill 工具
await agent.run('帮我审查 src/core/ 目录下的代码质量')

// 用户输入 "how to deploy" → 关键词不匹配任何 Skill
// → LLM 看到 available skills list → 调用 skill 工具手动激活
await agent.run('怎么部署这个项目？')
```

## 下一步

- [Intent Recognition 意图识别](/advanced/intent) — 信号检测 + Skill 关键词匹配
- [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能（含关键词）
- [Reflection 反思](/advanced/reflection) — 触发规则（wantsRemember 信号）
- [Memory 记忆](/advanced/memory) — 长期记忆管理
