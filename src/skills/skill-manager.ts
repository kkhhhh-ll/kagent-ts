import { Skill, SkillStatus } from "./types";
import { FileSkillLoader } from "./file-skill-loader";
import { ToolRegistry } from "../tools/tool-registry";

/**
 * Manages skill registration, activation, and progressive disclosure.
 *
 * Skills are lightweight domain-specific capabilities that can be
 * loaded into the agent's system prompt on demand. This keeps the
 * core system prompt small while allowing deep expertise to be
 * injected when needed.
 *
 * Activation strategies:
 * 1. Keyword auto-detection — skills define keywords; user input
 *    that matches triggers activation.
 * 2. Manual activation — call `activate(name)` explicitly.
 */
export class SkillManager {
  /** All registered skills (active or not), keyed by name. */
  private registry: Map<string, Skill> = new Map();

  /** Skills that are currently active. */
  private activeSkills: Map<string, Skill> = new Map();

  /** Timestamps for when each skill was activated. */
  private activatedAt: Map<string, Date> = new Map();

  /** FileSkillLoaders for file-based skills, keyed by skill name. */
  private fileLoaders: Map<string, FileSkillLoader> = new Map();

  /** File-based skills whose full content has been loaded from disk. */
  private loadedFileSkills: Set<string> = new Set();

  /** Reference to the ToolRegistry for registering/unregistering skill tools. */
  private toolRegistry?: ToolRegistry;

  /**
   * @param toolRegistry Optional ToolRegistry — skills with tools
   *                     will auto-register/unregister there.
   */
  constructor(toolRegistry?: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Bind a ToolRegistry so skill tools are managed automatically.
   */
  bindToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  // ─── Registration ────────────────────────────────────────────────────

  /**
   * Register one or more skills.
   */
  register(...skills: Skill[]): void {
    for (const skill of skills) {
      if (this.registry.has(skill.name)) {
        throw new Error(`Skill "${skill.name}" is already registered.`);
      }
      this.registry.set(skill.name, skill);
    }
  }

  /**
   * Unregister a skill by name. Deactivates it first if active.
   */
  unregister(name: string): boolean {
    if (this.activeSkills.has(name)) {
      this.deactivate(name);
    }
    return this.registry.delete(name);
  }

  /**
   * Register skills from a directory of SKILL.md files.
   *
   * Scans the directory, reads frontmatter from each SKILL.md, and
   * registers metadata-only Skill objects. Full content (system prompt,
   * reference docs, scripts) is loaded lazily on activation.
   *
   * @param dir Path to the skills directory.
   * @returns Number of skills successfully registered.
   */
  registerFromDirectory(dir: string): number {
    const loader = new FileSkillLoader(dir);
    const scanned = loader.scan();
    let count = 0;

    for (const skill of scanned) {
      if (this.registry.has(skill.name)) {
        console.warn(
          `[Skills] Skipping "${skill.name}": already registered (duplicate name).`,
        );
        continue;
      }
      this.registry.set(skill.name, skill);
      this.fileLoaders.set(skill.name, loader);
      count++;
    }

    if (count > 0) {
      console.log(
        `[Skills] Registered ${count} file-based skill(s) from ${dir}` +
          (scanned.length !== count
            ? ` (${scanned.length - count} skipped)`
            : ""),
      );
    }

    return count;
  }

  /**
   * Check if a skill is registered.
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Get a registered skill by name.
   */
  get(name: string): Skill | undefined {
    return this.registry.get(name);
  }

  /**
   * Get all registered skills.
   */
  getAll(): Skill[] {
    return Array.from(this.registry.values());
  }

  // ─── Activation / Deactivation ───────────────────────────────────────

  /**
   * Activate a skill by name.
   * - Appends its system prompt to the accumulated skill context.
   * - Registers its tools (if a ToolRegistry is bound).
   * - Returns true if the skill was newly activated.
   */
  activate(name: string): boolean {
    const skill = this.registry.get(name);
    if (!skill) {
      throw new Error(
        `Unknown skill: "${name}". Available: ${Array.from(this.registry.keys()).join(", ")}`,
      );
    }
    if (this.activeSkills.has(name)) {
      return false; // Already active
    }

    // Lazy-load file-based skills: populate systemPrompt and tools from disk
    const loader = this.fileLoaders.get(name);
    if (loader && !this.loadedFileSkills.has(name)) {
      try {
        skill.systemPrompt = loader.loadSystemPrompt(name);
        skill.tools = loader.loadScriptsAsTools(name);
        this.loadedFileSkills.add(name);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to load skill "${name}" from disk: ${message}`,
        );
      }
    }

    this.activeSkills.set(name, skill);
    this.activatedAt.set(name, new Date());

    // Register skill tools if we have a registry
    if (this.toolRegistry && skill.tools) {
      for (const tool of skill.tools) {
        try {
          this.toolRegistry.register(tool);
        } catch {
          // Tool already registered — skip
        }
      }
    }

    return true;
  }

  /**
   * Activate multiple skills at once.
   */
  activateMany(names: string[]): string[] {
    const activated: string[] = [];
    for (const name of names) {
      try {
        if (this.activate(name)) {
          activated.push(name);
        }
      } catch {
        // Skip unknown skills
      }
    }
    return activated;
  }

  /**
   * Deactivate a skill.
   * - Unregisters its tools (if a ToolRegistry is bound).
   */
  deactivate(name: string): boolean {
    const skill = this.activeSkills.get(name);
    if (!skill) return false;

    // Unregister skill tools
    if (this.toolRegistry && skill.tools) {
      for (const tool of skill.tools) {
        this.toolRegistry.remove(tool.name);
      }
    }

    this.activeSkills.delete(name);
    this.activatedAt.delete(name);
    // Allow re-activation to reload from disk if the skill files changed
    this.loadedFileSkills.delete(name);
    return true;
  }

  /**
   * Deactivate all active skills.
   */
  deactivateAll(): void {
    const names = Array.from(this.activeSkills.keys());
    for (const name of names) {
      this.deactivate(name);
    }
  }

  // ─── Auto-Detection ──────────────────────────────────────────────────

  /**
   * Scan user input against unregistered (not yet active) skills.
   * Activates any skill whose keywords match the input.
   *
   * @param input The user's input text.
   * @returns Names of newly activated skills.
   */
  detectAndActivate(input: string): string[] {
    const lowerInput = input.toLowerCase();
    const activated: string[] = [];

    for (const skill of this.registry.values()) {
      // Skip already-active skills
      if (this.activeSkills.has(skill.name)) continue;

      // Skip skills without keywords
      if (!skill.keywords || skill.keywords.length === 0) continue;

      // Check each keyword
      for (const keyword of skill.keywords) {
        if (lowerInput.includes(keyword.toLowerCase())) {
          if (this.activate(skill.name)) {
            activated.push(skill.name);
          }
          break; // One match is enough per skill
        }
      }
    }

    return activated;
  }

  // ─── System Prompt Assembly ──────────────────────────────────────────

  /**
   * Build the accumulated system prompt content from all active skills.
   * Each skill's prompt is wrapped in a named section for clarity.
   *
   * Returns an empty string if no skills are active.
   */
  buildSkillsPrompt(): string {
    const active = Array.from(this.activeSkills.values());
    if (active.length === 0) return "";

    const sections: string[] = [];
    for (const skill of active) {
      sections.push(`[Skill: ${skill.name}]\n${skill.systemPrompt}`);
    }
    return "\n\n" + sections.join("\n\n");
  }

  /**
   * Build a lightweight list of available (unactivated) skill names
   * for inclusion in the system prompt.
   *
   * This is what "progressive disclosure" means — the agent sees
   * the names up front but the full instructions only load on activation.
   */
  buildAvailableSkillsHint(): string {
    const available: string[] = [];
    for (const skill of this.registry.values()) {
      if (!this.activeSkills.has(skill.name)) {
        available.push(`${skill.name}: ${skill.description}`);
      }
    }
    if (available.length === 0) return "";
    return (
      "\n\nAvailable skills (they activate automatically when needed, or you can explicitly request one):\n" +
      available.map((line) => `  - ${line}`).join("\n")
    );
  }

  // ─── Query ───────────────────────────────────────────────────────────

  /**
   * Check if a skill is currently active.
   */
  isActive(name: string): boolean {
    return this.activeSkills.has(name);
  }

  /**
   * Get names of all currently active skills.
   */
  getActiveSkillNames(): string[] {
    return Array.from(this.activeSkills.keys());
  }

  /**
   * Get the total number of registered skills (active or inactive).
   */
  get count(): number {
    return this.registry.size;
  }

  /**
   * Get the number of active skills.
   */
  get activeCount(): number {
    return this.activeSkills.size;
  }

  /**
   * Get status for all registered skills.
   */
  getAllStatus(): SkillStatus[] {
    return Array.from(this.registry.values()).map((skill) => {
      const active = this.activeSkills.has(skill.name);
      return {
        name: skill.name,
        description: skill.description,
        active,
        loadedAt: this.activatedAt.get(skill.name),
      };
    });
  }

  /**
   * Get status for all active skills.
   */
  getActiveStatus(): SkillStatus[] {
    return this.getAllStatus().filter((s) => s.active);
  }
}
