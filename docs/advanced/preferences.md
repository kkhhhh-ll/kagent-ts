# Preferences 用户偏好

Preferences 是用户定义的键值对指令集，存储在 `.kagent/preferences.md` 文件中，在每次 Agent 运行时自动注入到系统提示词中。这让 LLM 始终"看到"你的偏好，无需每次手动说明。

## 工作原理

```
.kagent/preferences.md  ──加载──▶  PreferenceManager  ──注入──▶  System Prompt
                                                    ▲
                                         安全扫描 (Prompt Injection)
                                                    ▲
                                         边界标记 (User-Authored)
```

每次 Agent 启动时，`PreferenceManager` 从磁盘加载偏好文件，扫描注入签名，包裹安全边界标记，然后注入系统提示词。

## 偏好文件格式

`.kagent/preferences.md`：

```markdown
# User Preferences

code-style: Use TypeScript with functional style. Prefer interfaces over types.
language: Always respond in Chinese.
brevity: Be concise. Skip boilerplate explanations.
```

- `#` 开头的行为注释，加载时忽略
- 空行忽略
- 有效行格式为 `key: value`

## 使用方式

Agent 默认自动加载 `.kagent/preferences.md`，无需任何配置。只要文件存在，偏好就会自动注入系统提示词：

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

// 偏好自动生效，不需要额外配置
const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: [],
})
```

编辑 `.kagent/preferences.md` 后，Agent 在下次 `run()` 时自动重载，无需重启。

如需自定义文件路径：

```ts
const agent = new ReActAgent({
  // ...
  preferencesPath: './custom/path.md',
})
```

## 注入格式

偏好内容会被自动包装并注入系统提示词，LLM 实际看到的内容如下：

```text
--- BEGIN USER-AUTHORED CONTENT: User Preferences ---
=== User Preferences ===
  - code-style: Use TypeScript with functional style.
  - language: Always respond in Chinese.
--- END USER-AUTHORED CONTENT: User Preferences ---
```

注入内容自动包含安全边界标记和 prompt-injection 签名扫描。

## 实现细节

Preferences 和 [Rules](/advanced/rules) 共享同一套实现模式：读取文件 → 热更新 → 注入系统提示词。核心方法：

| 方法 | 说明 |
| --- | --- |
| `reloadIfChanged()` | 检查磁盘文件是否变化，如有则重新加载 |
| `buildPrompt()` | 生成注入系统提示词的文本片段 |

文件大小限制为 **10 KB**，超大文件会被跳过并在日志中警告。

通常你不需要直接调用它们——Agent 在每次 `run()` 时自动处理。

## 下一步

- [安全防护](/advanced/security) — 了解偏好注入的安全防御机制
- [配置](/guide/configuration) — Agent 的完整配置参数
