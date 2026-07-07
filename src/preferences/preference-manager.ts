import * as fs from "fs";
import * as path from "path";
import { Preferences, PreferenceManagerConfig } from "./types";
import {
  detectInjectionSignatures,
  buildUserContentInjectionWarning,
  wrapUserAuthored,
} from "../security/boundaries";

/**
 * Manages user preferences loaded from a Markdown file.
 *
 * Preferences are stored as `key: value` lines (one per line).
 * Lines starting with `#` are comments, empty lines are ignored.
 * The default path is `.kagent/preferences.md`.
 *
 * Like ProjectRules, preferences are reloaded at the start of each run
 * so manual edits take effect on the next conversation turn.
 */
export class PreferenceManager {
  private filePath: string;
  private lastLoadedMtime: number = 0;
  private cachedContent: string = "";

  constructor(config?: PreferenceManagerConfig) {
    this.filePath = path.resolve(config?.filePath ?? ".kagent/preferences.md");
  }

  /**
   * Whether the file exists on disk.
   */
  get isConfigured(): boolean {
    try {
      fs.statSync(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reload preferences from disk if the file has changed.
   * @returns true if preferences were actually reloaded.
   */
  reloadIfChanged(): boolean {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs === this.lastLoadedMtime && this.cachedContent !== "") {
        // Same mtime — double-check content hasn't changed (handles
        // filesystems with coarse mtime resolution).
        const raw = fs.readFileSync(this.filePath, "utf-8").trim();
        if (raw === this.cachedContent) return false;
        this.lastLoadedMtime = stat.mtimeMs;
        this.cachedContent = raw;
        return true;
      }
      this.lastLoadedMtime = stat.mtimeMs;
      this.cachedContent = fs.readFileSync(this.filePath, "utf-8").trim();
      return true;
    } catch {
      if (this.cachedContent !== "") {
        this.cachedContent = "";
        return true;
      }
      return false;
    }
  }

  /**
   * Build the preferences prompt section for injection into the system prompt.
   * Returns an empty string when preferences are empty.
   */
  buildPrompt(): string {
    if (!this.cachedContent) {
      // Try loading if not yet loaded
      this.reloadIfChanged();
      if (!this.cachedContent) return "";
    }

    const prefs = this.parseContent();
    const entries = Object.entries(prefs);
    if (entries.length === 0) return "";

    const lines = entries.map(([k, v]) => `  - ${k}: ${v}`);
    const body = "=== User Preferences ===\n" + lines.join("\n") + "\n";

    // Scan for prompt-injection signatures
    const patterns = detectInjectionSignatures(body);
    const warning = buildUserContentInjectionWarning(patterns, "user preferences");

    // Wrap in boundaries so the LLM can distinguish user-authored
    // guidance from core system instructions
    const wrapped = wrapUserAuthored("User Preferences", body);

    return "\n\n" + warning + wrapped;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Parse preferences from the cached raw content.
   */
  private parseContent(): Preferences {
    const prefs: Preferences = {};
    for (const line of this.cachedContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx <= 0) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (key) prefs[key] = value;
    }
    return prefs;
  }
}
