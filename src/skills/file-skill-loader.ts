import * as fs from "fs";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import { Skill } from "./types";
import { Tool } from "../tools/types";

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
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body: match[2].trim() };
}

/**
 * Parse a comma-separated keywords string into an array.
 * Returns `undefined` when the input is empty or absent.
 */
export function parseKeywords(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const keywords = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keywords.length > 0 ? keywords : undefined;
}

// ─── Script Execution ──────────────────────────────────────────────────────

const SUPPORTED_SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".js",
  ".py",
]);

const REFERENCE_EXTENSIONS = new Set([".md", ".txt"]);

/**
 * Determine the interpreter and arguments needed to run a script file.
 * Returns `null` if the file extension is not supported.
 */
function getInterpreter(filePath: string): string[] | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".sh":
      return ["bash", filePath];
    case ".bat":
    case ".cmd":
      return ["cmd.exe", "/c", filePath];
    case ".ps1":
      return ["powershell.exe", "-File", filePath];
    case ".js":
      return ["node", filePath];
    case ".py":
      // Try python3 first, fall back to python
      try {
        execFileSync("python3", ["--version"], { timeout: 5000, stdio: "ignore" });
        return ["python3", filePath];
      } catch {
        return ["python", filePath];
      }
    default:
      return null;
  }
}

/**
 * Extract a description for a script tool from the first comment/line
 * of the file, or fall back to a generic description.
 */
function getScriptDescription(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    if (firstLine) {
      // Strip common comment markers and shebang
      const clean = firstLine
        .replace(/^#!\s*/, "")
        .replace(/^#\s*/, "")
        .replace(/^\/\/\s*/, "")
        .replace(/^--\s*/, "")
        .trim();
      if (clean && !clean.startsWith("/")) return clean;
    }
  } catch {
    // Ignore read errors
  }
  return `Execute the ${path.basename(filePath)} script`;
}

/**
 * Sanitize a string for use as a tool name (alphanumeric + underscores only).
 */
function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
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
 * │   ├── reference/        # Optional reference docs (*.md, *.txt)
 * │   └── scripts/          # Optional executable scripts
 * ├── <another-skill>/
 * │   └── ...
 * ```
 *
 * Loading is two-phase:
 * 1. `scan()` — reads only frontmatter, returns metadata-only `Skill[]`
 * 2. `loadSystemPrompt()` / `loadScriptsAsTools()` — full content, called
 *    lazily on activation.
 */
export class FileSkillLoader {
  private directory: string;

  /**
   * @param directory Path to the skills root directory (default: `./skills`).
   */
  constructor(directory?: string) {
    this.directory = path.resolve(directory || "./skills");
  }

  /**
   * Get the root directory path.
   */
  getDirectory(): string {
    return this.directory;
  }

  /**
   * Get the absolute path to a named skill's subdirectory.
   */
  getSkillDir(name: string): string {
    return path.join(this.directory, name);
  }

  /**
   * Scan the skills directory and return metadata-only Skill objects.
   *
   * Reads only the frontmatter from each SKILL.md — the body (systemPrompt)
   * and scripts are NOT loaded at this stage. They are loaded lazily when
   * the skill is activated.
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
        console.warn(
          `[Skills] Skipping "${entry.name}": no SKILL.md found in ${skillPath}`,
        );
        continue;
      }

      const { frontmatter, body } = parseFrontmatter(raw);

      const name = frontmatter.name?.trim();
      if (!name) {
        console.warn(
          `[Skills] Skipping "${entry.name}": SKILL.md has no "name" in frontmatter`,
        );
        continue;
      }

      skills.push({
        name,
        description: frontmatter.description?.trim() ?? "",
        systemPrompt: "", // Loaded lazily on activation
        keywords: parseKeywords(frontmatter.keywords),
        tools: [], // Loaded lazily on activation
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

  /**
   * Create Tool objects from scripts in the scripts/ subdirectory.
   *
   * Each recognized script file becomes a Tool named `{skillName}_{scriptName}`.
   *
   * Returns an empty array if the scripts/ directory is missing or empty.
   */
  loadScriptsAsTools(name: string): Tool[] {
    const scriptsDir = path.join(this.getSkillDir(name), "scripts");
    const tools: Tool[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
    } catch {
      // No scripts/ directory — return empty
      return [];
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_SCRIPT_EXTENSIONS.has(ext)) continue;

      const scriptPath = path.join(scriptsDir, entry.name);
      const scriptName = path.basename(entry.name, ext);
      const toolName = sanitizeToolName(`${name}_${scriptName}`);
      const toolDescription = getScriptDescription(scriptPath);

      const tool: Tool = {
        name: toolName,
        description: toolDescription,
        parameters: {
          type: "object",
          properties: {
            args: {
              type: "string",
              description:
                `Arguments to pass to the ${entry.name} script. ` +
                `Use shell-style syntax (space-separated).`,
            },
          },
          required: ["args"],
        },
        async execute(params: Record<string, unknown>): Promise<string> {
          const argsStr = String(params.args ?? "");
          const interpreter = getInterpreter(scriptPath);

          if (!interpreter) {
            return `Error: Unsupported script type "${ext}" for ${entry.name}`;
          }

          const [cmd, ...cmdArgs] = interpreter;

          // Append the script argument after the interpreter args
          const allArgs = argsStr
            ? [...cmdArgs, ...argsStr.split(/\s+/).filter(Boolean)]
            : cmdArgs;

          return new Promise((resolve) => {
            const child = execFile(
              cmd,
              allArgs,
              { timeout: 30000, maxBuffer: 1024 * 1024 },
              (err, stdout, stderr) => {
                if (err) {
                  const details = stderr
                    ? `\nstderr:\n${stderr.trim()}`
                    : "";
                  resolve(
                    `Error executing ${entry.name}: ${err.message}${details}`,
                  );
                  return;
                }
                resolve(stdout.trim() || "(no output)");
              },
            );
          });
        },
      };

      tools.push(tool);
    }

    return tools;
  }
}
