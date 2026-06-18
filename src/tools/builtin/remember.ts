import { Tool } from "../types";
import type { MemoryManager } from "../../memory/memory-manager";
import type { MemoryType } from "../../memory/memory-manager";

/**
 * Create a `remember` tool so the LLM can persist long-term memories.
 *
 * The LLM should call this when it learns something worth keeping across
 * sessions — rules the user set, project decisions, conventions, etc.
 *
 * Factory pattern matching `createSkillTool` / `createListSubagentsTool`.
 */
export function createRememberTool(memoryManager: MemoryManager): Tool {
  return {
    name: "remember",
    description:
      "Save a long-term memory that will be recalled in future conversations. " +
      "Use this when you learn a user rule, project convention, or important " +
      "decision that should influence future sessions. Memories persist across " +
      "sessions and are injected into the system prompt.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short kebab-case slug used as the memory filename. " +
            "Examples: 'use-prisma-migrations', 'prefer-functional-components'.",
        },
        type: {
          type: "string",
          enum: ["rule", "project"],
          description:
            "'rule' for user constraints (why + when they apply). " +
            "'project' for project facts/decisions (what + why + how to apply).",
        },
        description: {
          type: "string",
          description:
            "One-line summary shown in the memory index. Keep it concise " +
            "(under 100 chars) so the index stays small.",
        },
        content: {
          type: "string",
          description:
            "Full markdown body. For rules: include why the user required it and " +
            "when it takes effect. For project facts: include what happened, why " +
            "(the constraint or deadline that drove it), and how the agent should " +
            "apply this knowledge in future sessions.",
        },
      },
      required: ["name", "type", "description", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = String(params.name ?? "").trim();
      const memType = (params.type as string) === "rule" ? "rule" : "project";
      const description = String(params.description ?? "").trim();
      const content = String(params.content ?? "").trim();

      if (!name) return "Error: 'name' is required (kebab-case slug).";
      if (!description) return "Error: 'description' is required (one-line summary).";
      if (!content) return "Error: 'content' is required (markdown body).";
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return `Error: 'name' must be kebab-case (e.g. 'use-prisma-migrations'). Got: "${name}".`;
      }

      // Upsert: overwrite if exists, add if new. Oldest entries are
      // silently pruned when the index exceeds 200 lines / 25 KB.
      const isUpdate = memoryManager.has(name);
      memoryManager.add({ name, type: memType as MemoryType, description, content });

      return isUpdate
        ? `Memory "${name}" updated successfully.`
        : `Memory "${name}" saved successfully (index: ${memoryManager.count} entries).`;
    },
  };
}
