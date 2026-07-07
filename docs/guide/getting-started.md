# 快速开始

本指南将帮助你在几分钟内上手 kagent-ts。

## 环境要求

- **Node.js** >= 18.0.0
- **TypeScript** >= 5.7 (如使用 TypeScript)

## 安装

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

## 最小示例

创建一个 `demo.ts` 文件：

```ts
import { ReActAgent, OpenAIProvider } from 'kagent-ts'

async function main() {
  // 1. 创建 LLM Provider
  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
  })

  // 2. 创建 Agent
  const agent = new ReActAgent({
    systemPrompt: '你是一个乐于助人的 AI 助手。回答问题时请简洁明了。',
    llm: provider,
    tools: [],
    maxIterations: 10,
  })

  // 3. 运行 Agent
  const answer = await agent.run('请用三句话介绍 TypeScript。')
  console.log('回答:', answer)
}

main().catch(console.error)
```

运行：

```bash
npx tsx demo.ts
```

## 下一步

- 了解 [安装与配置](/guide/installation) 的更多细节
- 探索 [核心概念](/core/overview) 理解 Agent 的运作方式
- 查看 [LLM 后端](/llm/overview) 了解如何切换和配置不同的 LLM Provider
- 浏览 [工具系统](/tools/overview) 学习如何使用和自定义工具
- 配置 [RAG 知识库](/advanced/rag) 让 Agent 基于本地文档进行语义检索
