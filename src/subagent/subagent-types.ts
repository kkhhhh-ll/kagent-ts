import type { ToolFilter } from "../tools/tool-filter";

/**
 * SubAgent type definitions.
 *
 * Sub-agents are lightweight ReAct agents that the main agent can spawn
 * on demand. Each sub-agent is defined by a `.md` file with frontmatter
 * declaring its name, description, available tools, and skills.
 */

/**
 * Declarative definition of a sub-agent, read from an AGENT.md file
 * or constructed programmatically.
 */
export interface SubAgentDefinition {
  /** Unique identifier (used as the spawn target name). */
  name: string;
  /** Human-readable description shown to the main agent's LLM. */
  description: string;
  /** System prompt content (body of the AGENT.md file). */
  systemPrompt: string;
  /**
   * Tool name patterns from the main agent's ToolRegistry that this sub-agent
   * can use.
   *
   * Supports two forms:
   * - **Exact names**: `"echo"`, `"bash"` — matches a single tool by name.
   * - **Wildcard patterns**: `"filesystem_*"` — matches all tools whose names
   *   match the glob (e.g. all MCP tools from the "filesystem" server).
   *   Only `*` is supported (matches any sequence of characters).
   *
   * When `toolFilter` is also provided, the filter is applied on top of this
   * allowlist (both must pass).
   */
  tools: string[];
  /**
   * Optional ToolFilter for finer-grained control over which tools the
   * sub-agent can access. Applied AFTER the `tools` allowlist.
   * Use built-in factories like `allowlist()`, `denylist()`, `pattern()`,
   * or combine with `all()` / `any()`.
   */
  toolFilter?: ToolFilter;
  /** Skill names to activate when the sub-agent starts. */
  skills: string[];
}

/**
 * Runtime status of a spawned sub-agent.
 */
export type SubAgentStatus = "running" | "completed" | "error";

/**
 * Result returned when a sub-agent completes.
 */
export interface SubAgentResult {
  /** Unique run ID (generated at spawn time). */
  subAgentId: string;
  /** Sub-agent definition name. */
  name: string;
  /** Whether the run completed without error. */
  success: boolean;
  /** The final output (answer text or error message). */
  output: string;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

/**
 * Pending sub-agent run — stored internally while the
 * sub-agent is executing asynchronously.
 */
export interface PendingRun {
  subAgentId: string;
  name: string;
  startedAt: number;
  promise: Promise<SubAgentResult>;
  /** Set to the result once the promise resolves. */
  resolved: SubAgentResult | null;
  /** Whether this run was interrupted by user cancellation. */
  cancelled?: boolean;
}
