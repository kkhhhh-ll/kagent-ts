import * as fs from "fs";
import * as path from "path";

// ─── ProjectRules ────────────────────────────────────────────────────────────

/**
 * User-defined project rules loaded from a file or directory.
 *
 * Unlike Memories (which the LLM discovers and writes), rules are explicitly
 * authored by the user. They define project-level conventions, constraints,
 * and expectations that the agent must follow.
 *
 * Storage:
 * - Single file: `RULES.md` (or custom path) — one markdown file.
 * - Directory:  `.rules/` (or custom path) — multiple `.md` files, each
 *   contributing a section.
 *
 * Rules are reloaded at the start of each run (like preferences) so edits
 * take effect on the next conversation turn.
 */
export class ProjectRules {
  private filePath: string | null = null;
  private dirPath: string | null = null;
  private lastLoadedMtime = 0;
  private cachedContent = "";

  /**
   * @param rulesPath  Path to a rules file (e.g. "RULES.md") or a
   *                   directory of rule files (e.g. ".rules/").
   *                   When omitted, neither is loaded.
   */
  constructor(rulesPath?: string) {
    if (!rulesPath) return;

    const resolved = path.resolve(rulesPath);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        this.dirPath = resolved;
      } else if (stat.isFile()) {
        this.filePath = resolved;
      }
    } catch {
      // Path doesn't exist — silently skip, rules are optional
    }
  }

  /**
   * Whether any rules source (file or directory) is configured.
   */
  get isConfigured(): boolean {
    return this.filePath !== null || this.dirPath !== null;
  }

  /**
   * Reload rules from disk if the source file(s) have changed.
   * @returns true if rules were actually reloaded.
   */
  reloadIfChanged(): boolean {
    if (this.filePath) {
      return this.reloadFile();
    } else if (this.dirPath) {
      return this.reloadDir();
    }
    return false;
  }

  /**
   * Build the rules prompt section for injection into the system prompt.
   * Returns an empty string when no rules are loaded.
   */
  buildPrompt(): string {
    if (!this.cachedContent) return "";
    return "\n\n## Project Rules\n" + this.cachedContent;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private reloadFile(): boolean {
    try {
      const stat = fs.statSync(this.filePath!);
      if (stat.mtimeMs === this.lastLoadedMtime) return false;
      this.lastLoadedMtime = stat.mtimeMs;
      this.cachedContent = fs.readFileSync(this.filePath!, "utf-8").trim();
      return true;
    } catch {
      this.cachedContent = "";
      return false;
    }
  }

  private reloadDir(): boolean {
    try {
      let latestMtime = 0;
      const files = fs.readdirSync(this.dirPath!)
        .filter((f) => f.endsWith(".md"))
        .sort();

      for (const file of files) {
        const fp = path.join(this.dirPath!, file);
        const stat = fs.statSync(fp);
        latestMtime = Math.max(latestMtime, stat.mtimeMs);
      }

      if (latestMtime <= this.lastLoadedMtime) return false;
      this.lastLoadedMtime = latestMtime;

      const sections: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.dirPath!, file), "utf-8").trim();
        if (content) sections.push(content);
      }
      this.cachedContent = sections.join("\n\n");
      return true;
    } catch {
      this.cachedContent = "";
      return false;
    }
  }
}
