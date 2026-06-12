import * as fs from "fs";
import * as path from "path";
import { parseFrontmatter } from "../skills/file-skill-loader";
import { SubAgentDefinition } from "./subagent-types";

/**
 * Loads sub-agent definitions from a directory of AGENT.md files.
 *
 * Expected directory structure:
 * ```
 * subagents/
 * ├── <agent-name>/
 * │   └── AGENT.md       # Frontmatter (metadata) + body (system prompt)
 * ├── <another-agent>/
 * │   └── AGENT.md
 * ```
 *
 * The AGENT.md format:
 * ```markdown
 * ---
 * name: code-reviewer
 * description: Reviews code for bugs and style issues
 * tools: read_file, grep_search, glob_search
 * skills: code-review
 * ---
 * You are a code review specialist...
 * ```
 */
export class SubAgentLoader {
  private directory: string;
  private agentFileName: string;

  /**
   * @param directory      Path to the sub-agents root directory.
   * @param agentFileName  The markdown filename to look for (default: "AGENT.md").
   */
  constructor(directory: string, agentFileName?: string) {
    this.directory = path.resolve(directory);
    this.agentFileName = agentFileName ?? "AGENT.md";
  }

  /**
   * Get the root directory path.
   */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Scan the directory and return SubAgentDefinition objects for each
   * subdirectory that contains a valid AGENT.md file.
   *
   * Subdirectories without an AGENT.md or without a `name` in frontmatter
   * are skipped with a warning.
   */
  scan(): SubAgentDefinition[] {
    const definitions: SubAgentDefinition[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.directory, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const def = this.loadDefinition(entry.name);
      if (def) {
        definitions.push(def);
      }
    }

    return definitions;
  }

  /**
   * Load a single sub-agent definition by name (the subdirectory name).
   */
  loadDefinition(dirName: string): SubAgentDefinition | null {
    const agentPath = path.join(this.directory, dirName, this.agentFileName);

    let raw: string;
    try {
      raw = fs.readFileSync(agentPath, "utf-8");
    } catch {
      console.warn(
        `[SubAgent] Skipping "${dirName}": no ${this.agentFileName} found.`,
      );
      return null;
    }

    const { frontmatter, body } = parseFrontmatter(raw);

    const name = frontmatter.name?.trim();
    if (!name) {
      console.warn(
        `[SubAgent] Skipping "${dirName}": no "name" in frontmatter.`,
      );
      return null;
    }

    const tools = parseCsvList(frontmatter.tools);
    const skills = parseCsvList(frontmatter.skills);

    return {
      name,
      description: frontmatter.description?.trim() ?? "",
      systemPrompt: body,
      tools,
      skills,
    };
  }
}

/**
 * Parse a comma-separated string into a string array.
 * Returns empty array for empty/absent input.
 */
function parseCsvList(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
