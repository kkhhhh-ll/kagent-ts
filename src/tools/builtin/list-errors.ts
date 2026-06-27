import { Tool } from "../types";
import type { ToolRegistry } from "../tool-registry";

/**
 * Factory: create a `list_errors` tool bound to a ToolRegistry instance.
 */
export function createListErrorsTool(registry: ToolRegistry): Tool {
  return {
    name: "list_errors",
    description:
      "List recent tool errors and their status. " +
      "Use this before retrying a failed tool to check known failure patterns, " +
      "or to see which tools have been disabled by the circuit breaker.",
    parameters: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "Optional: filter errors by a specific tool name.",
        },
        unresolved_only: {
          type: "boolean",
          description: "If true, only show unresolved errors. Default: false.",
        },
      },
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const toolName = params.tool_name as string | undefined;
      const unresolvedOnly = params.unresolved_only as boolean | undefined;

      const tracker = registry.getErrorTracker();
      if (!tracker) {
        return "Error tracker is not configured. Set `toolErrorTracker` in AgentConfig to enable.";
      }

      const summaries = tracker.getAllSummaries();
      const filtered = summaries.filter((s) => {
        if (toolName && s.toolName !== toolName) return false;
        if (unresolvedOnly && s.resolved) return false;
        return true;
      });

      if (filtered.length === 0) {
        return "No error traces found" +
          (toolName ? ` for tool "${toolName}"` : "") +
          (unresolvedOnly ? " (unresolved)" : "") +
          ".";
      }

      const lines = [
        `Found ${filtered.length} error trace(s):`,
        "",
      ];

      for (const s of filtered) {
        const status = s.resolved ? "✅ resolved" : "❌ unresolved";
        lines.push(`- **${s.toolName}** [${s.traceId}] ${status}`);
        lines.push(`  First error: ${s.firstError || "(none)"}`);
        lines.push(`  Attempts: ${s.errorCount}`);
        if (s.resolution) lines.push(`  Resolution: ${s.resolution}`);
        lines.push("");
      }

      return lines.join("\n");
    },
  };
}
