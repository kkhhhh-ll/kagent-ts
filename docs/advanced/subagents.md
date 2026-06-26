# Sub-Agent 子代理

Sub-Agent 系统允许你将复杂任务**委派给专门的子代理**，实现并行处理和专业分工。

## 架构

```
Main Agent
  ↓ 委派任务
SubAgentManager
  ├── SubAgent 1: code-reviewer   → 审查代码质量
  ├── SubAgent 2: test-writer     → 编写测试
  └── SubAgent 3: doc-generator   → 生成文档
  ↓ 轮询结果
Main Agent
  ↓ 合成答案
Final Answer
```

## 定义子代理

### AGENT.md 文件

每个子代理通过 `AGENT.md` 文件定义：

```
subagents/
├── code-reviewer/
│   └── AGENT.md
├── test-writer/
│   └── AGENT.md
└── doc-generator/
    └── AGENT.md
```

### AGENT.md 格式

```markdown
---
name: code-reviewer
description: 审查 TypeScript 代码质量，识别潜在问题和改进点
tools:
  - ReadFileTool
  - GrepSearchTool
  - GlobSearchTool
---

你是一个资深的 TypeScript 代码审查专家。在审查代码时：

1. 检查类型安全性
2. 检查错误处理
3. 识别性能瓶颈
4. 评估代码可读性
5. 检查安全漏洞

请输出结构化的审查报告：每个问题标注严重程度、文件位置和改进建议。
```

## 加载和管理子代理

```ts
import { SubAgentLoader, SubAgentManager } from 'kagent-ts'

// 方式 1: 从文件加载
const loader = new SubAgentLoader()
const definitions = await loader.loadFromDirectory('./subagents')

// 方式 2: 直接定义
const definitions = [
  {
    name: 'code-reviewer',
    description: '审查 TypeScript 代码质量',
    systemPrompt: '你是一个资深的 TypeScript 代码审查专家...',
    tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
  },
]

// 创建 Manager
const manager = new SubAgentManager(definitions)
```

## 集成到 Agent

```ts
const agent = new OrchestratorAgent({
  systemPrompt: '你是一个高级任务编排器。',
  provider: mainProvider,
  tools: BUILTIN_TOOLS,
  subAgents: definitions,
})
```

或者手动提供专用 Provider：

```ts
const agent = new ReActAgent({
  systemPrompt: '...',
  provider: mainProvider,
  tools: [
    ...BUILTIN_TOOLS,
    createSpawnSubagentTool(subAgentManager),
    createListSubagentsTool(subAgentManager),
  ],
})
```

## 异步生命周期

```
Main Agent 调用 SpawnSubagentTool
  ↓
SubAgentManager.spawn(name, input)
  ├── 创建子 Agent 实例
  ├── 使用专用 Provider (或继承主 Provider)
  ├── 在后台执行任务
  └── 返回 taskId
  ↓
Main Agent 继续执行 (可以同时做其他事)
  ↓ (每次迭代)
Main Agent 调用 poll(taskId) → 检查是否完成
  ↓
获取结果 → 合成最终答案
```

## 子代理类型

```ts
interface SubAgentDefinition {
  /** 唯一名称 */
  name: string

  /** 功能描述 (供 LLM 决策) */
  description: string

  /** 系统提示词 */
  systemPrompt: string

  /** 可用工具 (工具名称数组) */
  tools?: string[]

  /** 可用 Skill 名称 */
  skills?: string[]
}

interface SubAgentResult {
  taskId: string
  agentName: string
  status: SubAgentStatus
  answer?: string
  error?: string
  iterations: number
  tokensUsed: number
}

enum SubAgentStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
```

## 工具过滤

框架使用 [工具过滤器](/tools/filters) 为每个子代理自动创建受限的工具注册表：

```ts
// 子代理只能使用 ReadFileTool 和 GrepSearchTool
{
  name: 'code-reviewer',
  tools: ['ReadFileTool', 'GrepSearchTool'],
}
// 框架内部: registry.forSubAgent(allowlist('ReadFileTool', 'GrepSearchTool'))
```

## 完整示例

```ts
import {
  OrchestratorAgent,
  AnthropicProvider,
  OpenAIProvider,
  ModelRouter,
  BUILTIN_TOOLS,
} from 'kagent-ts'

const agent = new OrchestratorAgent({
  systemPrompt: '你是一个项目管理专家，可以分解并委派任务给专业的子代理。',
  provider: new ModelRouter({
    routes: {
      main: new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-6' }),
      subAgent: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o-mini' }),
    },
  }),
  tools: BUILTIN_TOOLS,
  subAgents: [
    {
      name: 'code-reviewer',
      description: '审查代码质量，发现潜在问题',
      systemPrompt: '你是 TypeScript 代码审查专家...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'GlobSearchTool'],
    },
    {
      name: 'test-writer',
      description: '编写单元测试',
      systemPrompt: '你是测试开发专家，擅长编写高质量测试...',
      tools: ['ReadFileTool', 'GrepSearchTool', 'WriteFileTool'],
    },
    {
      name: 'doc-writer',
      description: '生成 API 文档',
      systemPrompt: '你是技术文档写作专家...',
      tools: ['ReadFileTool', 'WriteFileTool'],
    },
  ],
  maxRounds: 3,
  maxParallelNodes: 3,
})

const report = await agent.run(
  '审查 src/ 下的代码质量，为缺少测试的核心模块编写测试，然后更新 README。'
)
```

## 下一步

- [Orchestrator Agent](/core/orchestrator-agent) — 多代理编排
- [MCP 协议](/advanced/mcp) — 连接外部 MCP Server
- [工具过滤器](/tools/filters) — 为子代理限制工具访问
