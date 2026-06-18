import { Tool } from "../types";
import type { MemoryManager } from "../../memory/memory-manager";

/**
 * Create a `recall` tool so the LLM can load full memory content on demand.
 *
 * The system prompt only lists memory names to save space; the LLM calls
 * this tool to load the complete markdown body when a memory is relevant
 * to the current task.
 */
export function createRecallTool(memoryManager: MemoryManager): Tool {
  return {
    name: "recall",
    description:
      "Load the full content of a long-term memory. The system prompt lists " +
      "available memory names — call this when a memory is relevant to the " +
      "current task. Pass 'all' to load every memory at once.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The memory name to load (from the list in the system prompt), " +
            "or 'all' to load every memory.",
        },
      },
      required: ["name"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = String(params.name ?? "").trim();

      if (name === "all") {
        const all = memoryManager.getAll();
        if (all.length === 0) return "No memories stored yet.";
        return all.map(formatMemory).join("\n\n---\n\n");
      }

      const memory = memoryManager.get(name);
      if (!memory) {
        const names = memoryManager
          .getAll()
          .map((m) => m.name)
          .join(", ");
        return `Memory "${name}" not found. Available: ${names || "none"}.`;
      }

      return formatMemory(memory);
    },
  };
}

function formatMemory(m: { name: string; type: string; description: string; content: string }): string {
  const badge = m.type === "rule" ? "📜 Rule" : "📋 Project";
  return [
    `## ${badge}: ${m.name}`,
    `*${m.description}*`,
    "",
    m.content,
  ].join("\n");
}
