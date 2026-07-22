# 安装

## 环境要求

|------|------|

## 安装 kagent-ts

::: code-group
```bash [npm]
npm install kagent-ts
```

```bash [pnpm]
pnpm add kagent-ts
```

```bash [yarn]
yarn add kagent-ts
```
:::

## 可选依赖

### tiktoken (精确 Token 计数)

kagent-ts 默认使用启发式算法估算 Token 数量（4 字符 ≈ 1 Token）。安装 `tiktoken` 可以获得精确的 Token 计数：

```bash
npm install tiktoken
```

当 `tiktoken` 可用时，`countTokens()` 会自动使用它进行精确计算；否则回退到启发式算法。

## 导入方式

kagent-ts 支持 ES Module 和 CommonJS 两种导入方式：

```ts
// ES Module
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

// CommonJS
const { ReActAgent, OpenAIProvider } = require('kagent-ts')
```

## TypeScript 支持

kagent-ts 是 TypeScript 原生编写的，类型声明文件随包发布。你无需额外安装 `@types/kagent-ts`。

```ts
// 开箱即用的类型支持
import type { AgentConfig, Tool, LLMProvider } from 'kagent-ts'
```

## 验证安装

```ts
import { ReActAgent, PlanSolveAgent, FusionAgent, OrchestratorAgent } from 'kagent-ts'

console.log('kagent-ts 安装成功！')
console.log('可用 Agent 类型:', {
  ReActAgent: typeof ReActAgent,
  PlanSolveAgent: typeof PlanSolveAgent,
  FusionAgent: typeof FusionAgent,
  OrchestratorAgent: typeof OrchestratorAgent,
})
```

## 下一步

- 继续阅读 [配置指南](/guide/configuration) 了解详细的配置选项
- 前往 [核心概念](/core/overview) 理解框架的设计理念
