/**
 * User preferences: key-value pairs of plain-text directives.
 *
 * Keys are short descriptive names (e.g., "code-style", "response-language").
 * Values are natural-language instructions injected into the agent's
 * system prompt so the LLM always sees them.
 *
 * Example:
 * ```ts
 * {
 *   codeStyle: "Use TypeScript with functional style. Prefer interfaces.",
 *   language:  "Always respond in Chinese.",
 * }
 * ```
 */
export type Preferences = Record<string, string>;

/**
 * Configuration for the PreferenceManager.
 */
export interface PreferenceManagerConfig {
  /**
   * Path to the preferences Markdown file.
   * Default: `.kagent/preferences.md` relative to cwd.
   */
  filePath?: string;
}
