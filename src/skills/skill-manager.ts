import { Skill, SkillStatus } from "./types";
import { FileSkillLoader } from "./file-skill-loader";

/**
 * Manages skill registration, activation, and progressive disclosure.
 *
 * Skills are lightweight domain-specific capabilities that can be
 * loaded into the agent's system prompt on demand. This keeps the
 * core system prompt small while allowing deep expertise to be
 * injected when needed.
 *
 * Workflow:
 * 1. Skills are registered from a directory (metadata only: name, description, keywords)
 * 2. `buildAvailableSkillsHint()` lists all available skills in the system prompt
 * 3. LLM decides which skill to use → `activate(name)` loads the full content
 * 4. `buildSkillsPrompt()` includes the active skill's full system prompt
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

  // ─── Registration ────────────────────────────────────────────────────

  /**
   * Register a skill object directly (programmatic registration).
   * Used when skills are defined in code rather than loaded from disk.
   */
  register(skill: Skill): void {
    if (this.registry.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" is already registered.`);
    }
    this.registry.set(skill.name, skill);
  }

  /**
   * Unregister a skill by name. Deactivates it first if active.
   */
  unregister(name: string): boolean {
    if (this.activeSkills.has(name)) {
      this.deactivate(name);
    }
    this.fileLoaders.delete(name);
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
   * Re-scan the skills directory for new SKILL.md files.
   *
   * Safe to call at the start of each run — only registers skills that
   * haven't been registered yet. Already-registered skills are left as-is.
   *
   * @param dir Path to the skills directory.
   * @returns Names of newly registered skills (empty if nothing changed).
   */
  reloadFromDirectory(dir: string): string[] {
    const before = new Set(this.registry.keys());
    this.registerFromDirectory(dir);
    const after = new Set(this.registry.keys());
    const added: string[] = [];
    for (const name of after) {
      if (!before.has(name)) added.push(name);
    }
    if (added.length > 0) {
      console.log(`[Skills] Picked up ${added.length} new skill(s): ${added.join(", ")}`);
    }
    return added;
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
   * - Lazy-loads the full system prompt from disk (if file-based).
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

    // Lazy-load file-based skills: populate systemPrompt from disk
    const loader = this.fileLoaders.get(name);
    if (loader && !this.loadedFileSkills.has(name)) {
      try {
        skill.systemPrompt = loader.loadSystemPrompt(name);
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
   */
  deactivate(name: string): boolean {
    const skill = this.activeSkills.get(name);
    if (!skill) return false;

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
      sections.push(`[Skill: ${skill.name}]\n${skill.systemPrompt ?? ""}`);
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
      "\n\nAvailable skills (use the `skill` tool to activate them when needed):\n" +
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
