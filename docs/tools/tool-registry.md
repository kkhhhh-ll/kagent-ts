# Tool Registry

`ToolRegistry` 是工具系统的核心，负责工具的注册、查找、过滤和执行。

## 基本用法

### 直接使用内置工具

```ts
import { ReActAgent, OpenAIProvider, BUILTIN_TOOLS } from 'kagent-ts'

const agent = new ReActAgent({
  systemPrompt: '你是一个有用的 AI 助手。',
  llm: new OpenAIProvider({ apiKey: '...', model: 'gpt-4o' }),
  tools: BUILTIN_TOOLS,
})
```

### 手动注册工具

```ts
import { ToolRegistry } from 'kagent-ts'

const registry = new ToolRegistry()

// 注册单个工具
registry.register(myCustomTool)

// 批量注册
registry.registerMany([tool1, tool2, tool3])

const agent = new ReActAgent({
  systemPrompt: '...',
  llm: provider,
  tools: registry.getTools(),  // 获取所有已注册的工具
})
```

## 核心方法

```ts
class ToolRegistry {
  /** 注册一个工具 */
  register(tool: Tool): void

  /** 批量注册 */
  registerMany(tools: Tool[]): void

  /** 按名称查找工具 */
  getTool(name: string): Tool | undefined

  /** 获取所有工具 */
  getTools(): Tool[]

  /** 检查工具是否已注册 */
  has(name: string): boolean

  /** 移除工具 */
  remove(name: string): boolean

  /** 批量移除工具 */
  removeMany(names: string[]): void

  /** 执行工具 (带熔断保护) */
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>

  /** 创建子代理的过滤 Registry */
  filter(filter: ToolFilter): ToolRegistry
}
```

## 自定义工具

实现 `Tool` 接口创建自定义工具：

```ts
import type { Tool } from 'kagent-ts'

const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取指定城市的天气信息',
  parameters: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: '城市名称',
      },
    },
    required: ['city'],
  },

  async execute(args) {
    const city = args.city as string
    // 实际的 API 调用
    const weather = await fetchWeatherAPI(city)
    return `${city}天气: ${weather.temp}°C, ${weather.desc}`
  },
}
```

## 为子代理过滤工具

```ts
import { allowlist } from 'kagent-ts'

// 创建只读工具的子代理 Registry
const readonlyRegistry = registry.filter(
  allowlist('read_file', 'grep_search', 'glob_search')
)
```

详见 [工具过滤器](/tools/filters)。

## 下一步

- [Circuit Breaker](/tools/circuit-breaker) — 熔断保护
- [参数验证](/tools/validation) — JSON Schema 校验
- [内置工具](/tools/builtin-tools) — 所有内置工具说明
