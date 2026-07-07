import * as fs from "fs";
import * as path from "path";
import {
  detectInjectionSignatures,
  buildUserContentInjectionWarning,
  wrapUserAuthored,
} from "../security/boundaries";
import { Logger, ConsoleLogger } from "../logging/logger";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maximum size per rule file in directory mode (50 KB). */
const MAX_RULE_FILE_BYTES = 50 * 1024;
/** Maximum total size for all rule files in directory mode (100 KB). */
const MAX_RULES_TOTAL_BYTES = 100 * 1024;

/** Narrow type guard for NodeJS.ErrnoException */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

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
  /**
   * Per-file mtimes for directory mode.
   * Tracks each file's mtime individually so a change to ANY file is
   * detected — a single aggregate max would miss edits to files with
   * lower timestamps.
   */
  private lastLoadedMtimes: Map<string, number> = new Map();
  /** Snapshot of file names when dir was last loaded; used to detect deletions */
  private lastFileList = "";
  private cachedContent = "";
  private logger: Logger;

  /**
   * @param rulesPath  Path to a rules file (e.g. "RULES.md") or a
   *                   directory of rule files (e.g. ".rules/").
   *                   When omitted, neither is loaded.
   */
  constructor(rulesPath?: string, logger?: Logger) {
    this.logger = logger ?? new ConsoleLogger();
    const resolved = path.resolve(rulesPath ?? ".kagent/rules/");
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        this.dirPath = resolved;
      } else if (stat.isFile()) {
        this.filePath = resolved;
      }
    } catch (err: unknown) {
      // 只静默处理"文件不存在"的情况（规则是可选的）
      if (isNodeError(err) && err.code === "ENOENT") return;
      // 其他错误（权限不足、磁盘满等）暴露给开发者
      this.logger.error("Rules", `Unexpected error accessing ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
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
   *
   * The content is wrapped in user-authored boundary markers and scanned
   * for prompt-injection signatures before being returned.
   */
  buildPrompt(): string {
    if (!this.cachedContent) return "";

    const body = "## Project Rules\n" + this.cachedContent;

    // Scan for prompt-injection signatures in user-authored content
    const patterns = detectInjectionSignatures(body);
    const warning = buildUserContentInjectionWarning(patterns, "project rules");

    // Wrap in boundaries so the LLM can distinguish user-authored
    // guidance from core system instructions
    const wrapped = wrapUserAuthored("Project Rules", body);

    return "\n\n" + warning + wrapped;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Shared error handler for file/dir read failures.
   * Logs non-ENOENT errors, clears cached content so the caller sees a
   * change (empty content → no rules injected).
   */
  private handleLoadError(err: unknown, context: string): boolean {
    if (!(isNodeError(err) && err.code === "ENOENT")) {
      this.logger.error("Rules",
        `Unexpected error reading ${context}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.cachedContent !== "") {
      this.cachedContent = "";
      return true;
    }
    return false;
  }

  private reloadFile(): boolean {
    try {
      const stat = fs.statSync(this.filePath!);
      if (stat.size > MAX_RULE_FILE_BYTES) {
        this.logger.warn(
          "Rules",
          `File "${this.filePath}" exceeds ${MAX_RULE_FILE_BYTES / 1024} KB limit (${(stat.size / 1024).toFixed(1)} KB) — skipped.`,
        );
        if (this.cachedContent !== "") { this.cachedContent = ""; return true; }
        return false;
      }
      if (stat.mtimeMs === this.lastLoadedMtime) return false;
      this.lastLoadedMtime = stat.mtimeMs;
      this.cachedContent = fs.readFileSync(this.filePath!, "utf-8").trim();
      return true;
    } catch (err: unknown) {
      return this.handleLoadError(err, `file ${this.filePath}`);
    }
  }

  /**
   * Detect if any files in the directory have changed since last load.
   * Updates internal mtime tracking records as a side effect.
   * @returns true if at least one file has been modified or the file list has changed.
   */
  private detectDirChanged(files: string[]): boolean {
    const fileListKey = files.join(",");
    if (fileListKey === this.lastFileList) {
      // 逐文件比较 mtime —— 避免聚合最大值导致的遗漏编辑
      let changed = false;
      for (const file of files) {
        const fp = path.join(this.dirPath!, file);
        const stat = fs.statSync(fp);
        const prev = this.lastLoadedMtimes.get(file) ?? 0;
        if (stat.mtimeMs > prev) changed = true;
        this.lastLoadedMtimes.set(file, stat.mtimeMs);
      }
      return changed;
    }
    // 文件列表变了（新增/删除），重建 mtime 记录并视为变更
    this.lastLoadedMtimes.clear();
    for (const file of files) {
      const fp = path.join(this.dirPath!, file);
      const stat = fs.statSync(fp);
      this.lastLoadedMtimes.set(file, stat.mtimeMs);
    }
    this.lastFileList = fileListKey;
    return true;
  }

  /**
   * Read all .md files from the directory and concatenate their trimmed content.
   * Mtime tracking is handled by {@link detectDirChanged} — no stat here.
   */
  private readDirFiles(files: string[]): string {
    const sections: string[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const fp = path.join(this.dirPath!, file);
      const stat = fs.statSync(fp);
      if (stat.size > MAX_RULE_FILE_BYTES) {
        this.logger.warn(
          "Rules",
          `"${file}" exceeds ${MAX_RULE_FILE_BYTES / 1024} KB limit (${(stat.size / 1024).toFixed(1)} KB) — skipped.`,
        );
        continue;
      }
      if (totalBytes + stat.size > MAX_RULES_TOTAL_BYTES) {
        this.logger.warn(
          "Rules",
          `Total rules size exceeds ${MAX_RULES_TOTAL_BYTES / 1024} KB limit — skipping remaining files.`,
        );
        break;
      }
      const content = fs.readFileSync(fp, "utf-8").trim();
      if (content) {
        sections.push(content);
        totalBytes += stat.size;
      }
    }
    return sections.join("\n\n");
  }

  private reloadDir(): boolean {
    try {
      const files = fs.readdirSync(this.dirPath!)
        .filter((f) => f.endsWith(".md"))
        .sort();

      // 空目录处理
      if (files.length === 0) {
        if (this.cachedContent !== "") {
          this.cachedContent = "";
          return true;
        }
        return false;
      }

      if (!this.detectDirChanged(files)) return false;

      this.cachedContent = this.readDirFiles(files);
      return true;
    } catch (err: unknown) {
      return this.handleLoadError(err, `directory ${this.dirPath}`);
    }
  }
}
