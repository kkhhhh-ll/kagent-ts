import * as path from "path";
import {
  detectInjectionSignatures,
  buildUserContentInjectionWarning,
  wrapUserAuthored,
} from "../security/boundaries";
import { Logger, ConsoleLogger } from "../logging/logger";
import { RulesStore, FileSystemRulesStore } from "./rules-store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_RULE_FILE_BYTES = 50 * 1024;
const MAX_RULES_TOTAL_BYTES = 100 * 1024;

/**
 * Configuration for ProjectRules.
 */
export interface ProjectRulesConfig {
  /** Path to a rules file or directory. */
  rulesPath?: string;
  /** Logger instance. */
  logger?: Logger;
  /**
   * Storage backend. When provided, `rulesPath` is ignored.
   * Omit to use the default file-system store.
   */
  store?: RulesStore;
}

// ─── ProjectRules ────────────────────────────────────────────────────────────

/**
 * User-defined project rules loaded from a pluggable store.
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
  private store: RulesStore;
  private lastLoadedMtime = 0;
  /**
   * Per-file mtimes for directory mode.
   */
  private lastLoadedMtimes: Map<string, number> = new Map();
  private lastFileList = "";
  private cachedContent = "";
  private logger: Logger;

  /**
   * @param config  Either a rules path (string, backward-compat), or a ProjectRulesConfig object.
   * @param logger  Logger (backward-compat, only used when first arg is a string).
   */
  constructor(config?: string | ProjectRulesConfig, logger?: Logger) {
    if (typeof config === "string") {
      // Backward-compatible: `new ProjectRules(".kagent/rules/")`
      this.logger = logger ?? new ConsoleLogger();
      this.store = new FileSystemRulesStore(config);
    } else {
      this.logger = config?.logger ?? new ConsoleLogger();
      this.store = config?.store ?? new FileSystemRulesStore(config?.rulesPath);
    }
  }

  /**
   * Get the underlying storage backend.
   */
  getStore(): RulesStore {
    return this.store;
  }

  /**
   * Whether any rules source (file or directory) is configured.
   */
  get isConfigured(): boolean {
    return this.store.isFile() || this.store.isDirectory();
  }

  /**
   * Reload rules from the store if the source files have changed.
   * @returns true if rules were actually reloaded.
   */
  reloadIfChanged(): boolean {
    if (this.store.isFile()) {
      return this.reloadFile();
    } else if (this.store.isDirectory()) {
      return this.reloadDir();
    }
    return false;
  }

  /**
   * Build the rules prompt section for injection into the system prompt.
   */
  buildPrompt(): string {
    if (!this.cachedContent) return "";

    const body = "## Project Rules\n" + this.cachedContent;

    const patterns = detectInjectionSignatures(body);
    const warning = buildUserContentInjectionWarning(patterns, "project rules");

    const wrapped = wrapUserAuthored("Project Rules", body);

    return "\n\n" + warning + wrapped;
  }

  private reloadFile(): boolean {
    const filePath = this.store.getPath();
    const stat = this.store.statFile(filePath);
    if (!stat) {
      if (this.cachedContent !== "") {
        this.cachedContent = "";
        return true;
      }
      return false;
    }

    if (stat.size > MAX_RULE_FILE_BYTES) {
      this.logger.warn(
        "Rules",
        `File "${filePath}" exceeds ${MAX_RULE_FILE_BYTES / 1024} KB limit (${(stat.size / 1024).toFixed(1)} KB) — skipped.`,
      );
      if (this.cachedContent !== "") { this.cachedContent = ""; return true; }
      return false;
    }
    if (stat.mtimeMs === this.lastLoadedMtime) return false;
    this.lastLoadedMtime = stat.mtimeMs;

    const content = this.store.readFile(filePath);
    this.cachedContent = content ?? "";
    return true;
  }

  private detectDirChanged(files: string[]): boolean {
    const fileListKey = files.join(",");
    if (fileListKey === this.lastFileList) {
      let changed = false;
      for (const file of files) {
        const fp = path.join(this.store.getPath(), file);
        const stat = this.store.statFile(fp);
        const prev = this.lastLoadedMtimes.get(file) ?? 0;
        if (stat && stat.mtimeMs > prev) changed = true;
        if (stat) this.lastLoadedMtimes.set(file, stat.mtimeMs);
      }
      return changed;
    }
    this.lastLoadedMtimes.clear();
    for (const file of files) {
      const fp = path.join(this.store.getPath(), file);
      const stat = this.store.statFile(fp);
      if (stat) this.lastLoadedMtimes.set(file, stat.mtimeMs);
    }
    this.lastFileList = fileListKey;
    return true;
  }

  private readDirFiles(files: string[]): string {
    const sections: string[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const fp = path.join(this.store.getPath(), file);
      const stat = this.store.statFile(fp);
      if (!stat) continue;
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
      const content = this.store.readFile(fp);
      if (content) {
        sections.push(content);
        totalBytes += stat.size;
      }
    }
    return sections.join("\n\n");
  }

  private reloadDir(): boolean {
    const files = this.store.listDir();

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
  }
}
