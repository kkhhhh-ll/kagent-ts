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
      "sessions and are injected into the system prompt. " +
      "If the user contradicts a previously-stored memory, use `supersedes` to " +
      "remove the outdated entries so they won't conflict in future sessions.",
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
          enum: ["rule", "project", "preference"],
          description:
            "'rule' for hard user constraints — things the user explicitly REQUIRED " +
            "('always X', 'never Y'). Include why + when. " +
            "'project' for project facts/decisions — what happened, why, how to apply. " +
            "'preference' for observed user habits — patterns the user consistently " +
            "prefers but did NOT state as a hard rule ('user likes short answers', " +
            "'user prefers pnpm over npm'). Include evidence (what the user said/did). " +
            "IMPORTANT: user style/habit observations go in 'preference', NOT 'rule'. " +
            "'rule' is ONLY for explicit constraints the user stated as requirements.",
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
            "Full markdown body. For rules: **Why:** + **When:**. " +
            "For projects: **Why:** + **How to apply:**. " +
            "For preferences: **Observed pattern:** + **Evidence:** (what the user said/did).",
        },
        supersedes: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Names of existing memories that this new memory replaces. " +
            "Use this when the user corrects or contradicts a previously-saved memory — " +
            "the superseded entries will be deleted so they don't conflict in future sessions. " +
            "Example: if the user previously wanted kebab-case file names but now wants " +
            "camelCase, pass `[\"use-kebab-case\"]` to remove the old convention.",
        },
      },
      required: ["name", "type", "description", "content"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = String(params.name ?? "").trim();
      const memType = (params.type as string) === "rule" ? "rule"
        : (params.type as string) === "preference" ? "preference"
        : "project";
      const description = String(params.description ?? "").trim();
      const content = String(params.content ?? "").trim();

      if (!name) return "Error: 'name' is required (kebab-case slug).";
      if (!description) return "Error: 'description' is required (one-line summary).";
      if (!content) return "Error: 'content' is required (markdown body).";
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
        return `Error: 'name' must be kebab-case (e.g. 'use-prisma-migrations'). Got: "${name}".`;
      }

      // Handle supersedes: remove outdated memories before writing the new one
      const supersedes = params.supersedes as string[] | undefined;
      let removedNames: string[] = [];
      if (Array.isArray(supersedes) && supersedes.length > 0) {
        for (const oldName of supersedes) {
          if (typeof oldName === "string" && oldName !== name && memoryManager.has(oldName)) {
            memoryManager.remove(oldName.trim());
            removedNames.push(oldName.trim());
          }
        }
      }

      // Upsert: overwrite if exists, add if new. LRU eviction prunes
      // the least-recalled entries when the index exceeds limits.
      const isUpdate = memoryManager.has(name);
      memoryManager.add({ name, type: memType as MemoryType, description, content });

      const parts: string[] = [];
      parts.push(isUpdate
        ? `Memory "${name}" updated successfully.`
        : `Memory "${name}" saved successfully (index: ${memoryManager.count} entries).`);
      if (removedNames.length > 0) {
        parts.push(`Superseded: ${removedNames.join(", ")}.`);
      }
      return parts.join(" ");
    },
  };
}
