import { ToolRegistry } from "../tools/tool-registry";
import { Tool } from "../tools/types";
import {
  McpServerConfig,
  McpConnectionStatus,
  McpConnectionErrorReport,
  McpConnectionError,
} from "./mcp-types";

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

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
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

    try {
      await client.connect(transport);
    } catch (err) {
      throw new McpConnectionError(
        `Failed to connect to MCP server "${serverName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Discover tools
    let mcpToolDescriptors: MCPToolDescriptor[];
    try {
      const result = await client.listTools();
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
      const adapted = this.adaptTool(serverName, mcpTool, client);
      if (this.toolRegistry.has(adapted.name)) {
        console.warn(
          `[MCP] Tool "${adapted.name}" is already registered. ` +
          `Skipping MCP tool "${serverName}/${mcpTool.name}".`,
        );
        continue;
      }
      adaptedTools.push(adapted);
    }

    if (adaptedTools.length === 0) {
      console.warn(`[MCP] Server "${serverName}" exposed no usable tools.`);
    } else {
      this.toolRegistry.registerMany(adaptedTools);
      console.log(`[MCP] Registered ${adaptedTools.length} tool(s) from server "${serverName}".`);
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
          console.error(`[MCP] Failed to connect to server "${name}": ${message}`);
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

    // Unregister tools
    for (const tool of conn.tools) {
      this.toolRegistry.remove(tool.name);
    }

    // Close the client
    try {
      await conn.client.close();
    } catch (err) {
      console.warn(
        `[MCP] Error while closing connection to "${serverName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.connections.delete(serverName);
    console.log(`[MCP] Disconnected from server "${serverName}".`);
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
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });

          // MCP results carry an array of content items (text, image, etc.)
          let output = "(MCP tool returned no content)";
          if (result.content && Array.isArray(result.content)) {
            const textParts = result.content
              .map((c: any) => (c.text ? c.text : JSON.stringify(c)))
              .filter(Boolean);
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
