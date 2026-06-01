# KAgent-TS

A TypeScript agent framework for building LLM-powered applications with structured agent loops, tool management, session persistence, and user preference injection.

## Features

- **Agent Loop Paradigms** — Base `Agent` + `ReActAgent` (Thought → Action → Observation → Final) + `PlanSolveAgent` (Plan → Resolve → Revise → Final)
- **LLM Integration** — OpenAI provider with automatic retry (exponential backoff + jitter) and network error classification
- **Tool System** — `ToolRegistry` with circuit breaker (automatic disable after threshold) and structured error tracking
- **Context Management** — Automatic token tracking, threshold-based compression with sliding window
- **Session Persistence** — Checkpoint-and-resume: auto-save on network error, graceful discard on abort (SIGINT)
- **User Preferences** — Plain-text Markdown file (`key: value`), injected into system prompt, auto-reloaded on file change
- **Skills** — Progressive disclosure: skills auto-detect from user input and load on demand
- **Built-in Tools** — Read file, write file, edit file, grep search, glob search

## Installation

```bash
npm install kagent-ts
```

## Quick Start

```typescript
import { ReActAgent, OpenAIProvider, Tool } from "kagent-ts";

// 1. Create an LLM provider
const llm = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
});

// 2. Define a tool
const calculator: Tool = {
  name: "calculator",
  description: "Perform a mathematical calculation",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The mathematical expression to evaluate",
      },
    },
    required: ["expression"],
  },
  async execute(args) {
    const { expression } = args as { expression: string };
    return String(eval(expression));
  },
};

// 3. Create the agent
const agent = new ReActAgent({ llm, tools: [calculator] });

// 4. Run
const response = await agent.run("What is 25 * 4 + 10?");
console.log(response);
```

## Architecture

```
src/
├── core/                 # Agent classes: Agent, ReActAgent, PlanSolveAgent
├── llm/                  # LLM provider interface + OpenAI implementation
├── messages/             # Message types and builder class
├── context/              # Context window management (token tracking)
├── compression/          # Compression strategies (sliding window)
├── session/              # Session checkpoint persistence & resume
├── preferences/          # User preferences (Markdown file, auto-reload)
├── skills/               # Progressive disclosure skill system
├── tools/                # Tool registry, circuit breaker, error tracker
│   └── builtin/          # Built-in file tools (read, write, edit, grep, glob)
├── utils/                # Token counting utilities
└── index.ts              # Public API exports
```

## Agent Paradigms

### ReActAgent

The classic Thought → Action → Observation loop with tool-call support:

```typescript
import { ReActAgent } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  tools: [myTool],
  systemPrompt: "You are a helpful assistant.",
  maxIterations: 10,
});
const response = await agent.run("Search for the latest news.");
```

### PlanSolveAgent

Plan → Resolve → Revise loop for complex multi-step tasks:

```typescript
import { PlanSolveAgent } from "kagent-ts";

const agent = new PlanSolveAgent({
  llm,
  tools: [searchTool, calculatorTool],
  maxIterations: 15,
  maxPlanSteps: 12,
  replanThreshold: 2,  // auto-suggest replan after 2 consecutive failures
});
const response = await agent.run("Analyze Q3 financial data and generate a report.");
```

The agent will:
1. Create a detailed plan
2. Execute each step with tools
3. Revise the plan mid-execution if obstacles occur
4. Deliver the final answer

## LLM & Network Resilience

The OpenAI provider includes built-in retry logic:

```typescript
const llm = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o",
  retry: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
});
```

- **Retryable errors**: timeout, connection refused/reset, DNS failure, HTTP 429 (rate limit), HTTP 5xx (server error)
- **Permanent errors**: HTTP 401 (auth), HTTP 400 (bad request), abort signal — propagate immediately
- On retry exhaustion → throws `LLMNetworkError` with `cause` field for agent-level handling

## Tool System

### ToolRegistry + Circuit Breaker

Tools can be registered with automatic failure detection and circuit breaking:

```typescript
import { ToolRegistry } from "kagent-ts";

const registry = new ToolRegistry({
  breakerConfig: {
    failureThreshold: 5,       // disable after 5 consecutive failures
    cooldownMs: 60000,         // re-enable after 60s
    halfOpenMaxRetries: 2,
  },
});

registry.register(calculatorTool);
const result = await registry.execute("calculator", { expression: "2+2" });
```

States: `CLOSED` (normal) → `OPEN` (disabled) → `HALF_OPEN` (probing) → `CLOSED` (recovered).

### Error Tracking

Track full tool failure chains with LLM analysis:

```typescript
const report = agent.generateErrorReport();
// Generates a structured markdown report of all tool failures,
// including LLM analysis of root cause and recovery steps.
```

### Built-in Tools

```typescript
import { registerAllBuiltinTools, ReadFileTool, WriteFileTool } from "kagent-ts";

// Register individually
const agent = new ReActAgent({
  llm,
  tools: [...registerAllBuiltinTools()],
});

// Or add at runtime
agent.addTool(new ReadFileTool());
agent.addTool(new WriteFileTool());
```

Available: `ReadFileTool`, `WriteFileTool`, `EditFileTool`, `GrepSearchTool`, `GlobSearchTool`.

## Session Persistence & Network Recovery

The agent can checkpoint its state mid-run and resume after disconnection:

```typescript
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  sessionId: "my-session",
  enableCheckpointing: true,
});

// Normal execution — auto-saves after each LLM+tools cycle.
// On network error: saves "interrupted" checkpoint, returns resume instructions.
const result = await agent.run("Do something...");

// After network is restored:
const resumed = await agent.resume("my-session", "continue");
```

When the user aborts (SIGINT / `agent.cancel()`), the checkpoint is discarded — no stale state persists.

## User Preferences

Preferences are stored as a Markdown file (`.kagent/preferences.md` by default) and injected into the system prompt as a `=== User Preferences ===` section. File changes are auto-detected each loop iteration.

```markdown
# User Preferences

codeStyle: Use TypeScript with functional style. Prefer interfaces.
language: Always respond in Chinese.
forbidden: Never use `any` type. Avoid mutating function parameters.
```

```typescript
// Via constructor
const agent = new ReActAgent({
  llm,
  tools: [myTool],
  preferences: {
    codeStyle: "Use TypeScript with functional style.",
    language: "Always respond in Chinese.",
  },
});

// With file persistence
import { PreferenceManager } from "kagent-ts";

const agent = new ReActAgent({
  llm,
  tools: [myTool],
  preferenceManager: new PreferenceManager(),
});

// Runtime CRUD (auto-persists if PreferenceManager configured)
agent.setPreference("codeStyle", "Use TypeScript with functional style.");
agent.getPreference("language");   // "Always respond in Chinese."
agent.removePreference("forbidden");
agent.clearPreferences();

// The LLM sees this in every system prompt:
// === User Preferences ===
//   - codeStyle: Use TypeScript with functional style.
//   - language: Always respond in Chinese.
```

### File Format

`preferences.md` uses simple `key: value` lines. Lines starting with `#` are comments:

```markdown
# User Preferences

codeStyle: Use TypeScript with functional style.
replyLanguage: Always respond in Chinese.
# This is a comment — ignored when loaded.
```

Manually edit the file while the agent is running — changes are auto-detected before the next LLM call.

## Skills (Progressive Disclosure)

Skills provide domain-specific knowledge and tools that load on demand. Skills are defined as file-based directories, making them easy to author and share.

### Directory Structure

```
skills/
├── sql/
│   ├── SKILL.md              # Frontmatter (metadata) + system prompt body
│   ├── reference/            # Reference docs loaded on activation
│   │   └── cheatsheet.md
│   └── scripts/              # Executable scripts registered as tools
│       └── format_sql.sh
├── git/
│   ├── SKILL.md
│   └── scripts/
│       └── list_branches.sh
└── ...
```

### SKILL.md Format

```markdown
---
name: sql
description: SQL query writing and optimization
keywords: sql, query, database, select, join
---

You are an expert in SQL. Write efficient queries, use appropriate indexes, and consider EXPLAIN plans.
```

### Usage

Point the agent to your `skills/` directory — skills are auto-discovered and lazily loaded:

```typescript
import { ReActAgent, OpenAIProvider } from "kagent-ts";

const agent = new ReActAgent({
  llm: provider,
  tools: myTools,
  skillsDir: "./skills",  // Auto-discover file-based skills
});

// Manual activation
agent.activateSkill("sql");

// Or rely on auto-detection: when user input contains matching
// keywords (e.g., "write a SQL query"), the skill activates automatically.
const response = await agent.run("Write a query to find top 10 customers by revenue.");
```

### Skill Components

| Component | Location | Behavior |
|-----------|----------|----------|
| **Metadata** | SKILL.md frontmatter (`---`) | Registered on scan — name, description, keywords |
| **System Prompt** | SKILL.md body | Loaded on activation — injected into the agent's system prompt |
| **Reference Docs** | `reference/*.md`, `*.txt` | Appended to system prompt on activation, with `[Reference: filename]` headers |
| **Scripts** | `scripts/*.sh`, `.py`, `.js`, `.bat` | Registered as executable `Tool` objects on activation, named `{skillName}_{scriptName}` |

### Supported Script Types

| Extension | Interpreter | Platform |
|-----------|-------------|----------|
| `.sh` | `bash` | Linux/macOS/WSL |
| `.bat` / `.cmd` | `cmd.exe /c` | Windows |
| `.ps1` | `powershell.exe -File` | Windows |
| `.js` | `node` | Cross-platform |
| `.py` | `python3` / `python` | Cross-platform |

Each script becomes a Tool that accepts a single `args: string` parameter, passed as CLI arguments to the script.

## Context Management

Automatic token tracking with configurable thresholds:

```typescript
import { ContextManager } from "kagent-ts";

const ctx = new ContextManager({
  maxTokens: 128000,
  compressionThresholdRatio: 0.75,  // compress at 75% capacity
  compressionRatio: 0.5,            // remove 50% of messages on compress
});
```

## Compression

Sliding window strategy keeps the most recent messages:

```typescript
import { SlidingWindowCompression } from "kagent-ts";

const compressor = new SlidingWindowCompression({
  keepLastN: 20,
  keepSystemMessages: true,
});

const result = compressor.compress(messages, systemPrompt);
// result.messages — compressed list
// result.removedCount — how many were removed
```

## Message API

```typescript
import { Message } from "kagent-ts";

Message.user("Hello");
Message.system("You are a helpful assistant.");
Message.assistant("Hi there!");
Message.tool("Result", "call_123", "calculator");

msg.toDict();      // { role: "user", content: "Hello" }
msg.toJSON();      // JSON string
Message.fromJSON(json);  // Deserialize
Message.fromJSONBulk(array); // Deserialize array
```

## License

MIT
