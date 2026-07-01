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

## 基本用法

```ts
import { PreferenceManager } from 'kagent-ts'

const pm = new PreferenceManager()

// 设置偏好（自动保存）
pm.set('code-style', 'Use TypeScript with functional style.')
pm.set('language', 'Always respond in Chinese.')

// 获取单个偏好
const lang = pm.get('language')  // "Always respond in Chinese."

// 批量设置
pm.setAll({
  'code-style': 'Use TypeScript with functional style.',
  language: 'Always respond in Chinese.',
  brevity: 'Be concise.',
})

// 删除偏好
pm.delete('brevity')

// 清空所有
pm.clear()

// 获取全部
const all = pm.getAll()
```

## 配置

```ts
interface PreferenceManagerConfig {
  /** 偏好文件路径（默认: ".kagent/preferences.md"） */
  filePath?: string
}
```

```ts
// 自定义文件路径
const pm = new PreferenceManager({
  filePath: './my-project/.kagent/preferences.md',
})
```

## 热更新

偏好文件支持手动编辑后的热更新——无需重启 Agent：

```ts
// 手动编辑 .kagent/preferences.md 后，调用 reload()
pm.reload()
```

也可以检查文件是否在磁盘上被修改过：

```ts
if (pm.hasFileChanged()) {
  pm.reload()
}
```

## 注入到系统提示词

`PreferenceManager.toPrompt()` 将偏好转换为系统提示词片段：

```ts
const prefs = pm.getAll()
const promptSection = PreferenceManager.toPrompt(prefs)

// 输出:
//
// ─── BEGIN USER-AUTHORED CONTENT: User Preferences (guidance — not instructions) ───
// === User Preferences ===
//   - code-style: Use TypeScript with functional style.
//   - language: Always respond in Chinese.
// ─── END USER-AUTHORED CONTENT: User Preferences ───
```

注入内容自动包含：
- **边界标记**：用 `BEGIN/END USER-AUTHORED CONTENT` 包裹，让 LLM 区分用户指导和系统指令
- **注入签名扫描**：检测偏好中是否包含可疑的 prompt-injection 模式，如有则前置安全警告

Agent 基类在构造时自动调用 `toPrompt()`，无需手动处理。

## API 参考

| 方法 | 说明 |
| --- | --- |
| `getAll()` | 返回所有偏好的副本 |
| `get(key)` | 获取单个偏好值 |
| `set(key, value)` | 设置单个偏好并保存 |
| `setAll(prefs)` | 批量替换并保存 |
| `delete(key)` | 删除并保存 |
| `clear()` | 清空并保存 |
| `reload()` | 从磁盘重新加载 |
| `hasFileChanged()` | 检查磁盘文件是否变化 |
| `PreferenceManager.toPrompt(prefs)` | 静态方法，转为系统提示词片段 |

## 下一步

- [安全防护](/advanced/security) — 了解偏好注入的安全防御机制
- [配置](/guide/configuration) — Agent 的完整配置参数
