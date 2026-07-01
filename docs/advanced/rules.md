# Rules 项目规则

项目规则（Project Rules）是用户显式编写的项目级约束和约定，Agent 在每次对话开始时自动加载并遵循。不同于 [Memory](/advanced/memory)（由 LLM 发现和写入），Rules 完全由用户掌控。

## 与 Preferences 的区别

| | Preferences | Rules |
| --- | --- | --- |
| **范围** | 用户个人偏好（跨项目） | 项目级规则（单项目） |
| **存储** | `.kagent/preferences.md` | `RULES.md` 或 `.rules/` 目录 |
| **内容** | 风格、语言、简洁度 | 架构约定、编码规范、项目约束 |
| **编辑** | 用户手工编辑 | 用户手工编辑 |

## 两种模式

### 单文件模式

指定一个 Markdown 文件，所有规则写在一起：

```ts
import { ProjectRules } from 'kagent-ts'

const rules = new ProjectRules('RULES.md')
```

### 目录模式

指定一个目录，每个 `.md` 文件作为一个规则 section：

```
.rules/
├── architecture.md    # "使用 Clean Architecture 分层"
├── coding-style.md    # "使用函数式风格，禁止 class"
├── testing.md         # "所有模块必须有单元测试"
└── git.md             # "commit message 使用 conventional commits"
```

```ts
const rules = new ProjectRules('.rules/')
```

目录模式下，文件按字母序加载，内容用 `\n\n` 拼接。

## 配置 Agent

在 Agent 构造时传入 `projectRules`：

```ts
import { ReActAgent, OpenAIProvider, ProjectRules } from 'kagent-ts'

const rules = new ProjectRules('.rules/')

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  }),
  projectRules: rules,
  tools: [],
})
```

## 自动热更新

Agent 在每次 `run()` 开始时自动调用 `reloadIfChanged()`，所以你编辑规则文件后**无需重启 Agent**，下次对话自动生效：

```ts
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
  constructor(rulesPath?: string)  // 可选，不传则空载
  isConfigured: boolean           // 是否已配置规则源
  reloadIfChanged(): boolean      // 磁盘有变化则重载，返回是否实际重载
  buildPrompt(): string            // 生成系统提示词片段（空则返回 ""）
}
```

## 下一步

- [Memory 记忆](/advanced/memory) — LLM 自动发现和写入的长期记忆
- [安全防护](/advanced/security) — 了解规则注入的安全防御机制
- [Preference 偏好](/advanced/preferences) — 用户个人偏好设置
