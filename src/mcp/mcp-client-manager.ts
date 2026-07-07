import { ToolRegistry } from "../tools/tool-registry";
import { Tool } from "../tools/types";
import {
  McpServerConfig,
  McpConnectionStatus,
  McpConnectionErrorReport,
  McpConnectionError,
} from "./mcp-types";
import { Logger, ConsoleLogger } from "../logging/logger";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// ─── Config resolver ────────────────────────────────────────────────────────

function resolveTransportConfig(config: McpServerConfig):
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string } {
  if (config.command && config.url) {
    throw new McpConnectionError(
      "MCP server config must specify either 'command' (stdio) or 'url' (SSE), not both.",
    );
  }
  if (config.command) {
    return { type: "stdio", command: config.command, args: config.args, env: config.env };
  }
  if (config.url) {
    return { type: "sse", url: config.url };
  }
  throw new McpConnectionError(
    "MCP server config must specify either 'command' (stdio) or 'url' (SSE).",
  );
}

// ─── Internal connection state ──────────────────────────────────────────────

interface McpServerConnection {
  serverName: string;
  client: Client;
  tools: Tool[];
}

/**
 * Manages connections to MCP (Model Context Protocol) servers.
 *
 * Lifecycle:
 * 1. `connectToServer()` / `connectAll()` — connect, discover tools,
 *    register adapted tools in ToolRegistry
 * 2. Tools execute via the adapted `Tool` wrapper (delegates to MCP client)
 * 3. `disconnect()` / `disconnectAll()` — unregister tools, close connections
 */
export class McpClientManager {
  /** Active connections keyed by server name. */
  private connections: Map<string, McpServerConnection> = new Map();

  /** The ToolRegistry where adapted tools are registered. */
  private toolRegistry: ToolRegistry;
  private logger: Logger;

  /**
   * Timeout (ms) for individual MCP server connection (connect + listTools).
   * Covers transport.start() which is NOT covered by the SDK's RequestOptions.timeout.
   */
  private connectTimeoutMs: number;

  /**
   * Timeout (ms) for individual MCP tool calls.
   * Uses the SDK's built-in RequestOptions.timeout mechanism.
   */
  private toolTimeoutMs: number;

  constructor(toolRegistry: ToolRegistry, logger?: Logger, options?: {
    connectTimeoutMs?: number;
    toolTimeoutMs?: number;
  }) {
    this.toolRegistry = toolRegistry;
    this.logger = logger ?? new ConsoleLogger();
    this.connectTimeoutMs = options?.connectTimeoutMs ?? 15_000;
    this.toolTimeoutMs = options?.toolTimeoutMs ?? 30_000;
  }

  // ─── Connection Management ────────────────────────────────────────────────

  /**
   * Connect to a single MCP server, discover its tools, and register them
   * in the ToolRegistry with a `{serverName}_` prefix.
   *
   * Idempotent — if the server is already connected, this is a no-op.
   *
   * @throws McpConnectionError if the config is invalid or the
   *         connection/tool-discovery fails (only for new connections).
   */
  async connectToServer(serverName: string, config: McpServerConfig): Promise<void> {
    if (this.connections.has(serverName)) {
      return; // Already connected — idempotent
    }

    const transportConfig = resolveTransportConfig(config);

    // Build transport
    let transport: StdioClientTransport | SSEClientTransport;
    if (transportConfig.type === "stdio") {
      transport = new StdioClientTransport({
        command: transportConfig.command,
        args: transportConfig.args,
        env: transportConfig.env,
      });
    } else {
      transport = new SSEClientTransport(new URL(transportConfig.url));
    }

    // Create client and connect
    const client = new Client(
      { name: "kagent-ts", version: "0.1.3" },
      { capabilities: {} },
    );

      // The SDK's RequestOptions.timeout only covers the JSON-RPC init
      // handshake, NOT transport.start() (child-process spawn / SSE open).
      // Promise.race acts as an outer safety net for the full connect flow.
      // timeoutPromise has .catch(() => {}) to swallow late rejections that
      // fire after connect() already won the race (avoids unhandled rejection).
      const ac = new AbortController();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(
          new McpConnectionError(
            `Timed out connecting to MCP server "${serverName}" after ${this.connectTimeoutMs}ms`,
          ),
        ), this.connectTimeoutMs);
      });
      // Prevent unhandled rejection when connect() wins the race
      timeoutPromise.catch(() => {});

      try {
        await Promise.race([
          client.connect(transport, { signal: ac.signal, timeout: this.connectTimeoutMs }),
          timeoutPromise,
        ]);
      } catch (err) {
        // On timeout or failure, abort the signal first to inform the SDK
        // that the operation should be cancelled immediately, then close
        // the underlying connection to prevent resource leaks (orphaned
        // child processes, dangling SSE sockets).
        ac.abort();
        await client.close().catch(() => {});
        throw new McpConnectionError(
          `Failed to connect to MCP server "${serverName}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        clearTimeout(timer);
      }

    // Discover tools — SDK's RequestOptions.timeout protects this call
    let mcpToolDescriptors: MCPToolDescriptor[];
    try {
      const result = await client.listTools(undefined, { timeout: this.connectTimeoutMs });
      mcpToolDescriptors = result.tools as MCPToolDescriptor[];
    } catch (err) {
      await client.close().catch(() => {});
      throw new McpConnectionError(
        `Failed to list tools from MCP server "${serverName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Adapt and register tools
    const adaptedTools: Tool[] = [];
    for (const mcpTool of mcpToolDescriptors) {
      // Check for name collision before creating the closure in adaptTool()
      const prefixedName = `${serverName}_${mcpTool.name}`;
      if (this.toolRegistry.has(prefixedName)) {
        this.logger.warn(
          "MCP",
          `Tool "${prefixedName}" is already registered. ` +
          `Skipping MCP tool "${serverName}/${mcpTool.name}".`,
        );
        continue;
      }
      const adapted = this.adaptTool(serverName, mcpTool, client);
      adaptedTools.push(adapted);
    }

    if (adaptedTools.length === 0) {
      this.logger.warn("MCP", `Server "${serverName}" exposed no usable tools.`);
    } else {
      this.toolRegistry.registerMany(adaptedTools);
      this.logger.info("MCP", `Registered ${adaptedTools.length} tool(s) from server "${serverName}".`);
    }

    this.connections.set(serverName, { serverName, client, tools: adaptedTools });
  }

  /**
   * Connect to multiple MCP servers. Failures for individual servers are
   * collected and logged; other servers still connect.
   *
   * @returns An array of connection error reports (empty if all succeeded).
   */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<McpConnectionErrorReport[]> {
    const errors: McpConnectionErrorReport[] = [];

    await Promise.allSettled(
      Object.entries(servers).map(async ([name, config]) => {
        try {
          await this.connectToServer(name, config);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ serverName: name, error: message });
          this.logger.error("MCP", `Failed to connect to server "${name}": ${message}`);
        }
      }),
    );

    return errors;
  }

  /**
   * Disconnect from a single server and unregister its tools.
   */
  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    // Unregister tools in batch (single pass through the map)
    this.toolRegistry.removeMany(conn.tools.map((t) => t.name));

    // Close the client
    try {
      await conn.client.close();
    } catch (err) {
      this.logger.warn(
        "MCP",
        `Error while closing connection to "${serverName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.connections.delete(serverName);
    this.logger.info("MCP", `Disconnected from server "${serverName}".`);
  }

  /**
   * Disconnect from all MCP servers and unregister all MCP-provided tools.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * Check if a specific server is currently connected.
   */
  hasServer(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  /**
   * Get connection status for all servers.
   */
  getStatus(): McpConnectionStatus[] {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      serverName: name,
      connected: true,
      toolCount: conn.tools.length,
    }));
  }

  /**
   * Whether at least one server is connected.
   */
  get isConnected(): boolean {
    return this.connections.size > 0;
  }

  /**
   * Get the number of connected servers.
   */
  get connectedCount(): number {
    return this.connections.size;
  }

  // ─── Tool Adapter ─────────────────────────────────────────────────────────

  /**
   * Adapt an MCP SDK tool descriptor into the framework's Tool interface.
   *
   * The adapted tool's name is `{serverName}_{mcpToolName}` to avoid
   * collisions between servers and with locally-registered tools.
   *
   * The `execute` function closes over the client instance and handles
   * result content parsing (extracting text from MCP's Content[] array).
   */
  private adaptTool(
    serverName: string,
    mcpTool: MCPToolDescriptor,
    client: Client,
  ): Tool {
    const prefixedName = `${serverName}_${mcpTool.name}`;

    return {
      name: prefixedName,
      description: mcpTool.description ?? "",
      parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,

      execute: async (args: Record<string, unknown>): Promise<string> => {
        // Check connection is still alive
        if (!this.connections.has(serverName)) {
          return `Error: MCP server "${serverName}" is no longer connected. Tool "${prefixedName}" is unavailable.`;
        }

        try {
          const result = await client.callTool(
            {
              name: mcpTool.name,
              arguments: args,
            },
            undefined,
            { timeout: this.toolTimeoutMs },
          );

          // MCP results carry an array of content items (text, image, etc.)
          // Extract text parts in a single pass — skip non-text blobs
          // instead of JSON.stringify-ing them (expensive and useless for e.g. images).
          let output = "(MCP tool returned no content)";
          if (result.content && Array.isArray(result.content)) {
            const textParts: string[] = [];
            for (const c of result.content) {
              if (c && typeof c === "object" && "text" in c && typeof (c as any).text === "string") {
                textParts.push((c as any).text as string);
              }
            }
            if (textParts.length > 0) {
              output = textParts.join("\n");
            }
          }

          // Prefix with "Error:" so the framework's circuit-breaker /
          // retry-guidance path handles it correctly.
          if (result.isError) {
            return `Error: ${output}`;
          }
          return output;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return `Error executing MCP tool "${serverName}/${mcpTool.name}": ${message}`;
        }
      },
    };
  }
}

// ─── Internal type (matches MCP SDK's tool shape) ───────────────────────────

interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
