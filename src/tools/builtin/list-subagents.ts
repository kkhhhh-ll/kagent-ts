import { Tool } from "../types";
import type { SubAgentManager } from "../../subagent/subagent-manager";

/**
 * Factory: create a `list_subagents` tool bound to a SubAgentManager instance.
 */
export function createListSubagentsTool(manager: SubAgentManager): Tool {
  return {
    name: "list_subagents",
    description:
      "List all available sub-agents with their names, descriptions, tools, and skills. " +
      "Call this first before using spawn_subagent so you can pick the right one.",
    parameters: { type: "object", properties: {} },

    async execute(): Promise<string> {
      if (!manager.hasDefinitions()) return "No sub-agents registered.";

      const list = manager.buildSubAgentList();
      return "Available sub-agents:\n\n" + list;
    },
  };
}
