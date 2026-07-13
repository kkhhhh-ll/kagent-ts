import * as path from "path";
import { Skill } from "./types";
import { SkillStore, FileSystemSkillStore } from "./skill-store";
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
  if (/[/\\]|\.\.|\0/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": contains path traversal characters.`,
    );
  }
}

// ─── FileSkillLoader ───────────────────────────────────────────────────────

/**
 * Loads skill definitions from a pluggable store.
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
  private store: SkillStore;
  private logger: Logger;
  /**
   * Map from skill name (frontmatter `name`) to its directory basename.
   */
  private skillDirs = new Map<string, string>();

  /**
   * @param options  Either a directory path (string), a SkillStore instance, or a config object.
   * @param logger   Logger instance (defaults to ConsoleLogger).
   */
  constructor(
    options?: string | SkillStore | { store?: SkillStore; directory?: string },
    logger?: Logger,
  ) {
    this.logger = logger ?? new ConsoleLogger();

    if (typeof options === "string") {
      // Legacy: directory path string
      this.store = new FileSystemSkillStore(options);
    } else if (this.isSkillStore(options)) {
      // SkillStore instance (duck-typed via getDir)
      this.store = options as SkillStore;
    } else if (options && typeof options === "object") {
      // Config object: { store?, directory? }
      this.store = options.store ?? new FileSystemSkillStore(options.directory);
    } else {
      // No options — default
      this.store = new FileSystemSkillStore();
    }
  }

  private isSkillStore(v: unknown): v is SkillStore {
    return typeof v === "object" && v !== null
      && typeof (v as SkillStore).getDir === "function"
      && typeof (v as SkillStore).listSkillDirs === "function";
  }

  /**
   * Get the underlying storage backend.
   */
  getStore(): SkillStore {
    return this.store;
  }

  /**
   * Get the root directory path.
   */
  getDirectory(): string {
    return this.store.getDir();
  }

  /**
   * Get the absolute path to a named skill's subdirectory.
   */
  getSkillDir(name: string): string {
    validateSkillName(name);
    const dirName = this.skillDirs.get(name) ?? name;
    return path.join(this.store.getDir(), dirName);
  }

  /**
   * Scan the skills store and return metadata-only Skill objects.
   */
  scan(): Skill[] {
    const skills: Skill[] = [];

    const entries = this.store.listSkillDirs();
    if (entries.length === 0) return skills;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const raw = this.store.readSkillMd(entry.name);
      if (!raw) {
        this.logger.warn(
          "Skills",
          `Skipping "${entry.name}": no SKILL.md found in ${path.join(this.store.getDir(), entry.name)}`,
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

      let keywords: string[] | undefined;
      const kwRaw = frontmatter.keywords?.trim();
      if (kwRaw) {
        try {
          const parsed = JSON.parse(kwRaw);
          if (Array.isArray(parsed)) {
            keywords = parsed.map((k: unknown) => String(k).trim()).filter(Boolean);
          }
        } catch {
          keywords = kwRaw
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean);
        }
      }

      skills.push({
        name,
        description: frontmatter.description?.trim() ?? "",
        keywords,
        systemPrompt: "", // Loaded lazily on activation
      });
      this.skillDirs.set(name, entry.name);
    }

    return skills;
  }

  /**
   * Fully load the system prompt for a skill:
   * 1. SKILL.md body (the content after frontmatter)
   * 2. All reference/*.md and reference/*.txt files (concatenated with headers)
   */
  loadSystemPrompt(name: string): string {
    const skillDirName = this.skillDirs.get(name) ?? name;
    const raw = this.store.readSkillMd(skillDirName);
    if (!raw) {
      throw new Error(`Failed to load skill "${name}": SKILL.md not found.`);
    }

    const { body } = parseFrontmatter(raw);
    const parts: string[] = [body];

    // Append reference docs
    const refFiles = this.store.listReferenceFiles(skillDirName);
    const filtered = refFiles.filter(
      (f) =>
        f.isFile() &&
        REFERENCE_EXTENSIONS.has(path.extname(f.name).toLowerCase()),
    ).sort((a, b) => a.name.localeCompare(b.name));

    if (filtered.length > 0) {
      parts.push("\n\n---\n### Reference Documents\n");
      for (const ref of filtered) {
        const refContent = this.store.readReferenceFile(skillDirName, ref.name);
        if (refContent) {
          parts.push(`\n**${ref.name}**\n${refContent.trim()}\n`);
        }
      }
    }

    return parts.join("").trim();
  }
}
