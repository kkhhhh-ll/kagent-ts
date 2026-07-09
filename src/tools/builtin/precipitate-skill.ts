import { Tool } from "../types";
import type { SkillManager } from "../../skills/skill-manager";
import * as fs from "fs";
import * as path from "path";

/** Regex matching the FileSkillLoader validation: no slashes, backslashes, "..", or null bytes. */
const VALID_SKILL_NAME_RE = /[/\\]|\.\.|\0/;

/**
 * Create a `precipitate_skill` tool that allows the LLM to save a reusable
 * skill discovered during a session directly to the skills directory.
 *
 * Factory pattern matching `createSkillTool` / `createSpawnSubagentTool`.
 *
 * @param skillManager  The agent's SkillManager for registering the new skill.
 * @param skillsDir     Path to the skills directory where SKILL.md is written.
 */
export function createPrecipitateSkillTool(
  skillManager: SkillManager,
  skillsDir: string,
): Tool {
  return {
    name: "precipitate_skill",
    description:
      "Save a reusable skill discovered during this session. " +
      "Skills capture repeatable workflows, domain knowledge, " +
      "or error recovery strategies. They are loaded as system " +
      "prompt instructions in future sessions to improve efficiency. " +
      "Use this when you discover a pattern, convention, or strategy " +
      "that would be useful later.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Unique kebab-case skill name. " +
            "Examples: 'prisma-migration-workflow', 'react-component-pattern'. " +
            "Use only lowercase letters, numbers, hyphens, underscores, and dots.",
        },
        description: {
          type: "string",
          description:
            "One-line summary shown in the available skills list. " +
            "Be specific about when this skill should be activated.",
        },
        content: {
          type: "string",
          description:
            "Full system prompt body in markdown. This is the knowledge the " +
            "skill carries — the instructions a future LLM agent will see " +
            "when this skill is activated. Include concrete steps, examples, " +
            "warnings, and references to relevant files or conventions.",
        },
      },
      required: ["name", "description", "content"],
    },
    requireApproval: true,

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = String(params.name ?? "").trim();
      const description = String(params.description ?? "").trim();
      const content = String(params.content ?? "").trim();

      // Validate inputs
      if (!name) return "Error: skill name is required.";
      if (!description) return "Error: skill description is required.";
      if (!content) return "Error: skill content is required.";

      // Validate name format
      if (VALID_SKILL_NAME_RE.test(name)) {
        return (
          `Error: invalid skill name "${name}". ` +
          `Skill names must not contain slashes, backslashes, "..", or null bytes.`
        );
      }

      // Check for duplicates
      if (skillManager.has(name)) {
        return (
          `Skill "${name}" already exists. ` +
          `To update it, edit the file at: ${path.join(skillsDir, name, "SKILL.md")}`
        );
      }

      try {
        // Write SKILL.md
        const skillDir = path.join(skillsDir, name);
        fs.mkdirSync(skillDir, { recursive: true });

        const frontmatter = [
          "---",
          `name: ${name}`,
          `description: ${description}`,
          "precipitated: true",
          "---",
          "",
          content,
        ].join("\n");

        const filePath = path.join(skillDir, "SKILL.md");
        fs.writeFileSync(filePath, frontmatter, "utf-8");

        // Register with SkillManager
        skillManager.reloadFromDirectory(skillsDir);

        return (
          `Skill "${name}" saved successfully to ${filePath}. ` +
          `Description: ${description}`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error saving skill "${name}": ${message}`;
      }
    },
  };
}
