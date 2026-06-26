# 参数验证

kagent-ts 使用 JSON Schema (基于 AJV) 对工具参数进行**执行前**验证，防止 LLM 传递不合法参数。

## 工作原理

```
LLM 输出 tool_call(args)
  ↓
ToolRegistry.execute()
  ↓
validateToolArgs(tool, args)  ← AJV JSON Schema 验证
  ├── 通过 → 执行 tool.execute(args)
  └── 失败 → 返回 VALIDATION_ERROR + 详细错误信息
```

## 定义参数 Schema

在工具的 `parameters` 字段中定义 JSON Schema：

```ts
const myTool: Tool = {
  name: 'create_file',
  description: '创建文件并写入内容',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径',
        minLength: 1,
      },
      content: {
        type: 'string',
        description: '文件内容',
      },
      overwrite: {
        type: 'boolean',
        description: '是否覆盖已有文件',
        default: false,
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(args) {
    // args 已经通过验证
    // ...
  },
}
```

## 验证缓存

框架会缓存每个工具的 AJV 验证器，避免重复编译 Schema：

```
首次调用 → 编译 JSON Schema → 缓存
后续调用 → 从缓存获取 → 验证
```

## 验证失败示例

当 LLM 传递了不合法的参数时：

```
工具 create_file 返回错误:
[VALIDATION_ERROR] 参数验证失败:
- /path: must NOT have fewer than 1 characters
- /content: must be string
```

LLM 会收到详细的验证错误信息，帮助它修正参数。

## 复杂 Schema

支持所有 JSON Schema 特性：

```ts
parameters: {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['read', 'write', 'append'],  // 枚举
    },
    level: {
      type: 'integer',
      minimum: 1,
      maximum: 10,                          // 数值范围
    },
    pattern: {
      type: 'string',
      pattern: '^[a-zA-Z0-9_]+$',           // 正则
    },
    tags: {
      type: 'array',
      items: { type: 'string' },             // 数组
      maxItems: 10,
    },
    options: {
      type: 'object',
      properties: {                          // 嵌套对象
        recursive: { type: 'boolean' },
        maxDepth: { type: 'integer' },
      },
    },
  },
  required: ['mode'],
}
```

## 与审批集成

参数验证在审批**之后**执行：

1. `onToolApproval()` → 用户审批
2. `validateToolArgs()` → 参数验证
3. `tool.execute()` → 实际执行

## 下一步

- [Circuit Breaker](/tools/circuit-breaker) — 熔断保护
- [工具过滤器](/tools/filters) — 为子代理筛选工具
- [HITL 审批](/tools/approval) — 人工审批工具调用
