import { Tool } from "../types";
import type { Agent } from "../../core/agent";
import type { SubAgentManager } from "../../subagent/subagent-manager";

/**
 * Factory: create a `fork_agent` tool bound to the parent Agent and
 * optionally a SubAgentManager (for async mode).
 *
 * ## Modes
 *
 * | `async` | Behavior |
 * |---------|----------|
 * | `false` (default) | Sync: fork runs inline, result returned directly |
 * | `true`            | Async: fork runs in background via SubAgentManager, run ID returned |
 *
 * Async mode requires SubAgentManager to be configured (via `subAgentsDir`).
 * If not available, `async: true` falls back to sync execution with a warning.
 */
export function createForkAgentTool(
  parent: Agent,
  subAgentManager?: SubAgentManager,
): Tool {
  return {
    name: "fork_agent",
    description:
      "Fork a lightweight sub-agent for a self-contained task. " +
      "The fork inherits the full conversation context from the main agent. " +
      "By default runs synchronously — the result is returned directly. " +
      "Set `async: true` to run in the background (requires subAgentsDir). " +
      "Use for analysis, verification, extraction, or any task that " +
      "benefits from a focused system prompt. " +
      "The fork has read-only tools (read_file, grep_search) by default.",
    parameters: {
      type: "object",
      properties: {
        systemPrompt: {
          type: "string",
          description:
            "System prompt for the fork agent. Defines its role, " +
            "output format, and constraints.",
        },
        task: {
          type: "string",
          description: "The task for the fork agent to execute.",
        },
        async: {
          type: "boolean",
          description:
            "Run asynchronously in the background. When true, returns a run ID " +
            "immediately and the result arrives later as a user message. " +
            "Default: false (sync, blocks until complete).",
        },
      },
      required: ["systemPrompt", "task"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const systemPrompt = String(params.systemPrompt ?? "");
      const task = String(params.task ?? "");
      const wantAsync = params.async === true;

      if (!systemPrompt.trim()) return "Error: systemPrompt is required.";
      if (!task.trim()) return "Error: task is required.";

      // ── Async: delegate to SubAgentManager ─────────────────────────
      if (wantAsync && subAgentManager) {
        try {
          const runId = subAgentManager.spawnAdHoc({
            label: "fork-async",
            systemPrompt,
            task,
            tools: ["read_file", "grep_search"],
            traceKind: "fork",
            contextMessages: parent.getContextMessages(),
          });
          return `Fork agent spawned in background. Run ID: ${runId}. Result will arrive as a user message when complete.`;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return `Async fork failed: ${message}`;
        }
      }

      // ── Async requested but SubAgentManager unavailable ────────────
      if (wantAsync && !subAgentManager) {
        return (
          "Async fork is unavailable: no SubAgentManager configured. " +
          "Set `subAgentsDir` in AgentConfig to enable async mode, " +
          "or omit `async: true` to run synchronously."
        );
      }

      // ── Sync: run inline ───────────────────────────────────────────
      try {
        return await parent.fork(task, { systemPrompt });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Fork agent failed: ${message}`;
      }
    },
  };
}
