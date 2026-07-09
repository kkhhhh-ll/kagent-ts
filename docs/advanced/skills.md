# Skill 渐进式技能

kagent-ts 的 Skill 系统实现了**渐进式披露**（Progressive Disclosure）模式：技能的元数据在 Agent 启动时注册，但完整内容（系统提示词、参考文档、脚本）只在需要时才加载。

## 为什么需要渐进式加载？

如果将所有 Skill 的内容都注入到系统提示词中，会快速消耗 Token 预算：

```
传统方式:  系统提示词 + Skill1(5000t) + Skill2(8000t) + ... = 30000 tokens
渐进式:    系统提示词 + Skill 摘要(200t) = 2200 tokens
           ↓ LLM 决定激活某 Skill
           系统提示词 + 激活的 Skill(5000t) = 7200 tokens
```

## Skill 定义

Skill 通过 `SKILL.md` 文件定义：

```
skills/
├── code-review/
│   ├── SKILL.md         # Skill 定义 (YAML frontmatter + Markdown body)
│   ├── reference/       # 参考文档 (可选)
│   │   └── guidelines.md
│   └── scripts/         # 脚本 (可选)
│       └── review.sh
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
keywords: [review, code, quality, lint]
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

## 配置 Skill Manager

```ts
import { SkillManager } from 'kagent-ts'

const skillManager = new SkillManager({
  skillDirs: ['./skills', '~/.kagent/skills'],
})

// 扫描并注册所有 Skill
await skillManager.scan()

// 将 Skill 摘要注入系统提示词
const skillPrompt = skillManager.buildAvailableSkillsHint()
```

> **安全提示：** 框架自动对 Skills 内容进行安全防护（与 Project Rules / Preferences 一致）：
> - `buildSkillsPrompt()`（活跃 Skill 的完整内容）→ 自动包裹 `wrapUserAuthored` + 注入签名扫描
> - `buildAvailableSkillsHint()`（Skill 名称/描述摘要）→ 同上
>
> Skill 文件是用户编写的，存在被篡改或意外包含注入文本的风险。

## Agent 集成

```ts
const agent = new ReActAgent({
  systemPrompt: `你是一个多才多艺的 AI 助手。
${skillManager.buildAvailableSkillsHint()}`,
  llm: provider,
  tools: [
    ...BUILTIN_TOOLS,
    createSkillTool(skillManager),  // LLM 可调用的 Skill 激活工具
  ],
})
```

## Skill 接口

```ts
interface Skill {
  /** 技能名称 */
  name: string

  /** 简短描述 (注入系统提示词) */
  description: string

  /** 触发关键词 */
  keywords: string[]

  /** 完整系统提示内容 (激活后加载) */
  content?: string

  /** 参考文档路径 */
  references?: string[]

  /** 脚本路径 */
  scripts?: string[]
}

enum SkillStatus {
  REGISTERED = 'registered',   // 已注册，未加载
  ACTIVATED = 'activated',     // 已激活，内容加载
}
```

## 执行流程

```
1. SkillManager.scan()  → 扫描 skillDirs，注册所有 Skill 元数据
2. skillManager.buildAvailableSkillsHint() → 生成 Skill 摘要列表注入系统提示词
3. LLM 判断需要某个 Skill → 调用 SkillTool
4. SkillManager.activate(name) → 加载 Skill 完整内容
5. Skill 内容注入系统提示词 → LLM 获得领域专业知识
```

## 完整示例

```ts
import {
  ReActAgent,
  OpenAIProvider,
  SkillManager,
  createSkillTool,
  BUILTIN_TOOLS,
} from 'kagent-ts'

const skillManager = new SkillManager({
  skillDirs: ['./skills'],
})
await skillManager.scan()

const agent = new ReActAgent({
  systemPrompt: `你是一个 AI 编程助手。以下是你可以使用的高级技能:
${skillManager.buildAvailableSkillsHint()}

当你需要使用某个技能时，调用 activate_skill 工具激活它。`,
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [
    ...BUILTIN_TOOLS,
    createSkillTool(skillManager),
  ],
})

await agent.run('帮我审查 src/core/ 目录下的代码质量')
// Agent 发现 code-review skill → 调用 activate_skill → 获得审查专业能力
```

## 下一步

- [Precipitation 沉淀](/advanced/precipitation) — 自动提取可复用技能
- [Sub-Agent 子代理](/advanced/subagents) — 子代理的配置与调度
- [Memory 记忆](/advanced/memory) — 长期记忆管理
- [Reflection 反思](/advanced/reflection) — 执行后反思
