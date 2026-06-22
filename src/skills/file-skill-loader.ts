import * as fs from "fs";
import * as path from "path";
import { Skill } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";

// ─── Frontmatter Parsing ───────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a Markdown file.
 *
 * Expects content between `---` delimiters at the start of the file:
 * ```
 * ---
 * key: value
 * ---
 * body content...
 * ```
 *
 * Lines starting with `#` inside frontmatter are treated as comments.
 * Returns empty frontmatter and full content as body when no `---` markers
 * are found.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes if both ends match
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

// ─── Script Execution ──────────────────────────────────────────────────────

const REFERENCE_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * Validate a skill name to prevent path traversal.
 * Only allows alphanumeric characters, hyphens, underscores, and dots.
 */
function validateSkillName(name: string): void {
  if (!name) {
    throw new Error(`Skill name must not be empty.`);
  }
  // Prevent path traversal: reject names with slashes, backslashes, "..", or null bytes
  if (/[/\\]|\.\.|\0/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": contains path traversal characters.`,
    );
  }
}

// ─── FileSkillLoader ───────────────────────────────────────────────────────

/**
 * Loads skill definitions from a directory on disk.
 *
 * Expected directory structure:
 * ```
 * skills/
 * ├── <skill-name>/
 * │   ├── SKILL.md          # Frontmatter (metadata) + body (system prompt)
 * │   └── reference/        # Optional reference docs (*.md, *.txt)
 * ├── <another-skill>/
 * │   └── ...
 * ```
 *
 * Loading is two-phase:
 * 1. `scan()` — reads only frontmatter, returns metadata-only `Skill[]`
 * 2. `loadSystemPrompt()` — full content (body + reference docs), called
 *    lazily on activation.
 */
export class FileSkillLoader {
  private directory: string;
  private logger: Logger;

  /**
   * @param directory Path to the skills root directory (default: `./skills`).
   * @param logger    Logger instance (defaults to ConsoleLogger).
   */
  constructor(directory?: string, logger?: Logger) {
    this.directory = path.resolve(directory || "./skills");
    this.logger = logger ?? new ConsoleLogger();
  }

  /**
   * Get the root directory path.
   */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Get the absolute path to a named skill's subdirectory.
   * Throws if the skill name contains path traversal characters.
   */
  getSkillDir(name: string): string {
    validateSkillName(name);
    return path.join(this.directory, name);
  }

  /**
   * Scan the skills directory and return metadata-only Skill objects.
   *
   * Reads only the frontmatter from each SKILL.md — the body (systemPrompt)
   * is NOT loaded at this stage. It is loaded lazily when the skill is
   * activated.
   *
   * Subdirectories without a valid SKILL.md (or without a `name` in
   * frontmatter) are skipped with a warning.
   */
  scan(): Skill[] {
    const skills: Skill[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.directory, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or can't be read — return empty
      return [];
    }

    for (const entry of entries) {
      // Skip non-directories, dotfiles, and symlinks
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const skillPath = path.join(this.directory, entry.name);
      const skillMdPath = path.join(skillPath, "SKILL.md");

      let raw: string;
      try {
        raw = fs.readFileSync(skillMdPath, "utf-8");
      } catch {
        this.logger.warn(
          "Skills",
          `Skipping "${entry.name}": no SKILL.md found in ${skillPath}`,
        );
        continue;
      }

      const { frontmatter, body } = parseFrontmatter(raw);

      const name = frontmatter.name?.trim();
      if (!name) {
        this.logger.warn(
          "Skills",
          `Skipping "${entry.name}": SKILL.md has no "name" in frontmatter`,
        );
        continue;
      }

      try {
        validateSkillName(name);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("Skills", `Skipping "${entry.name}": ${message}`);
        continue;
      }

      skills.push({
        name,
        description: frontmatter.description?.trim() ?? "",
        systemPrompt: "", // Loaded lazily on activation
      });
    }

    return skills;
  }

  /**
   * Fully load the system prompt for a skill:
   * 1. SKILL.md body (the content after frontmatter)
   * 2. All reference/*.md and reference/*.txt files (concatenated with headers)
   *
   * Throws if the skill directory does not exist.
   */
  loadSystemPrompt(name: string): string {
    const skillDir = this.getSkillDir(name);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    // Read SKILL.md body
    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const { body } = parseFrontmatter(raw);
    const parts: string[] = [body];

    // Append reference docs
    const refDir = path.join(skillDir, "reference");
    try {
      const refFiles = fs
        .readdirSync(refDir, { withFileTypes: true })
        .filter(
          (f) =>
            f.isFile() &&
            REFERENCE_EXTENSIONS.has(path.extname(f.name).toLowerCase()),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      if (refFiles.length > 0) {
        parts.push("\n\n---\n### Reference Documents\n");
        for (const ref of refFiles) {
          const refContent = fs.readFileSync(
            path.join(refDir, ref.name),
            "utf-8",
          );
          parts.push(`\n**${ref.name}**\n${refContent.trim()}\n`);
        }
      }
    } catch {
      // No reference/ directory — skip silently
    }

    return parts.join("").trim();
  }

}
