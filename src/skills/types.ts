/**
 * A Skill is a reusable capability that can be loaded into the agent's
 * system prompt on demand (progressive disclosure).
 *
 * Each skill carries a system prompt fragment with instructions for the LLM.
 * Activation is LLM-driven — the agent calls the `skill` tool to load a skill
 * when it determines one is needed.
 */
export interface Skill {
  /** Unique identifier for this skill. */
  name: string;

  /** Human-readable description (shown to the LLM or caller). */
  description: string;

  /**
   * System prompt content injected into the agent's system message
   * when this skill is activated.
   */
  systemPrompt?: string;
}

/**
 * Status of a skill within the SkillManager.
 */
export interface SkillStatus {
  name: string;
  description: string;
  active: boolean;
  loadedAt?: Date;
}
