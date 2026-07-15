/**
 * Shared utilities for skill name validation and SKILL.md frontmatter
 * generation. Used by both PrecipitateAgent (post-hoc extraction) and
 * the `precipitate_skill` tool (LLM-driven, in-session).
 *
 * Keeping these in one place ensures the two code-paths stay in sync
 * — a change to name validation or YAML escaping rules applies
 * everywhere at once.
 */

/** Regex matching the FileSkillLoader validation: no slashes, backslashes, "..", or null bytes. */
export const VALID_SKILL_NAME_RE = /[/\\]|\.\.|\0/;

/**
 * Validate a skill name against the FileSkillLoader rules.
 * @throws If the name is empty or contains path-traversal characters.
 */
export function validateSkillName(name: string): void {
  if (!name) {
    throw new Error("Skill name must not be empty.");
  }
  if (VALID_SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": contains path traversal characters.`,
    );
  }
}

/**
 * Escape a value for safe use as a YAML frontmatter single-line string.
 * Newlines are collapsed to spaces because the parser (parseFrontmatter)
 * is line-based and cannot handle multiline YAML strings.
 */
export function yamlValue(value: string): string {
  const single = value.replace(/\n/g, " ").replace(/\r/g, "").trim();
  if (/[:#{}&*!|>'"%@`-]/.test(single) || single.includes(" - ")) {
    return `"${single.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return single;
}

/**
 * Optional enrichment fields persisted alongside the skill body.
 * Produced by the PrecipitateAgent's extraction prompt.
 */
export interface SkillMarkdownExtras {
  /** Extractor's self-assessed confidence (0.0-1.0) — stored in frontmatter. */
  confidence?: number;
  /** Files/docs that ground this skill — appended as a "## References" section. */
  references?: string[];
  /** Reusable command sequences — appended as a "## Scripts" section. */
  scripts?: string;
  /** Boilerplate code/config — appended as a "## Templates" section. */
  templates?: string;
}

/**
 * Build the SKILL.md frontmatter + content string for a given skill.
 * The output is the full file content ready to write to disk.
 */
export function buildSkillMarkdown(
  name: string,
  description: string,
  content: string,
  keywords?: string[],
  extras?: SkillMarkdownExtras,
): string {
  const frontmatter = [
    "---",
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(description)}`,
  ];

  if (keywords && keywords.length > 0) {
    frontmatter.push(`keywords: ${JSON.stringify(keywords)}`);
  }

  if (extras?.confidence !== undefined) {
    frontmatter.push(`confidence: ${extras.confidence}`);
  }

  frontmatter.push("precipitated: true");
  frontmatter.push("---");
  frontmatter.push("");
  frontmatter.push(content);

  // Append enrichment sections after the body so future sessions see
  // the grounding files and copy-pasteable scripts/templates inline.
  // References are listed as paths only (progressive disclosure) —
  // the agent reads them on demand with read_file instead of having
  // their contents injected into every activation.
  if (extras?.references && extras.references.length > 0) {
    frontmatter.push("");
    frontmatter.push("## References");
    frontmatter.push(
      "Ground-truth files for this skill — read them with read_file when you need details:",
    );
    frontmatter.push(...extras.references.map((r) => `- ${r}`));
  }
  if (extras?.scripts) {
    frontmatter.push("");
    frontmatter.push("## Scripts");
    frontmatter.push(extras.scripts);
  }
  if (extras?.templates) {
    frontmatter.push("");
    frontmatter.push("## Templates");
    frontmatter.push(extras.templates);
  }

  return frontmatter.join("\n");
}
