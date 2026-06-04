/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Users define MCP servers via `McpServerConfig`. The framework
 * connects, discovers tools, adapts them, and registers with ToolRegistry.
 */

/**
 * Configuration for connecting to an MCP server.
 *
 * Two mutually exclusive modes:
 * - stdio: set `command` (optionally `args` and `env`)
 * - SSE:   set `url`
 *
 * @example
 * ```ts
 * // stdio: local filesystem server
 * { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }
 *
 * // SSE: remote server
 * { url: "http://localhost:3001/sse" }
 * ```
 */
export interface McpServerConfig {
  /** Command for stdio transport (e.g., "npx", "uvx"). Exclusive with `url`. */
  command?: string;
  /** Arguments passed to the stdio command. */
  args?: string[];
  /** Environment variables injected into the stdio process. */
  env?: Record<string, string>;
  /**
   * URL for SSE transport (e.g., "http://localhost:3000/sse").
   * Exclusive with `command`.
   */
  url?: string;
}

/**
 * Snapshot of a single MCP server's connection state.
 */
export interface McpConnectionStatus {
  serverName: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Report from a failed connection attempt.
 */
export interface McpConnectionErrorReport {
  serverName: string;
  error: string;
}

/**
 * Specialized error for MCP connection/issues.
 */
export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}
