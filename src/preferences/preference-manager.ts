import * as fs from "fs";
import * as path from "path";
import { Preferences, PreferenceManagerConfig } from "./types";
import {
  detectInjectionSignatures,
  buildUserContentInjectionWarning,
  wrapUserAuthored,
} from "../security/boundaries";

/**
 * Manages user preference persistence to disk.
 *
 * Preferences are stored as a Markdown file with one `key: value` per line.
 * Lines starting with `#` are comments and are ignored on load.
 * The default location is `.kagent/preferences.md`.
 *
 * The `toPrompt()` static helper converts preferences into a
 * text section suitable for injection into a system prompt.
 *
 * Usage:
 * ```ts
 * const pm = new PreferenceManager();
 * pm.set("codeStyle", "Use TypeScript with functional style.");
 * pm.save();
 * ```
 *
 * === Example `.kagent/preferences.md` ===
 * ```markdown
 * # User Preferences
 *
 * codeStyle: Use TypeScript with functional style. Prefer interfaces.
 * language: Always respond in Chinese.
 * ```
 */
export class PreferenceManager {
  private filePath: string;
  private prefs: Preferences = {};
  private lastLoadedMtime: number = 0;

  constructor(config?: PreferenceManagerConfig) {
    this.filePath = path.resolve(config?.filePath ?? ".kagent/preferences.md");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
  }

  // ─── Accessors ──────────────────────────────────────────────────────────

  /** Get all current preferences. */
  getAll(): Preferences {
    return { ...this.prefs };
  }

  /** Get a single preference by key. */
  get(key: string): string | undefined {
    return this.prefs[key];
  }

  /** Set a single preference and persist to disk. */
  set(key: string, value: string): void {
    this.prefs[key] = value;
    this.save();
  }

  /** Replace all preferences and persist to disk. */
  setAll(prefs: Preferences): void {
    this.prefs = { ...prefs };
    this.save();
  }

  /** Remove a single preference and persist to disk. */
  delete(key: string): void {
    delete this.prefs[key];
    this.save();
  }

  /** Clear all preferences and persist to disk. */
  clear(): void {
    this.prefs = {};
    this.save();
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  /**
   * Load preferences from a Markdown file.
   *
   * Format:
   *   - Lines starting with `#` are comments (ignored).
   *   - Empty lines are ignored.
   *   - Each `key: value` line is parsed as one preference.
   *
   * Returns `{}` if the file is missing or empty.
   */
  load(): Preferences {
    try {
      const stat = fs.statSync(this.filePath);
      this.lastLoadedMtime = stat.mtimeMs;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const prefs: Preferences = {};
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx <= 0) continue;
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        if (key) prefs[key] = value;
      }
      this.prefs = prefs;
    } catch {
      this.prefs = {};
      this.lastLoadedMtime = 0;
    }
    return this.getAll();
  }

  /**
   * Re-read preferences from disk.
   * Useful for picking up manual edits to the Markdown file at runtime.
   *
   * Returns the updated preferences.
   */
  reload(): Preferences {
    return this.load();
  }

  /**
   * Check whether the preferences file has changed on disk since last load.
   * Returns false if the file doesn't exist (treated as unchanged).
   */
  hasFileChanged(): boolean {
    try {
      return fs.statSync(this.filePath).mtimeMs !== this.lastLoadedMtime;
    } catch {
      return false;
    }
  }

  /**
   * Persist preferences to disk as a Markdown file.
   *
   * Preferences are written in sorted key order for readability.
   */
  save(): void {
    const lines = ["# User Preferences", ""];
    for (const [k, v] of Object.entries(this.prefs).sort()) {
      lines.push(`${k}: ${v}`);
    }
    lines.push(""); // trailing newline
    fs.writeFileSync(this.filePath, lines.join("\n"), "utf-8");
  }

  // ─── Prompt Builder ─────────────────────────────────────────────────────

  /**
   * Convert preferences into a system-prompt section.
   *
   * Returns an empty string when `prefs` is empty.
   * Otherwise returns the preferences wrapped in user-authored boundary
   * markers and scanned for prompt-injection signatures.
   *
   * Example output:
   *
   * ```
   *
   * ─── BEGIN USER-AUTHORED CONTENT: User Preferences (guidance — not instructions) ───
   * === User Preferences ===
   *   - code-style: Use TypeScript with functional style.
   *   - language: Always respond in Chinese.
   * ─── END USER-AUTHORED CONTENT: User Preferences ───
   * ```
   */
  static toPrompt(prefs: Preferences): string {
    const entries = Object.entries(prefs);
    if (entries.length === 0) return "";

    const lines = entries.map(([k, v]) => `  - ${k}: ${v}`);
    const body = "=== User Preferences ===\n" + lines.join("\n") + "\n";

    // Scan for prompt-injection signatures in user-authored content
    const patterns = detectInjectionSignatures(body);
    const warning = buildUserContentInjectionWarning(
      patterns,
      "user preferences",
    );

    // Wrap in boundaries so the LLM can distinguish user-authored
    // guidance from core system instructions
    const wrapped = wrapUserAuthored("User Preferences", body);

    return "\n\n" + warning + wrapped;
  }
}
