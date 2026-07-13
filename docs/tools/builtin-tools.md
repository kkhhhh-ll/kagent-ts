# 内置工具

kagent-ts 提供了 16 个内置工具，覆盖文件操作、搜索、Shell 执行、网络抓取、知识检索、记忆管理等场景。

## 工具列表总览

| 工具 | 说明 | 是否需要审批 |
|------|------|:---:|
| `ReadFileTool` | 读取文件内容 | |
| `WriteFileTool` | 写入文件 | |
| `EditFileTool` | 精确字符串替换编辑 | |
| `GrepSearchTool` | 正则内容搜索 (ripgrep) | |
| `GlobSearchTool` | 文件名模式匹配 | |
| `BashTool` | 执行 Shell 命令 | ⚠️ |
| `WebFetchTool` | 抓取 URL 内容 | |
| `SkillTool` | 激活渐进式 Skill | |
| `SearchKnowledgeTool` | 语义搜索 RAG 知识库 | |
| `ListKnowledgeDocumentsTool` | 列出已索引的文档 | |
| `IngestKnowledgeTool` | 运行时向知识库添加文档（URL/文本/文件） | |
| `RememberTool` | 写入长期记忆 | |
| `RecallTool` | 检索长期记忆 | |
| `ListSubagentsTool` | 列出可用子代理 | |
| `SpawnSubagentTool` | 派发子代理任务 | |
| `ListErrorsTool` | 列出工具错误追踪 | |

## 注册方式

```ts
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES, registerAllBuiltinTools } from 'kagent-ts'

// 方式 1: 直接传入 BUILTIN_TOOLS
const agent = new ReActAgent({
  // ...
  tools: BUILTIN_TOOLS,
})

// 方式 2: 手动注册到 Registry
const registry = new ToolRegistry()
registerAllBuiltinTools(registry)

// BUILTIN_TOOL_NAMES 包含所有内置工具名称
console.log(BUILTIN_TOOL_NAMES)
// ['read_file', 'write_file', 'edit_file', 'grep_search', ...]
```

## 文件操作工具

### ReadFileTool

读取文件内容，支持行号指定。

```json
{
  "file_path": "/path/to/file.ts",
  "offset": 1,
  "limit": 100
}
```

### WriteFileTool

写入文件内容，覆盖已有文件。

```json
{
  "file_path": "/path/to/file.ts",
  "content": "console.log('hello');"
}
```

### EditFileTool

精确的字符串替换编辑（需 `old_string` 与文件内容完全匹配）。

```json
{
  "file_path": "/path/to/file.ts",
  "old_string": "const x = 1;",
  "new_string": "const x = 2;",
  "replace_all": false
}
```

## 搜索工具

### GrepSearchTool

基于 ripgrep 的内容搜索，支持正则表达式。

```json
{
  "pattern": "function\\s+\\w+",
  "path": "/project/src",
  "glob": "*.ts",
  "output_mode": "content"
}
```

### GlobSearchTool

文件名模式匹配。

```json
{
  "pattern": "src/**/*.ts",
  "path": "/project"
}
```

## Shell 执行

### BashTool

执行 Shell 命令。

⚠️ **需要审批**: 默认需要 HITL 审批。

```json
{
  "command": "ls -la src/",
  "timeout": 30000,
  "description": "列出 src 目录文件"
}
```

## 网络工具

### WebFetchTool

抓取 URL 内容并转换为 Markdown。

```json
{
  "url": "https://example.com/docs",
  "prompt": "提取文档的主要内容"
}
```

## 知识检索

### SearchKnowledgeTool

语义搜索 RAG 知识库，返回最相关的文档片段。

```json
{
  "query": "MCP 配置方法"
}
```

需要配置 `rag` 选项，详见 [RAG 知识库](/advanced/rag)。

### ListKnowledgeDocumentsTool

列出知识库中已索引的所有文档。

仅当配置了 `rag` 时可用。

### IngestKnowledgeTool

运行时向 RAG 知识库添加文档，支持三种来源：

| 来源类型 | `source` 值 | 必填参数 | 说明 |
| -------- | ----------- | -------- | ---- |
| URL 网页 | `"url"` | `url` | 抓取网页、去除 HTML 标签、自动检测标题 |
| 内联文本 | `"text"` | `content`, `title` | 将任意文本直接索引入库 |
| 本地文件 | `"file"` | `filePath` | 加载 .md/.txt/.json 文件 |

```json
// 从 URL 摄入
{
  "source": "url",
  "url": "https://react.dev/blog/2024/12/05/react-19",
  "title": "React 19 Release"
}
```

```json
// 从内联文本摄入
{
  "source": "text",
  "content": "Kubernetes Pod 是 K8s 中最小的部署单元...",
  "title": "K8s Pod 概念"
}
```

```json
// 从本地文件摄入
{
  "source": "file",
  "filePath": "/home/user/docs/api-reference.md"
}
```

文档添加后**立即可搜索**，`search_knowledge` 可立即命中新内容。相同路径的文档会自动替换（旧 chunks 删除，新 chunks 追加）。

仅当配置了 `rag` 时可用。详见 [RAG 知识库](/advanced/rag)。

## 知识与记忆

### SkillTool

激活渐进式 Skill（按需加载 Skill 定义）。

### RememberTool

写入长期记忆到文件系统。

```json
{
  "fact": "用户偏好使用 pnpm 作为包管理器",
  "category": "user_preference"
}
```

### RecallTool

从文件系统检索长期记忆。

```json
{
  "query": "包管理器偏好"
}
```

## 子代理工具

### ListSubagentsTool

列出当前可用的所有子代理及其能力。

### SpawnSubagentTool

异步派发子代理任务。

```json
{
  "agent_type": "code-reviewer",
  "input": "审查 src/core/react-agent.ts 的代码质量"
}
```

## 诊断工具

### ListErrorsTool

列出工具执行错误追踪记录，帮助 LLM 了解系统状态。

## 下一步

- [Tool Registry](/tools/tool-registry) — 注册和自定义工具
- [HITL 审批](/tools/approval) — 配置工具审批策略
- [Sub-Agent 子代理](/advanced/subagents) — 子代理的详细配置
