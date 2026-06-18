import { Tool } from "../types";
import type { SkillManager } from "../../skills/skill-manager";

/**
 * Create a Skill tool that allows the LLM to activate / deactivate skills
 * on demand during the agent loop.
 *
 * Factory pattern matching `createListSubagentsTool` / `createSpawnSubagentTool`.
 *
 * @param skillManager  The agent's SkillManager for skill state management.
 * @param onSkillChanged  Callback invoked after a skill is activated or
 *                        deactivated so the agent can rebuild its system prompt.
 */
export function createSkillTool(
  skillManager: SkillManager,
  onSkillChanged: () => void,
): Tool {
  return {
    name: "skill",
    description:
      "Activate or deactivate a skill. Skills provide specialized domain " +
      "knowledge and capabilities. Use this tool when a task requires " +
      "expertise in a specific domain. Call with action 'activate' to load " +
      "a skill (the default), or 'deactivate' to unload it.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to activate or deactivate.",
        },
        action: {
          type: "string",
          enum: ["activate", "deactivate"],
          description:
            "Whether to activate (load) or deactivate (unload) the skill. Default: 'activate'.",
        },
      },
      required: ["name"],
    },

    async execute(params: Record<string, unknown>): Promise<string> {
      const skillName = String(params.name ?? "");
      const action = (params.action as string) || "activate";

      if (!skillManager.has(skillName)) {
        const available = skillManager
          .getAll()
          .map((s) => s.name)
          .join(", ");
        return `Unknown skill: "${skillName}". Available skills: ${available || "none"}.`;
      }

      if (action === "deactivate") {
        const wasActive = skillManager.deactivate(skillName);
        if (wasActive) {
          onSkillChanged();
          return `Skill "${skillName}" deactivated.`;
        }
        return `Skill "${skillName}" is not currently active.`;
      }

      // activate (default)
      if (skillManager.isActive(skillName)) {
        return `Skill "${skillName}" is already active.`;
      }

      try {
        skillManager.activate(skillName);
        onSkillChanged();
        const skill = skillManager.get(skillName);
        return `Skill "${skillName}" activated successfully: ${skill?.description ?? ""}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error activating skill "${skillName}": ${message}`;
      }
    },
  };
}
