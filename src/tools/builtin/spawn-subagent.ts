import { Tool } from "../types";
import type { SubAgentManager } from "../../subagent/subagent-manager";

/**
 * Factory: create a `spawn_subagent` tool bound to a SubAgentManager instance.
 */
export function createSpawnSubagentTool(manager: SubAgentManager): Tool {
  return {
    name: "spawn_subagent",
    description:
      "Spawn an asynchronous sub-agent to handle a delegated task. " +
      "The sub-agent runs in the background; its result will appear " +
      "as a new user message enclosed in <subagent-result> tags once it completes. " +
      "Available sub-agents are listed in the system prompt — use the exact name from that list.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the sub-agent to spawn. See the system prompt for available sub-agents and their names.",
        },
        input: {
          type: "string",
          description: "Task description / instructions for the sub-agent.",
        },
      },
      required: ["name", "input"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = String(params.name ?? "");
      const input = String(params.input ?? "");
      try {
        const runId = manager.spawn(name, input);
        return (
          `Sub-agent "${name}" spawned successfully. Run ID: ${runId}. ` +
          `It will report back when finished.`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error spawning sub-agent "${name}": ${message}`;
      }
    },
  };
}
