import { Tool } from "../types";
import type { Agent } from "../../core/agent";

/**
 * Factory: create a `fork_agent` tool bound to the parent Agent instance.
 *
 * When the LLM calls this tool, a lightweight ReActAgent is forked inline.
 * The fork inherits the parent's full conversation context and runs to
 * completion before returning its result.
 */
export function createForkAgentTool(parent: Agent): Tool {
  return {
    name: "fork_agent",
    description:
      "Fork a lightweight sub-agent to handle a self-contained task inline. " +
      "The fork inherits the full conversation context from the main agent " +
      "and runs synchronously — the result is returned directly. " +
      "Use this for analysis, verification, extraction, or any task that " +
      "benefits from a focused system prompt without polluting the main conversation. " +
      "The fork has read-only tools (read_file, grep_search) by default.",
    parameters: {
      type: "object",
      properties: {
        systemPrompt: {
          type: "string",
          description:
            "System prompt for the fork agent. Defines its role, " +
            "output format, and constraints for this specific task.",
        },
        task: {
          type: "string",
          description: "The task for the fork agent to execute.",
        },
      },
      required: ["systemPrompt", "task"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const systemPrompt = String(params.systemPrompt ?? "");
      const task = String(params.task ?? "");

      if (!systemPrompt.trim()) {
        return "Error: systemPrompt is required.";
      }
      if (!task.trim()) {
        return "Error: task is required.";
      }

      try {
        return await parent.fork(task, { systemPrompt });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Fork agent failed: ${message}`;
      }
    },
  };
}
