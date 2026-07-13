import {
  detectInjectionSignatures,
  buildUserContentInjectionWarning,
  wrapUserAuthored,
} from "../security/boundaries";
import { Preferences, PreferenceManagerConfig } from "./types";
import { Logger, ConsoleLogger } from "../logging/logger";
import {
  PreferencesStore,
  FileSystemPreferencesStore,
} from "./preferences-store";

/** Maximum file size for preferences (10 KB). */
const MAX_PREFERENCES_BYTES = 10 * 1024;

/**
 * Manages user preferences loaded from a pluggable store.
 *
 * Preferences are stored as `key: value` lines (one per line).
 * Lines starting with `#` are comments, empty lines are ignored.
 *
 * Like ProjectRules, preferences are reloaded at the start of each run
 * so manual edits take effect on the next conversation turn.
 */
export class PreferenceManager {
  private store: PreferencesStore;
  private lastLoadedMtime: number = 0;
  private cachedContent: string = "";
  private logger: Logger;

  constructor(config?: PreferenceManagerConfig, logger?: Logger) {
    this.logger = logger ?? new ConsoleLogger();
    this.store =
      config?.store ??
      new FileSystemPreferencesStore(config?.filePath ?? ".kagent/preferences.md");
  }

  /**
   * Get the underlying storage backend.
   */
  getStore(): PreferencesStore {
    return this.store;
  }

  /**
   * Whether the preferences source is available.
   */
  get isConfigured(): boolean {
    const result = this.store.tryRead();
    return result !== null;
  }

  /**
   * Reload preferences from the store if the source has changed.
   * @returns true if preferences were actually reloaded.
   */
  reloadIfChanged(): boolean {
    const result = this.store.tryRead();
    if (!result) {
      if (this.cachedContent !== "") {
        this.cachedContent = "";
        return true;
      }
      return false;
    }

    // Reject oversized files
    if (result.size > MAX_PREFERENCES_BYTES) {
      this.logger.warn(
        "Preferences",
        `File exceeds ${MAX_PREFERENCES_BYTES / 1024} KB limit (${(result.size / 1024).toFixed(1)} KB) — skipped.`,
      );
      if (this.cachedContent !== "") {
        this.cachedContent = "";
        return true;
      }
      return false;
    }

    if (result.mtimeMs === this.lastLoadedMtime && this.cachedContent !== "") {
      if (result.content === this.cachedContent) return false;
      this.lastLoadedMtime = result.mtimeMs;
      this.cachedContent = result.content;
      return true;
    }
    this.lastLoadedMtime = result.mtimeMs;
    this.cachedContent = result.content;
    return true;
  }

  /**
   * Build the preferences prompt section for injection into the system prompt.
   */
  buildPrompt(): string {
    if (!this.cachedContent) {
      this.reloadIfChanged();
      if (!this.cachedContent) return "";
    }

    const prefs = this.parseContent();
    const entries = Object.entries(prefs);
    if (entries.length === 0) return "";

    const lines = entries.map(([k, v]) => `  - ${k}: ${v}`);
    const body = "=== User Preferences ===\n" + lines.join("\n") + "\n";

    const patterns = detectInjectionSignatures(body);
    const warning = buildUserContentInjectionWarning(patterns, "user preferences");

    const wrapped = wrapUserAuthored("User Preferences", body);

    return "\n\n" + warning + wrapped;
  }

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
