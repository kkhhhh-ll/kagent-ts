# 工具过滤器

工具过滤器用于为子代理或不同场景筛选可用的工具集，确保子代理只能访问其需要的工具（最小权限原则）。

## 过滤器函数

```ts
import { allowlist, denylist, pattern, all, any, filterTools } from 'kagent-ts'
```

## allowlist

白名单：只允许指定的工具：

```ts
const filter = allowlist('ReadFileTool', 'GrepSearchTool', 'GlobSearchTool')

const readonlyTools = filterTools(allTools, filter)
// 结果: 只有 ReadFileTool, GrepSearchTool, GlobSearchTool
```

## denylist

黑名单：排除指定的工具：

```ts
const filter = denylist('BashTool', 'WriteFileTool', 'EditFileTool')

const safeTools = filterTools(allTools, filter)
// 结果: 除了 BashTool, WriteFileTool, EditFileTool 之外的所有工具
```

## pattern

正则模式匹配：

```ts
// 只允许名称以 "Read" 开头的工具
const filter = pattern(/^Read/)

const readTools = filterTools(allTools, filter)
// 结果: ReadFileTool 等
```

## all (AND 组合)

所有条件都必须满足：

```ts
// 名称匹配 'Tool' 且不在黑名单中
const filter = all(
  pattern(/Tool$/),
  denylist('BashTool'),
)
```

## any (OR 组合)

任一条件满足即可：

```ts
// 允许 ReadFileTool 或任何以 'Search' 结尾的工具
const filter = any(
  allowlist('ReadFileTool'),
  pattern(/Search$/),
)
```

## 为子代理配置工具

```ts
const agent = new OrchestratorAgent({
  systemPrompt: '...',
  llm: provider,
  tools: BUILTIN_TOOLS,
  subAgents: [
    {
      name: 'code-reviewer',
      description: '审查代码质量',
      systemPrompt: '你是代码审查专家...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
      // 框架内部使用 allowlist 过滤
    },
    {
      name: 'code-writer',
      description: '编写和修改代码',
      systemPrompt: '你是代码编写专家...',
      tools: ['ReadFileTool', 'WriteFileTool', 'EditFileTool', 'BashTool'],
    },
  ],
})
```

框架使用 `ToolRegistry.filter(filter)` 为每个子代理创建独立的工具注册表。

## 下一步

- [Tool Registry](/tools/tool-registry) — 工具注册中心
- [内置工具](/tools/builtin-tools) — 所有内置工具说明
- [Sub-Agent 子代理](/advanced/subagents) — 子代理配置详解
