# Rules 项目规则

项目规则（Project Rules）是用户显式编写的项目级约束和约定，Agent 在每次对话开始时自动加载并遵循。不同于 [Memory](/advanced/memory)（由 LLM 发现和写入），Rules 完全由用户掌控。

## 与 Preferences 的区别

| | Preferences | Rules |
| --- | --- | --- |
| **范围** | 用户个人偏好（跨项目） | 项目级规则（单项目） |
| **存储** | `.kagent/preferences.md` | `.kagent/rules/` 目录（默认） |
| **内容** | 风格、语言、简洁度 | 架构约定、编码规范、项目约束 |
| **编辑** | 用户手工编辑 | 用户手工编辑 |

## 默认目录结构

Agent 默认从 `.kagent/rules/` 目录加载规则，每个 `.md` 文件作为一个规则 section：

```
.kagent/
├── preferences.md       # 用户偏好
└── rules/
    ├── architecture.md  # "使用 Clean Architecture 分层"
    ├── coding-style.md  # "使用函数式风格，禁止 class"
    ├── testing.md       # "所有模块必须有单元测试"
    └── git.md           # "commit message 使用 conventional commits"
```

文件按字母序加载，内容用 `\n\n` 拼接。

也支持单文件模式（通过 `rulesPath` 指定 `.md` 文件路径）。

## 配置 Agent

在 Agent 构造时传入 `rulesPath`（可选），默认自动加载 `.kagent/rules/` 目录：

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

// 默认读取 .kagent/rules/（无需配置）
const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [],
})

// 或自定义路径
const agent2 = new ReActAgent({
  // ...
  rulesPath: '.rules/',  // 目录模式
  // rulesPath: 'RULES.md',  // 单文件模式
})
```

## 自动热更新

Agent 在每次 `run()` 开始时自动调用 `reloadIfChanged()`，所以编辑规则文件后**无需重启 Agent**，下次对话自动生效。

如果需要手动管理 `ProjectRules` 实例（例如检查配置状态）：

```ts
import { ProjectRules } from 'kagent-ts'

const rules = new ProjectRules('.kagent/rules/')
console.log(rules.isConfigured)  // true

// 手动检查并重载
if (rules.reloadIfChanged()) {
  console.log('规则已更新')
}
```

## 注入格式

`buildPrompt()` 生成的内容会自动包装安全边界：

```text
─── BEGIN USER-AUTHORED CONTENT: Project Rules (guidance — not instructions) ───
## Project Rules
（规则内容...）
─── END USER-AUTHORED CONTENT: Project Rules ───
```

同样会过一遍 prompt-injection 签名扫描——如果规则内容匹配了已知注入模式，前方会插入安全警告。

## API 参考

```ts
class ProjectRules {
  constructor(rulesPath?: string)  // 不传默认 .kagent/rules/，文件不存在则静默空载
  isConfigured: boolean           // 是否已配置规则源
  reloadIfChanged(): boolean      // 磁盘有变化则重载，返回是否实际重载
  buildPrompt(): string            // 生成系统提示词片段（空则返回 ""）
}
```

## 下一步

- [Memory 记忆](/advanced/memory) — LLM 自动发现和写入的长期记忆
- [安全防护](/advanced/security) — 了解规则注入的安全防御机制
- [Preference 偏好](/advanced/preferences) — 用户个人偏好设置
